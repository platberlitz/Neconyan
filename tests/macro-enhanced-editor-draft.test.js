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
        this.focused = false;
        this._text = '';
        this.classList = {
            add: () => {},
            remove: () => {},
            toggle: () => {},
        };
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
        const event = {
            target: this,
            preventDefault: () => {},
            stopPropagation: () => {},
        };
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
        this.focused = true;
    }

    select() {}

    closest() {
        return null;
    }
}

function installDocument() {
    globalThis.document = {
        createElement: tag => new FakeNode(tag),
        createTextNode: text => {
            const node = new FakeNode('#text');
            node._text = String(text);
            return node;
        },
    };
}

function installContext() {
    const context = {
        uuidv4: () => 'draft-id',
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
        characters: [],
        characterId: null,
        groupId: null,
        chatId: null,
        chatMetadata: {},
        macros: { registry: { hasMacro: () => false, getMacro: () => null } },
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
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

describe('Macro Enhanced editor draft fields', () => {
    beforeEach(() => {
        jest.resetModules();
        installDocument();
        installContext();
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.SillyTavern;
    });

    test('name, template and description are written to the draft as they are typed', async () => {
        const editor = await import('../public/scripts/extensions/third-party/MacroEnhanced/src/custom/editor-ui.js');
        const draft = editor.createEditorDraft();
        const firstHost = new FakeNode();
        const first = editor.renderMacroEditor(firstHost, draft, {});

        const name = findById(firstHost, 'me-editor-name');
        const template = findById(firstHost, 'me-editor-template');
        const description = findById(firstHost, 'me-editor-description');
        name.value = 'greet';
        name.dispatch('input');
        template.value = 'Hello {{user}}';
        template.dispatch('input');
        description.value = 'A reusable greeting.';
        description.dispatch('input');
        first.destroy();

        expect(draft.def.name).toBe('greet');
        expect(draft.def.template).toBe('Hello {{user}}');
        expect(draft.def.description).toBe('A reusable greeting.');

        const secondHost = new FakeNode();
        const second = editor.renderMacroEditor(secondHost, draft, {});
        expect(findById(secondHost, 'me-editor-name').value).toBe('greet');
        expect(findById(secondHost, 'me-editor-template').value).toBe('Hello {{user}}');
        expect(findById(secondHost, 'me-editor-description').value).toBe('A reusable greeting.');
        second.destroy();
    });
});
