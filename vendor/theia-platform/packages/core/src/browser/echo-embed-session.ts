/**
 * Capture credentials from the iframe's browsing context name before any
 * extension starts. Clearing the name prevents later navigations from
 * carrying it. Session storage lets the same iframe reload after a backend
 * reconnect. Query parameters remain a compatibility fallback for older
 * hosts and are removed immediately.
 */
const SESSION_KEY = 'echo-embed-session-v1';
function parseCredentials(raw: string | null): { embedToken?: string; bridgeToken?: string; parentOrigin?: string } {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const values = parsed as Record<string, unknown>;
        return {
            embedToken: typeof values.embedToken === 'string' ? values.embedToken : undefined,
            bridgeToken: typeof values.bridgeToken === 'string' ? values.bridgeToken : undefined,
            parentOrigin: typeof values.parentOrigin === 'string' ? values.parentOrigin : undefined
        };
    } catch {
        return {};
    }
}
const params = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search);
let bootstrap: { embedToken?: string; bridgeToken?: string; parentOrigin?: string } = {};
if (typeof window !== 'undefined') {
    try {
        if (window.name.startsWith('echo-embed:')) {
            bootstrap = parseCredentials(window.name.slice('echo-embed:'.length));
            window.name = '';
            if (bootstrap.embedToken && bootstrap.bridgeToken && bootstrap.parentOrigin) {
                window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(bootstrap));
            }
        } else {
            bootstrap = parseCredentials(window.sessionStorage.getItem(SESSION_KEY));
        }
    } catch {
        window.name = '';
    }
}

export const echoEmbedSession = {
    embedToken: bootstrap.embedToken ?? params?.get('echoEmbedToken') ?? null,
    bridgeToken: bootstrap.bridgeToken ?? params?.get('echoBridgeToken') ?? null,
    parentOrigin: bootstrap.parentOrigin ?? params?.get('echoParentOrigin') ?? null
};

if (echoEmbedSession.embedToken && typeof window !== 'undefined') {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('echoEmbedToken');
        url.searchParams.delete('echoBridgeToken');
        url.searchParams.delete('echoParentOrigin');
        window.history.replaceState(window.history.state, '', url.toString());
    } catch {
        // Authentication still works when a webview denies history changes.
    }
}
