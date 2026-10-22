// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { LanguageModelV2 } from '@ai-sdk/provider';
import {
    LanguageModel,
    LanguageModelMessage,
    LanguageModelParsedResponse,
    LanguageModelRequest,
    LanguageModelResponse,
    LanguageModelStatus,
    LanguageModelStreamResponse,
    LanguageModelStreamResponsePart,
    LanguageModelTextResponse,
    ToolCall,
    ToolCallResult,
    UserRequest,
    createToolCallError,
} from '@theia/ai-core';
import { CancellationToken, Disposable, ILogger } from '@theia/core';
import {
    ModelMessage,
    generateObject,
    generateText,
    jsonSchema,
    streamText,
    TextStreamPart,
    tool,
    ToolSet,
    stepCountIs
} from 'ai';
import { VercelAiLanguageModelFactory, VercelAiProviderConfig } from './vercel-ai-language-model-factory';

function toolErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return typeof error === 'string' && error.trim() ? error : 'Tool execution failed. Please retry.';
}

interface VercelCancellationToken extends Disposable {
    signal: AbortSignal;
    cancellationToken: CancellationToken;
    isCancellationRequested: boolean;
}

interface VercelAiStream extends AsyncIterable<TextStreamPart<ToolSet>> {
    cancel: () => void;
}

interface StreamContext {
    logger: ILogger;
    cancellationToken?: VercelCancellationToken;
}

export class VercelAiStreamTransformer {
    private toolCallsMap = new Map<string, ToolCall>();

    constructor(
        protected readonly fullStream: VercelAiStream,
        protected readonly context: StreamContext
    ) { }

    async *transform(): AsyncGenerator<LanguageModelStreamResponsePart> {
        this.toolCallsMap.clear();
        let aborted = false;
        try {
            for await (const part of this.fullStream) {
                this.context.logger.trace('Received stream part:', part);
                if (this.context.cancellationToken?.isCancellationRequested) {
                    this.context.logger.debug('Cancellation requested, stopping stream');
                    await this.fullStream.cancel();
                    break;
                }
                if (part.type === 'abort') {
                    aborted = true;
                    break;
                }

                let toolCallUpdated = false;

                switch (part.type) {
                    case 'error':
                        throw part.error;

                    case 'text-delta':
                        if (part.text) {
                            yield { content: part.text };
                        }
                        break;

                    case 'tool-call':
                        if (part.toolCallId && part.toolName) {
                            const args = typeof part.input === 'object' ? JSON.stringify(part.input) : (part.input || '');
                            toolCallUpdated = this.updateToolCall(part.toolCallId, part.toolName, args);
                        }
                        break;

                    case 'tool-input-start':
                        if (part.id && part.toolName) {
                            toolCallUpdated = this.updateToolCall(part.id, part.toolName);
                        }
                        break;

                    case 'tool-input-delta':
                        if (part.id && part.delta) {
                            toolCallUpdated = this.appendToToolCallArgs(part.id, part.delta);
                        }
                        break;

                    case 'tool-result':
                        toolCallUpdated = this.finishToolCall(part.toolCallId,
                            typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
                            part.toolName, !part.preliminary);
                        break;

                    case 'tool-error':
                        toolCallUpdated = this.finishToolCall(part.toolCallId,
                            createToolCallError(toolErrorMessage(part.error)), part.toolName);
                        break;

                    case 'finish-step': {
                        const { usage } = part;
                        if (usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
                            yield { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };
                        }
                        break;
                    }
                }

                if (toolCallUpdated && this.toolCallsMap.size > 0) {
                    yield { tool_calls: Array.from(this.toolCallsMap.values()) };
                }
            }
        } catch (error) {
            const canceled = this.context.cancellationToken?.isCancellationRequested;
            if (this.finishPendingToolCalls(canceled ? 'Tool execution canceled.' : 'Tool execution interrupted. Please retry.')) {
                yield { tool_calls: Array.from(this.toolCallsMap.values()) };
            }
            if (!canceled) {
                this.context.logger.error('Error in AI SDK stream:', error);
                throw error;
            }
            return;
        }
        if (this.finishPendingToolCalls(aborted || this.context.cancellationToken?.isCancellationRequested
            ? 'Tool execution canceled.' : 'Tool execution interrupted before returning a result. Please retry.')) {
            yield { tool_calls: Array.from(this.toolCallsMap.values()) };
        }
    }

