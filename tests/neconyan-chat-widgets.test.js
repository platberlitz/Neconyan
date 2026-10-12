import { describe, expect, jest, test } from '@jest/globals';
import { loadIsolated, managerFixture } from './pinned-prompt-test-support.js';

class Element {
    constructor(tag, doc) {
        this.tagName = tag; this.doc = doc; this.children = []; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map();
        this.textContent = ''; this.className = ''; this.hidden = false;
        this.classList = { contains: name => this.className.split(' ').includes(name), add: name => { this.className += ' ' + name; }, remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); } };
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(key, listener) { this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]); }
    removeEventListener(key, listener) { this.listeners.set(key, (this.listeners.get(key) ?? []).filter(value => value !== listener)); }
    fire(key) { this.listeners.get(key)?.forEach(listener => listener()); }
    append(...children) { children.forEach(child => this.insertBefore(child, null)); }
    prepend(child) { this.insertBefore(child, this.children[0] ?? null); }
    insertBefore(child, sibling) {
        child.remove(); const index = sibling ? this.children.indexOf(sibling) : this.children.length;
        this.children.splice(index, 0, child); child.parentElement = this;
    }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    getBoundingClientRect() { return { width: this.doc.hostWidth }; }
    focus() { this.doc.activeElement = this; }
}

async function fixture({ ready = true, styled = true } = {}) {
    const doc = { hostWidth: 1036, createElement: tag => new Element(tag, doc) };
    doc.body = new Element('body', doc);
    doc.body.className = 'neconyan';
    const host = doc.createElement('div'); host.id = 'sheld';
    const link = doc.createElement('link'); link.id = 'neconyan-chat-widgets-stylesheet'; link.sheet = styled ? {} : null;
    doc.body.append(host, link);
    doc.getElementById = id => {
        const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
        return visit(doc.body);
    };
    const media = new Element('media', doc); media.matches = true;
    const observers = [];
    class Observer {
        constructor(callback) { this.callback = callback; this.disconnect = jest.fn(); observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
    }
    const win = new Element('window', doc);
    Object.assign(win, { matchMedia: () => media, queueMicrotask, MutationObserver: Observer, ResizeObserver: Observer });
    const events = { listeners: new Map(), on(key, listener) { this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]); },
        removeListener(key, listener) { this.listeners.set(key, this.listeners.get(key).filter(value => value !== listener)); },
        emit(key, data) { this.listeners.get(key)?.forEach(listener => listener(data)); } };
    const keys = ['PROMPT_MANAGER_UPDATED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'MAIN_API_CHANGED', 'CHAT_CHANGED', 'CHAT_LOADED',
        'SETTINGS_LOADED_AFTER', 'SETTINGS_UPDATED', 'PRESET_RENAMED', 'PRESET_DELETED', 'APP_READY', 'OAI_PRESET_CHANGED_BEFORE', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED'];
    const types = Object.fromEntries(keys.map(key => [key, key]));
    const storage = { isReady: ready, value: null, getItem() { return this.value; }, setItem: jest.fn(function (_, value) { this.value = value; }) };
    const { manager } = await managerFixture();
    manager.serviceSettings.extensions.neconyan_pinned_prompts = { version: 1, identifiers: ['a', 'b'] };
    manager.notifyUpdated = () => events.emit(types.PROMPT_MANAGER_UPDATED);
    const state = { manager, name: 'A', api: 'openai', mode: 'roleplay', hasChat: true };
    const module = await loadIsolated('scripts/neconyan-chat-widgets.js', {
        '../script.js': { main_api: 'openai', this_chid: 1 }, './openai.js': { promptManager: manager, oai_settings: manager.serviceSettings },
        './events.js': { eventSource: events, event_types: types }, './util/AccountStorage.js': { accountStorage: storage },
    }, { document: doc, window: win });
    const controller = module.createChatWidgets({ getState: () => state, events, types, storage, doc, win });
    return { controller, module, doc, win, host, link, media, observers, events, types, storage, state, manager };
}

