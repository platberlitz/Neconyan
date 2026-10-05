import { chatHistoryAction, chatNavigationUrl, parseChatNavigation } from '../public/scripts/chat-navigation-policy.js';

const id = '12345678-1234-4234-8234-123456789abc';
const chat = { kind: 'chat', id, mode: 'roleplay' };

describe('exact chat URL policy', () => {
    test('root and explicit Home are different launch intents', () => {
        expect(parseChatNavigation('/neconyan/?unrelated=1')).toEqual({ kind: 'root' });
        expect(parseChatNavigation('/neconyan/?view=home')).toEqual({ kind: 'home' });
    });
    test.each(['roleplay', 'conversation', 'story'])('accepts the saved %s mode', mode => {
        expect(parseChatNavigation(`/?chat=${id}&mode=${mode}`)).toEqual({ kind: 'chat', id, mode });
    });
    test.each(['chat=', 'mode=roleplay', `chat=${id}`, `chat=${id}&mode=meower`, `chat=${id}&mode=roleplay&view=home`,
        `chat=${id}&mode=roleplay&chat=${id}`, `chat=${id}&mode=roleplay&mode=roleplay`, 'view=', 'view=home&view=home',
        'chat=../secrets&mode=roleplay', `chat=${'a'.repeat(4000)}&mode=roleplay`, `chat=${id.toUpperCase()}&mode=roleplay`].map((query, index) => [index + 1, query]))('rejects invalid destination case %s without becoming root', (_index, query) => {
        expect(parseChatNavigation('/?' + query)).toEqual({ kind: 'invalid' });
    });
    test('updates preserve deployment prefix, unrelated query and fragment', () => {
        const updated = chatNavigationUrl('https://example.test/neconyan/?unrelated=1&chat=bad&mode=bad#notes', chat);
        expect(updated.origin).toBe('https://example.test');
        expect(updated.pathname).toBe('/neconyan/');
        expect(updated.searchParams.get('unrelated')).toBe('1');
        expect(updated.hash).toBe('#notes');
        expect(parseChatNavigation(updated)).toEqual(chat);
        expect(chatNavigationUrl(updated, null).href).toBe('https://example.test/neconyan/?unrelated=1#notes');
    });
    test('copy produces only a minimal locator, never unrelated or sensitive parameters', () => {
        const link = chatNavigationUrl('https://example.test/neconyan/?key=secret&source=import#message', chat, { minimal: true });
        expect(link.href).toBe(`https://example.test/neconyan/?chat=${id}&mode=roleplay`);
    });
    test.each([false, true])('history ownership is independent of resume when links are %s', linksEnabled => {
        expect(chatHistoryAction({ current: { kind: 'root' }, next: chat, linksEnabled, reason: 'foreground' })).toBe(linksEnabled ? 'push' : 'replace');
        for (const reason of ['startup', 'popstate', 'restore', 'toggle', 'retry']) {
            expect(chatHistoryAction({ current: { kind: 'root' }, next: chat, linksEnabled, reason })).toBe('replace');
        }
        expect(chatHistoryAction({ current: chat, next: { ...chat }, linksEnabled })).toBe('none');
    });
    test('history destinations are parsed from the address, not a required state object', () => {
        const state = null;
        expect(state).toBeNull();
        expect(parseChatNavigation(`/?chat=${id}&mode=conversation`)).toEqual({ kind: 'chat', id, mode: 'conversation' });
    });
    test('URL construction rejects coerced identifiers', () => {
        expect(() => chatNavigationUrl('https://example.test/', { ...chat, id: [id] })).toThrow('Invalid chat destination.');
    });
});
