/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

class FakeNode {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.listeners = new Map();
        this.className = '';
        this.id = '';
        this.value = '';
        this.type = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this._text = '';
        this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
    }

    set textContent(value) {
        this._text = String(value ?? '');
        this.children = [];
    }

    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }

    appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
    }

    append(...nodes) {
        for (const node of nodes) {
            this.appendChild(node);
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(listener);
    }

    dispatch(type) {
        const event = { target: this, preventDefault: () => {}, stopPropagation: () => {} };
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') {
            this.id = String(value);
        }
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    focus() {
        globalThis.document.activeElement = this;
    }

    select() {}

    closest() {
        return null;
    }
}

function installDocument() {
    globalThis.document = {
        activeElement: null,
        createElement: tag => new FakeNode(tag),
        createTextNode: text => {
            const node = new FakeNode('#text');
            node._text = String(text);
            return node;
        },
        querySelector: () => null,
    };
}

function installContext() {
    const context = {
        userAvatar: 'mika.png',
        powerUserSettings: { personas: { 'mika.png': 'Mika', 'ren.png': 'Ren' } },
        characters: [{ name: 'Nova', avatar: 'nova.png', data: { extensions: { MacroEnhanced: { customMacros: ['nova-kept'] } } } }, { name: 'Iris', avatar: 'iris.png', data: { extensions: { MacroEnhanced: { customMacros: ['iris-kept'] } } } }],
        characterId: 0,
        groupId: null,
        chatId: null,
        chatMetadata: {},
        extensionSettings: {
            MacroEnhanced: {
                settingsVersion: 5,
                customMacros: [],
                auditor: { manualCachingAtDepth: null },
                compatExpressions: false,
                fixImportedSyntax: false,
                pronouns: { personas: {} },
            },
        },
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

function findById(node, id) {
    if (node.id === id) {
        return node;
    }
    for (const child of node.children) {
        const found = findById(child, id);
        if (found) {
            return found;
        }
    }
    return null;
}

function findByText(node, text) {
    if (node.tagName === 'BUTTON' && node.textContent.trim() === text) {
        return node;
    }
    for (const child of node.children) {
        const found = findByText(child, text);
        if (found) {
            return found;
        }
    }
    return null;
}

describe('Macro Enhanced pronoun draft target safety', () => {
    beforeEach(() => {
        jest.resetModules();
        installDocument();
        installContext();
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.SillyTavern;
    });

    test('a dirty persona draft is kept, not written to the newly selected persona', async () => {
        const { renderPronounSettings } = await import('../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-ui.js');
        const host = new FakeNode();
        const controller = renderPronounSettings(host);
        const input = findById(host, 'me-pronoun-input-user');
        const draft = 'xe/xem/xyr/xyrs/xemself';

        input.value = draft;
        input.dispatch('input');

        const context = globalThis.SillyTavern.getContext();
        context.userAvatar = 'ren.png';
        controller.refresh();

        expect(input.value).toBe(draft);
        expect(input.dataset.targetKey).toBe('user:mika.png');
        const save = findByText(host, 'Save');
        expect(save.disabled).toBe(true);
        expect(findByText(host, 'Save old draft')).not.toBeNull();
        expect(host.textContent).toContain('Unsaved pronouns for Mika');
        expect(context.extensionSettings.MacroEnhanced.pronouns.personas['ren.png']).toBeUndefined();

        findByText(host, 'Save old draft').dispatch('click');
        await Promise.resolve();
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(context.extensionSettings.MacroEnhanced.pronouns.personas['mika.png']).toBe(draft);
        expect(context.extensionSettings.MacroEnhanced.pronouns.personas['ren.png']).toBeUndefined();
        expect(input.dataset.targetKey).toBe('user:ren.png');
        expect(input.value).toBe('');
        expect(findByText(host, 'Discard draft').parentElement.parentElement.hidden).toBe(true);
    });

    test('a character draft follows its avatar when the character list is reordered', async () => {
        const { renderPronounSettings } = await import('../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-ui.js');
        const context = globalThis.SillyTavern.getContext();
        const host = new FakeNode();
        const controller = renderPronounSettings(host);
        const input = findById(host, 'me-pronoun-input-char');
        input.value = 'he/him';
        input.dispatch('input');

        context.characters = [
            { name: 'Iris', avatar: 'iris.png', data: { extensions: { MacroEnhanced: { customMacros: ['iris-kept'] } } } },
            { name: 'Nova', avatar: 'nova.png', data: { extensions: { MacroEnhanced: { customMacros: ['nova-kept'] } } } },
        ];
        context.characterId = 1;
        controller.refresh();

        const save = findByText(input.parentElement, 'Save');
        expect(save.disabled).toBe(false);
        expect(input.dataset.targetKey).toBe('char:nova.png');
        expect(host.textContent).not.toContain('Unsaved pronouns for Nova');

        save.dispatch('click');
        await Promise.resolve();
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(context.writeExtensionField).toHaveBeenCalledWith(1, 'MacroEnhanced', {
            customMacros: ['nova-kept'],
            pronouns: 'he/him',
        });
        expect(context.writeExtensionField).not.toHaveBeenCalledWith(0, 'MacroEnhanced', expect.anything());
    });
});
