// Shared URL policy. Only these three parameters belong to chat navigation.
export const CHAT_NAVIGATION_KEYS = Object.freeze(['chat', 'mode', 'view']);
export const CHAT_LINK_MODES = Object.freeze(['roleplay', 'conversation', 'story']);
export const CHAT_LINK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseChatNavigation(input) {
    const url = input instanceof URL ? input : new URL(input, 'https://localhost/');
    const values = Object.fromEntries(CHAT_NAVIGATION_KEYS.map(key => [key, url.searchParams.getAll(key)]));
    if (!CHAT_NAVIGATION_KEYS.some(key => values[key].length)) return { kind: 'root' };
    if (CHAT_NAVIGATION_KEYS.some(key => values[key].length > 1)) return { kind: 'invalid' };
    if (values.view.length) {
        return values.view[0] === 'home' && !values.chat.length && !values.mode.length ? { kind: 'home' } : { kind: 'invalid' };
    }
    const id = values.chat[0];
    const mode = values.mode[0];
    return typeof id === 'string' && CHAT_LINK_ID.test(id) && CHAT_LINK_MODES.includes(mode)
        ? { kind: 'chat', id, mode } : { kind: 'invalid' };
}

export function chatNavigationUrl(input, destination, { minimal = false } = {}) {
    const url = new URL(input);
    if (minimal) { url.search = ''; url.hash = ''; } else {
        for (const key of CHAT_NAVIGATION_KEYS) url.searchParams.delete(key);
    }
    if (destination?.kind === 'home') url.searchParams.set('view', 'home');
    if (destination?.kind === 'chat') {
        if (typeof destination.id !== 'string' || !CHAT_LINK_ID.test(destination.id) || !CHAT_LINK_MODES.includes(destination.mode)) throw new TypeError('Invalid chat destination.');
        url.searchParams.set('chat', destination.id);
        url.searchParams.set('mode', destination.mode);
    }
    return url;
}

export function sameChatDestination(a, b) {
    return a?.kind === b?.kind && (a?.kind !== 'chat' || (a.id === b.id && a.mode === b.mode));
}

export function chatHistoryAction({ current, next, linksEnabled, reason = 'foreground' }) {
    if (sameChatDestination(current, next)) return 'none';
    if (reason !== 'foreground') return 'replace';
    return linksEnabled ? 'push' : 'replace';
}