    private updateToolCall(id: string, name: string, args?: string): boolean {
        const toolCall: ToolCall = {
            id,
            function: { name, arguments: args ? args : '' },
            finished: false
        };
        this.toolCallsMap.set(id, toolCall);
        return true;
    }

    private appendToToolCallArgs(id: string, argsTextDelta: string): boolean {
        const existingCall = this.toolCallsMap.get(id);
        if (existingCall?.function) {
            this.toolCallsMap.set(id, {
                ...existingCall,
                function: { ...existingCall.function, arguments: (existingCall.function.arguments || '') + argsTextDelta }
            });
            return true;
        }
        return false;
    }

    private finishToolCall(id: string, result: ToolCallResult, name?: string, finished = true): boolean {
        if (!id) {
            return false;
        }
        const existingCall = this.toolCallsMap.get(id);
        this.toolCallsMap.set(id, {
            ...existingCall,
            id,
            function: existingCall?.function ?? { name, arguments: '' },
            result,
            finished
        });
        return true;
    }

    private finishPendingToolCalls(message: string): boolean {
        let updated = false;
        for (const [id, call] of this.toolCallsMap) {
            if (!call.finished) {
                this.finishToolCall(id, createToolCallError(message));
                updated = true;
            }
        }
        return updated;
    }

}

export class VercelAiModel implements LanguageModel {

    constructor(
        public readonly id: string,
        public model: string,
        public status: LanguageModelStatus,
        public enableStreaming: boolean,
        public supportsStructuredOutput: boolean,
        public url: string | undefined,
        protected readonly logger: ILogger,
        protected readonly languageModelFactory: VercelAiLanguageModelFactory,
        protected providerConfig: () => VercelAiProviderConfig,
        public maxRetries: number = 3,
    ) { }

    protected getSettings(request: LanguageModelRequest): Record<string, unknown> {
        const settings = { ...request.settings };
        if (settings.maxOutputTokens === undefined && typeof settings.maxTokens === 'number') {
            settings.maxOutputTokens = settings.maxTokens;
        }
        delete settings.maxTokens;
        return settings;
    }

    async request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const settings = this.getSettings(request);
        const model = this.languageModelFactory.createLanguageModel(
            {
                id: this.id,
                model: this.model,
                url: this.url,
                apiKey: true, // We'll use the provider's API key
                enableStreaming: this.enableStreaming,
                supportsStructuredOutput: this.supportsStructuredOutput,
                maxRetries: this.maxRetries
            },
            this.providerConfig()
        );
        const cancel = this.createCancellationToken(cancellationToken);
        let streamOwnsCancellation = false;