describe('desktop chat widget lifecycle', () => {
    test('one keyed view preserves focus through checked-state updates', async () => {
        const f = await fixture();
        const list = f.doc.getElementById('neconyan-pinned-prompts-content').lastElementChild;
        const button = list.firstElementChild;
        button.focus(); button.fire('click');
        await Promise.resolve();
        expect(button.getAttribute('aria-checked')).toBe('false');
        expect(list.firstElementChild).toBe(button);
        expect(f.doc.activeElement).toBe(button);
        f.manager.getPromptById('a').name = 'On';
        f.controller.refresh();
        expect(button.getAttribute('aria-label')).toBe('On');
        expect(button.getAttribute('data-i18n-ignore')).toBe('');
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('side');
        expect(f.observers[0].options).toEqual({ attributes: true, attributeFilter: ['class', 'data-neconyan-chat-mode'] });
        f.controller.dispose();
        expect(f.host.children).toHaveLength(0);
        expect(f.observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
        expect([...f.events.listeners.values()].every(listeners => listeners.length === 0)).toBe(true);
    });
    test('styles must really load before mounting, and failed styles hide everything', async () => {
        const f = await fixture({ styled: false });
        expect(f.host.children).toHaveLength(0);
        f.link.sheet = {}; f.link.fire('load');
        await Promise.resolve();
        expect(f.host.children).toHaveLength(1);
        f.link.fire('error');
        expect(f.host.children).toHaveLength(0);
    });
    test('unchanged refreshes do not rewrite names, labels, titles or text nodes', async () => {
        const f = await fixture();
        const nodes = [];
        const visit = node => { nodes.push(node); node.children.forEach(visit); };
        visit(f.doc.getElementById('neconyan-chat-widgets'));
        const writes = [];
        nodes.forEach(node => {
            let text = node.textContent;
            Object.defineProperty(node, 'textContent', { get: () => text, set: value => { text = value; writes.push(['text', value]); } });
            const original = node.setAttribute.bind(node);
            node.setAttribute = (name, value) => { writes.push([name, value]); original(name, value); };
        });
        f.controller.refresh(); f.controller.refresh();
        expect(writes).toEqual([]);
        f.manager.getPromptById('a').name = 'New label';
        f.controller.refresh();
        expect(writes).toEqual([['aria-label', 'New label'], ['title', 'New label'], ['text', 'New label']]);
    });
    test('Hush retains the dock because it is a chat reading layout, not a separate fullscreen mode', async () => {
        const f = await fixture();
        f.doc.body.classList.add('hushstyle');
        f.controller.refresh();
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('side');
        expect(f.doc.getElementById('neconyan-chat-widgets')).toBeDefined();
    });
    test.each(['conversation', 'story', 'meower'])('removes space in %s and rejects obsolete switches', async mode => {
        const f = await fixture();
        const button = f.doc.getElementById('neconyan-pinned-prompts-content').lastElementChild.firstElementChild;
        f.state.mode = mode;
        button.fire('click');
        f.controller.refresh();
        expect(f.manager.getPromptOrderEntry(f.manager.activeCharacter, 'a').enabled).toBe(true);
        expect(f.host.children).toHaveLength(0);
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBeNull();
    });
    test('phone resize synchronously removes nodes/space, without changing saved collapse', async () => {
        const f = await fixture();
        f.doc.getElementById('neconyan-pinned-prompts').firstElementChild.lastElementChild.fire('click');
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('collapsed');
        expect(f.storage.value).toBe('true');
        f.media.matches = false; f.media.fire('change');
        expect(f.host.children).toHaveLength(0);
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBeNull();
        f.media.matches = true; f.media.fire('change');
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('collapsed');
        expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    });
    test('real host border-box width selects stacked fallback without padding feedback', async () => {
        const f = await fixture();
        f.observers[1].callback([{ borderBoxSize: [{ inlineSize: 799 }], contentRect: { width: 567 } }]);
        await Promise.resolve();
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('stacked');
        f.observers[1].callback([{ borderBoxSize: [{ inlineSize: 800 }], contentRect: { width: 568 } }]);
        await Promise.resolve();
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('side');
    });
    test('preset-before clears projection until after, and API/Home/Terminal/no-chat/empty remove it', async () => {
        const f = await fixture();
        f.events.emit(f.types.OAI_PRESET_CHANGED_BEFORE);
        expect(f.host.children).toHaveLength(0);
        f.controller.refresh(); expect(f.host.children).toHaveLength(0);
        f.events.emit(f.types.OAI_PRESET_CHANGED_AFTER); await Promise.resolve();
        expect(f.host.children).toHaveLength(1);
        for (const property of ['api', 'hasChat']) {
            const previous = f.state[property]; f.state[property] = property === 'api' ? 'textgenerationwebui' : false;
            f.controller.refresh(); expect(f.host.children).toHaveLength(0);
            f.state[property] = previous; f.controller.refresh(); expect(f.host.children).toHaveLength(1);
        }
        for (const name of ['neconyan-home-visible', 'sbterm']) {
            f.doc.body.classList.add(name); f.controller.refresh(); expect(f.host.children).toHaveLength(0);
            f.doc.body.classList.remove(name); f.controller.refresh();
        }
        delete f.manager.serviceSettings.extensions.neconyan_pinned_prompts;
        const oldButton = f.doc.getElementById('neconyan-pinned-prompts-content').lastElementChild.firstElementChild;
        f.controller.refresh(); expect(f.host.children).toHaveLength(0);
        oldButton.fire('click');
        expect(f.manager.getPromptOrderEntry(f.manager.activeCharacter, 'a').enabled).toBe(true);
    });
    test('chat changes follow the manager-selected order and never assign a character independently', async () => {
        const f = await fixture();
        const oldButton = f.doc.getElementById('neconyan-pinned-prompts-content').lastElementChild.firstElementChild;
        f.manager.serviceSettings.prompt_order.push({ character_id: 7, order: [{ identifier: 'b', enabled: false }] });
        f.manager.activeCharacter = { id: 7 };
        f.events.emit(f.types.CHAT_CHANGED);
        await Promise.resolve();
        const list = f.doc.getElementById('neconyan-pinned-prompts-content').lastElementChild;
        expect(list.children).toHaveLength(1);
        expect(list.firstElementChild.dataset.promptIdentifier).toBe('b');
        oldButton.fire('click');
        expect(f.manager.activeCharacter.id).toBe(7);
        expect(f.manager.getPromptOrderEntry({ id: 42 }, 'a').enabled).toBe(true);
    });
    test('boot retries only when storage is ready and shell initialisation is idempotent', async () => {
        const f = await fixture({ ready: false });
        expect(f.host.children).toHaveLength(0);
        f.controller.dispose();
        const first = f.module.initChatWidgets({ getMode: () => 'roleplay' });
        const second = f.module.initChatWidgets({ getMode: () => 'roleplay' });
        expect(first).toBe(second);
        expect(f.host.children).toHaveLength(0);
        f.storage.isReady = true; f.storage.value = 'true';
        f.events.emit(f.types.APP_READY); await Promise.resolve();
        expect(f.host.children).toHaveLength(1);
        expect(f.host.getAttribute('data-neconyan-chat-widgets')).toBe('collapsed');
        expect(f.storage.setItem).not.toHaveBeenCalled();
    });
});
