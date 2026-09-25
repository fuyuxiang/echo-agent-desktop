import { echoEmbedSession } from '@theia/core/lib/browser/echo-embed-session';

/** Messages are accepted only from the embedding EchoAgent window. */
export class EchoHostBridge {
    private readonly token = echoEmbedSession.bridgeToken;
    private readonly parentOrigin = echoEmbedSession.parentOrigin;
    private readonly pending = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
        timeout: number;
    }>();

    constructor() {
        window.addEventListener('message', event => {
            if (!this.isTrusted(event)) {
                return;
            }
            const message = event.data as Record<string, unknown>;
            if (message.type !== 'echo/response' || typeof message.id !== 'string') {
                return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            window.clearTimeout(pending.timeout);
            if (message.ok === true) {
                pending.resolve(message.value);
            } else {
                pending.reject(new Error(typeof message.error === 'string' ? message.error : 'EchoAgent 拒绝了文件操作'));
            }
        });
    }

    get enabled(): boolean {
        return !!this.token && !!this.parentOrigin && window.parent !== window;
    }

    isTrusted(event: MessageEvent): boolean {
        return this.enabled && event.source === window.parent && event.origin === this.parentOrigin
            && typeof event.data === 'object' && event.data !== null
            && (event.data as Record<string, unknown>).token === this.token;
    }

    notify(type: string, payload: Record<string, unknown> = {}): void {
        if (this.enabled) {
            window.parent.postMessage({ type, token: this.token, ...payload }, this.parentOrigin!);
        }
    }

    request(type: string, payload: Record<string, unknown>): Promise<unknown> {
        if (!this.enabled) {
            return Promise.resolve(undefined);
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('EchoAgent 文件操作响应超时'));
            }, 15_000);
            this.pending.set(id, { resolve, reject, timeout });
            this.notify(type, { id, ...payload });
        });
    }
}

export const echoHostBridge = new EchoHostBridge();