        try {
            if (request.response_format?.type === 'json_schema' && this.supportsStructuredOutput) {
                return await this.handleStructuredOutputRequest(model, request, cancel);
            }
            if (!this.enableStreaming || (typeof settings.stream === 'boolean' && !settings.stream)) {
                return await this.handleNonStreamingRequest(model, request, cancel);
            }
            const response = await this.handleStreamingRequest(model, request, cancel);
            streamOwnsCancellation = true;
            return response;
        } catch (error) {
            this.logger.error('Error in Vercel AI model request:', error);
            throw error;
        } finally {
            if (!streamOwnsCancellation) cancel.dispose();
        }
    }

    protected createCancellationToken(cancellationToken?: CancellationToken): VercelCancellationToken {
        const abortController = new AbortController();
        const abortSignal = abortController.signal;
        if (cancellationToken?.isCancellationRequested) {
            abortController.abort();
        }
        const cancellationListener = cancellationToken ?
            cancellationToken.onCancellationRequested(() => {
                abortController.abort();
            }) : undefined;
        return {
            signal: abortSignal,
            cancellationToken: cancellationToken ?? CancellationToken.None,
            get isCancellationRequested(): boolean {
                return cancellationToken?.isCancellationRequested ?? abortSignal.aborted;
            },
            dispose: () => cancellationListener?.dispose()
        };
    }

    protected async handleNonStreamingRequest(
        model: LanguageModelV2,
        request: UserRequest,
        cancellationToken?: VercelCancellationToken
    ): Promise<LanguageModelTextResponse> {
        const settings = this.getSettings(request);
        const messages = this.processMessages(request.messages);
        const tools = this.createTools(request);
        const abortSignal = cancellationToken?.signal;

        const response = await generateText({
            model,
            messages,
            tools,
            toolChoice: 'auto',
            abortSignal,
            ...settings
        });

        const result: LanguageModelTextResponse = { text: response.text };
        if (typeof response.usage.outputTokens === 'number' && typeof response.usage.inputTokens === 'number') {
            result.usage = {
                input_tokens: response.usage.inputTokens,
                output_tokens: response.usage.outputTokens,
            };
        }
        return result;
    }

    protected createTools(request: UserRequest): ToolSet | undefined {
        if (!request.tools) {
            return undefined;
        }

        const toolSet: ToolSet = {};
        for (const toolRequest of request.tools) {
            toolSet[toolRequest.name] = tool({
                description: toolRequest.description,
                inputSchema: jsonSchema(toolRequest.parameters),
                execute: async (args, options) => {
                    try {
                        const result = await toolRequest.handler(JSON.stringify(args ?? {}), options);
                        return JSON.stringify(result);
                    } catch (error) {
                        this.logger.error(`Error executing tool (${toolRequest.name}):`, error);
                        return createToolCallError(options.abortSignal?.aborted ? 'Tool execution canceled.' : toolErrorMessage(error));
                    }
                }
            });
        }
        return toolSet;
    }

    protected async handleStructuredOutputRequest(
        model: LanguageModelV2,
        request: UserRequest,
        cancellationToken?: VercelCancellationToken
    ): Promise<LanguageModelParsedResponse | LanguageModelStreamResponse> {
        if (request.response_format?.type !== 'json_schema' || !request.response_format.json_schema.schema) {
            throw Error('Invalid response format for structured output request');
        }

        const schema = jsonSchema(request.response_format.json_schema.schema);
        if (!schema) {
            throw new Error('Schema extraction failed.');
        }

        const settings = this.getSettings(request);
        const messages = this.processMessages(request.messages);
        const abortSignal = cancellationToken?.signal;

        const response = await generateObject({
            model,
            output: 'object',
            messages,
            schema,
            abortSignal,
            ...settings
        });

        const result: LanguageModelParsedResponse = {
            content: JSON.stringify(response.object),
            parsed: response.object
        };
        if (typeof response.usage.outputTokens === 'number' && typeof response.usage.inputTokens === 'number') {
            result.usage = {
                input_tokens: response.usage.inputTokens,
                output_tokens: response.usage.outputTokens,
            };
        }
        return result;
    }

    protected async handleStreamingRequest(
        model: LanguageModelV2,
        request: UserRequest,
        cancellationToken?: VercelCancellationToken
    ): Promise<LanguageModelStreamResponse> {
        const settings = this.getSettings(request);
        const messages = this.processMessages(request.messages);
        const tools = this.createTools(request);
        const abortSignal = cancellationToken?.signal;

        const { fullStream } = streamText({
            model,
            messages,
            tools,
            toolChoice: 'auto',
            stopWhen: stepCountIs(100),
            maxRetries: this.maxRetries,
            abortSignal,
            ...settings
        });

        const transformer = new VercelAiStreamTransformer(
            fullStream, { cancellationToken, logger: this.logger }
        );

        return {
            stream: (async function* () {
                try { yield* transformer.transform(); }
                finally { cancellationToken?.dispose(); }
            })()
        };
    }

    protected processMessages(messages: LanguageModelMessage[]): Array<ModelMessage> {
        const converted = messages.map(message => {
            const content = LanguageModelMessage.isTextMessage(message) ? message.text : '';
            let role: 'user' | 'assistant' | 'system';
            switch (message.actor) {
                case 'user':
                    role = 'user';
                    break;
                case 'ai':
                    role = 'assistant';
                    break;
                case 'system':
                    role = 'system';
                    break;
                default:
                    role = 'user';
            }
            return {
                role,
                content,
            };
        });
        return this.mergeConsecutiveAssistantMessages(converted);
    }

    protected mergeConsecutiveAssistantMessages(messages: Array<ModelMessage>): Array<ModelMessage> {
        const result: Array<ModelMessage> = [];
        for (const message of messages) {
            const previous = result[result.length - 1];
            if (previous?.role === 'assistant' && message.role === 'assistant') {
                const merged: ModelMessage = { ...previous, role: 'assistant' };

                const previousContent = typeof previous.content === 'string' ? previous.content : undefined;
                const nextContent = typeof message.content === 'string' ? message.content : undefined;
                if (previousContent && nextContent) {
                    merged.content = `${previousContent}\n${nextContent}`;
                } else if (nextContent) {
                    merged.content = nextContent;
                } else if (previousContent) {
                    merged.content = previousContent;
                }

                result[result.length - 1] = merged;
            } else {
                result.push(message);
            }
        }
        return result;
    }
}
