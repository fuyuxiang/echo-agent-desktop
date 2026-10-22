// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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

import { expect } from 'chai';
import { MockLogger } from '@theia/core/lib/common/test/mock-logger';
import { hasToolCallError, isLanguageModelStreamResponse, LanguageModelMessage, LanguageModelStreamResponsePart, ToolCall, UserRequest } from '@theia/ai-core';
import { ModelMessage, TextStreamPart, ToolSet } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV2 } from 'ai/test';
import { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { VercelAiModel, VercelAiStreamTransformer } from './vercel-ai-language-model';
import { VercelAiLanguageModelFactory } from './vercel-ai-language-model-factory';

class TestableVercelAiModel extends VercelAiModel {
    constructor(factory = new VercelAiLanguageModelFactory()) {
        super(
            'test-id',
            'test-model',
            { status: 'ready' },
            true,
            false,
            undefined,
            new MockLogger(),
            factory,
            () => ({ provider: 'openai', apiKey: 'k' })
        );
    }

    public callProcessMessages(messages: LanguageModelMessage[]): Array<ModelMessage> {
        return this.processMessages(messages);
    }
}

describe('VercelAiModel - processMessages', () => {
    const model = new TestableVercelAiModel();

    it('should merge consecutive assistant text messages with a newline separator', () => {
        const messages: LanguageModelMessage[] = [
            { actor: 'user', type: 'text', text: 'q' },
            { actor: 'ai', type: 'text', text: 'part one' },
            { actor: 'ai', type: 'text', text: 'part two' }
        ];
        const result = model.callProcessMessages(messages);
        expect(result).to.deep.equal([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'part one\npart two' }
        ]);
    });

    it('should leave alternating user/assistant messages unchanged', () => {
        const messages: LanguageModelMessage[] = [
            { actor: 'user', type: 'text', text: 'q1' },
            { actor: 'ai', type: 'text', text: 'a1' },
            { actor: 'user', type: 'text', text: 'q2' },
            { actor: 'ai', type: 'text', text: 'a2' }
        ];
        const result = model.callProcessMessages(messages);
        expect(result).to.deep.equal([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
    });

    it('should reproduce the bug scenario from issue #17104 (consecutive ai messages)', () => {
        const messages: LanguageModelMessage[] = [
            { actor: 'user', type: 'text', text: 'first request' },
            { actor: 'ai', type: 'text', text: 'reasoning' },
            { actor: 'ai', type: 'text', text: 'final answer' }
        ];
        const result = model.callProcessMessages(messages);
        for (let i = 1; i < result.length; i++) {
            expect(result[i - 1].role === 'assistant' && result[i].role === 'assistant').to.equal(false);
        }
        expect(result).to.have.lengthOf(2);
        expect(result[1]).to.deep.equal({ role: 'assistant', content: 'reasoning\nfinal answer' });
    });
});


describe('Vercel AI SDK 5 stream compatibility', () => {
    function stream(parts: unknown[]) {
        return Object.assign((async function* () {
            for (const part of parts) yield part as TextStreamPart<ToolSet>;
        })(), { cancel: () => undefined });
    }

    it('preserves text, tool input, results and token accounting', async () => {
        const transformer = new VercelAiStreamTransformer(stream([
            { type: 'text-delta', text: '你好' },
            { type: 'tool-input-start', id: 'call-1', toolName: 'lookup' },
            { type: 'tool-input-delta', id: 'call-1', delta: '{"q":"hello"}' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { q: 'hello' } },
            { type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: 'found' },
            { type: 'finish-step', usage: { inputTokens: 7, outputTokens: 3 } }
        ]), { logger: new MockLogger() });
        const parts = [];
        for await (const part of transformer.transform()) parts.push(part);
        expect(parts[0]).to.deep.equal({ content: '你好' });
        expect(parts[parts.length - 1]).to.deep.equal({ input_tokens: 7, output_tokens: 3 });
        expect(parts.some(part => 'tool_calls' in part && part.tool_calls?.some(call =>
            call.function?.arguments === '{"q":"hello"}' && call.result === 'found' && call.finished))).to.equal(true);
    });

    it('propagates provider errors so the UI can report a failed request', async () => {
        const transformer = new VercelAiStreamTransformer(stream([
            { type: 'error', error: new Error('provider offline') }
        ]), { logger: new MockLogger() });
        let failure: unknown;
        try { for await (const _part of transformer.transform()) { /* drain */ } }
        catch (error) { failure = error; }
        expect(failure).to.be.instanceOf(Error);
        expect((failure as Error).message).to.equal('provider offline');
    });

    it('finishes tool errors while preserving the earlier argument snapshots and subsequent text', async () => {
        const transformer = new VercelAiStreamTransformer(stream([
            { type: 'tool-input-start', id: 'call-1', toolName: 'lookup' },
            { type: 'tool-input-delta', id: 'call-1', delta: '{bad' },
            { type: 'tool-error', toolCallId: 'call-1', toolName: 'lookup', error: new Error('Invalid tool input') },
            { type: 'text-delta', text: 'Please retry.' }
        ]), { logger: new MockLogger() });
        const parts: LanguageModelStreamResponsePart[] = [];
        for await (const part of transformer.transform()) parts.push(part);
        const updates = parts.filter(part => 'tool_calls' in part).map(part => part.tool_calls[0]);
        expect(updates[0].function?.arguments).to.equal('');
        expect(updates[0].finished).to.equal(false);
        expect(updates[1].function?.arguments).to.equal('{bad');
        expect(updates[1].finished).to.equal(false);
        expect(updates[2].finished).to.equal(true);
        expect(hasToolCallError(updates[2].result)).to.equal(true);
        expect(JSON.stringify(updates[2].result)).to.contain('Invalid tool input');
        expect(parts[parts.length - 1]).to.deep.equal({ content: 'Please retry.' });
    });

    for (const ending of ['abort', 'end', 'error']) {
        it(`settles unfinished tools on ${ending} without changing completed results`, async () => {
            const transformer = new VercelAiStreamTransformer(stream([
                { type: 'tool-call', toolCallId: 'done', toolName: 'lookup', input: {} },
                { type: 'tool-result', toolCallId: 'done', toolName: 'lookup', output: 'saved result' },
                { type: 'tool-input-start', id: 'pending', toolName: 'lookup' },
                ...(ending === 'end' ? [] : ending === 'abort' ? [{ type: 'abort' }, { type: 'text-delta', text: 'late text' }]
                    : [{ type: 'error', error: new Error('offline') }])
            ]), { logger: new MockLogger() });
            let calls: ToolCall[] = [];
            const text: string[] = [];
            let failure: unknown;
            try {
                for await (const part of transformer.transform()) {
                    if ('tool_calls' in part) calls = part.tool_calls;
                    if ('content' in part) text.push(part.content);
                }
            } catch (error) { failure = error; }
            expect(calls.every(call => call.finished)).to.equal(true);
            expect(text).to.deep.equal([]);
            expect(calls[0].result).to.equal('saved result');
            expect(hasToolCallError(calls[1].result)).to.equal(true);
            expect(JSON.stringify(calls[1].result)).to.contain(ending === 'abort' ? 'canceled' : 'interrupted');
            if (ending === 'error') expect((failure as Error).message).to.equal('offline');
            else expect(failure).to.equal(undefined);
        });
    }

    it('keeps preliminary tool results pending until the final result', async () => {
        const transformer = new VercelAiStreamTransformer(stream([
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: {} },
            { type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: 'working', preliminary: true },
            { type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: 'done' }
        ]), { logger: new MockLogger() });
        const updates: ToolCall[] = [];
        for await (const part of transformer.transform()) if ('tool_calls' in part) updates.push(part.tool_calls[0]);
        expect(updates.map(call => call.finished)).to.deep.equal([false, false, true]);
        expect(updates[2].result).to.equal('done');
    });

    for (const scenario of ['invalid JSON', 'unknown tool', 'handler failure', 'success']) {
        it(`handles ${scenario} through the real SDK and continues to the model's final answer`, async () => {
            let steps = 0;
            let executions = 0;
            const provider = new MockLanguageModelV2({
                doStream: async () => ({
                    stream: convertArrayToReadableStream<LanguageModelV2StreamPart>(++steps === 1 ? [
                        { type: 'stream-start' as const, warnings: [] },
                        { type: 'tool-call' as const, toolCallId: 'call-1', toolName: scenario === 'unknown tool' ? 'missing' : 'lookup',
                            input: scenario === 'invalid JSON' ? '{bad' : '{"q":"hello"}' },
                        { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
                    ] : [
                        { type: 'text-start' as const, id: 'answer' },
                        { type: 'text-delta' as const, id: 'answer', delta: 'Final answer' },
                        { type: 'text-end' as const, id: 'answer' },
                        { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }
                    ])
                })
            });
            const factory = new VercelAiLanguageModelFactory();
            factory.createLanguageModel = () => provider;
            const request: UserRequest = {
                sessionId: 'test-session', requestId: 'test-request',
                messages: [{ actor: 'user', type: 'text', text: 'Look up hello' }],
                tools: [{ id: 'lookup', name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
                    handler: async () => {
                        executions++;
                        if (scenario === 'handler failure') throw new Error('Lookup service unavailable');
                        return 'found';
                    } }]
            };
            const response = await new TestableVercelAiModel(factory).request(request);
            if (!isLanguageModelStreamResponse(response)) throw new Error('Expected a streaming response');
            const parts: LanguageModelStreamResponsePart[] = [];
            for await (const part of response.stream) parts.push(part);
            const calls = parts.filter(part => 'tool_calls' in part).flatMap(part => part.tool_calls);
            const last = calls[calls.length - 1];
            expect(last.finished).to.equal(true);
            const result = typeof last.result === 'string' ? JSON.parse(last.result) : last.result;
            expect(hasToolCallError(result)).to.equal(scenario !== 'success');
            if (scenario === 'handler failure') expect(JSON.stringify(result)).to.contain('Lookup service unavailable');
            expect(executions).to.equal(scenario === 'handler failure' || scenario === 'success' ? 1 : 0);
            expect(parts.some(part => 'content' in part && part.content === 'Final answer')).to.equal(true);
            expect(steps).to.equal(2);
        });
    }

    it('keeps the configured OpenAI-compatible chat endpoint', () => {
        const model = new VercelAiLanguageModelFactory().createLanguageModel({
            id: 'test', model: 'custom-model', apiKey: true, enableStreaming: true,
            supportsStructuredOutput: false, maxRetries: 1
        }, { provider: 'openai', apiKey: 'test-key', baseURL: 'https://example.invalid/v1' });
        expect(model.specificationVersion).to.equal('v2');
        expect(model.provider).to.equal('openai.chat');
    });
});
