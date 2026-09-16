import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from '@jest/globals';

test('selected assistant icons update immediately and unread badges cannot restore an old choice', () => {
    const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const core = read('script.js');
    const notifications = read('scripts/neconyan-conversation/notifications.js');
    const images = [];
    const events = [];
    class Link {
        href = '/img/neconyan-icon-192.png';
        setAttribute(key, value) { this[key] = value; }
    }
    const link = new Link();
    const context = vm.createContext({
        localStorage: { getItem: () => 'calico' },
        window: { dispatchEvent: event => events.push(event.type) },
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
    vm.runInContext(core.slice(core.indexOf('const NECONYAN_FRONTEND_ICON_STORAGE_KEY'), core.indexOf('let optionsPopper')).replace(/^export /gm, ''), context);
    vm.runInContext(notifications.slice(notifications.indexOf('export function getFaviconLink'), notifications.indexOf('export function updatePalsToggleBadge')).replace(/^export /gm, ''), context);

    for (const id of ['miso', 'taro', 'nori']) {
        context.window.NeconyanFrontendIcon.apply(id);
        const expected = `/img/neconyan/assistant-icons/${id}.png`;
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
    expect(context.window.SillyBunnyFrontendIcon).toBe(context.window.NeconyanFrontendIcon);
    context.window.NeconyanFrontendIcon.apply('unknown');
    expect(link.href).toBe('/img/neconyan-icon-192.png');
});
