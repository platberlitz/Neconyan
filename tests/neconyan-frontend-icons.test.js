import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from '@jest/globals';

test('selected assistant icons update immediately and unread badges cannot restore an old choice', () => {
    const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const core = read('script.js');
    const notifications = read('scripts/neconyan-conversation/notifications.js');
    const images = [];
    const events = [];
    const listeners = new Map();
    let storedIcon = 'calico';
    let account = {};
    class Link {
        href = '/img/neconyan-icon-192.png';
        setAttribute(key, value) { this[key] = value; }
    }
    const link = new Link();
    const context = vm.createContext({
        localStorage: { getItem: () => storedIcon },
        accountStorage: { getState: () => account, setItem: (key, value) => { account[key] = value; } },
        window: {
            addEventListener: (type, listener) => listeners.set(type, listener),
            dispatchEvent: event => { events.push(event.type); listeners.get(event.type)?.(); },
        },
        CustomEvent: class { constructor(type) { this.type = type; } },
        HTMLLinkElement: Link,
        Image: class { constructor() { images.push(this); } },
        document: {
            readyState: 'complete',
            documentElement: { dataset: {} },
            querySelector: () => link,
            querySelectorAll: selector => selector.startsWith('link') ? [link] : [],
        },
        conversationState: { originalFaviconHref: '', faviconUpdateToken: 0 },
    });
    vm.runInContext(read('scripts/neconyan-assistant-art.js').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
    vm.runInContext(core.slice(core.indexOf('const NECONYAN_FRONTEND_ICON_STORAGE_KEY'), core.indexOf('let optionsPopper')).replace(/^export /gm, ''), context);
    vm.runInContext(notifications.slice(notifications.indexOf('export function getFaviconLink'), notifications.indexOf('export function updatePalsToggleBadge')).replace(/^export /gm, ''), context);

    for (const id of ['miso', 'taro', 'nori']) {
        storedIcon = id;
        context.window.NeconyanFrontendIcon.apply(id);
        const expected = `/img/neconyan/assistant-icons/${id}-neutral.png?v=20260916-art4`;
        expect(link.href).toBe(expected);
        expect(context.window.NeconyanFrontendIcon.getSrc()).toBe(expected);
        context.updateConversationFaviconBadge(2);
        expect(images.at(-1).src).toBe(expected);
        context.updateConversationFaviconBadge(0);
        // An older image finishing after the selection changed must not replace the icon.
        for (const image of images) image.onload();
        expect(link.href).toBe(expected);
    }
    expect(events).toEqual(Array(4).fill('sb:frontend-icon-changed'));
    for (const gender of ['female', 'male', 'neutral']) {
        context.updateConversationFaviconBadge(2);
        context.setAssistantGender('nori', gender);
        const expected = `/img/neconyan/assistant-icons/nori-${gender}.png?v=20260916-art4`;
        expect(link.href).toBe(expected);
        context.updateConversationFaviconBadge(0);
        for (const image of images) image.onload();
        expect(link.href).toBe(expected);
    }
    context.setAssistantGender('miso', 'female');
    context.setAssistantGender('taro', 'male');
    expect(['miso', 'taro', 'nori'].map(id => context.getAssistantGender(id))).toEqual(['female', 'male', 'neutral']);
    expect(context.getAssistantTourSrc('img/neconyan/tour/tour-02-miso-characters.webp?v=old')).toBe('img/neconyan/tour/tour-02-miso-characters-female.webp?v=20260916-art4');
    context.setAssistantGender('miso', '../invalid');
    context.setAssistantGender('unknown', 'male');
    expect(Object.keys(account)).toHaveLength(3);
    expect(context.getAssistantGender('miso')).toBe('female');
    // Another account cannot inherit the previous account's choices or invalid values.
    account = { 'neconyanAssistantGender:nori': 'invalid' };
    expect(['miso', 'taro', 'nori'].map(id => context.getAssistantGender(id))).toEqual(['neutral', 'neutral', 'neutral']);
    context.window.NeconyanFrontendIcon.apply('unknown');
    expect(link.href).toBe('/img/neconyan-icon-192.png');
});
