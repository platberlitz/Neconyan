/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

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
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    focus() {}

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
        querySelector: () => null,
    };
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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

const constants = {
    SCOPE_GLOBAL: 'global',
    SCOPE_CHARACTER: 'character',
    SCOPE_CHAT: 'chat',
};

const storeCalls = {
    characters: [],
    chats: [],
    globals: [],
};

const storeMocks = {
    ...constants,
    createDef: partial => ({
        id: partial.id ?? 'new-id',
        name: partial.name ?? '',
        description: partial.description ?? '',
        template: partial.template ?? '',
        args: partial.args ?? [],
        enabled: partial.enabled !== false,
    }),
    getAllCustomNames: () => [],
    getGlobalDefs: () => [],
    getCharacterDefs: jest.fn(() => []),
    getChatDefs: jest.fn(() => []),
    saveGlobalDefs: jest.fn(defs => {
        storeCalls.globals.push(defs);
    }),
    saveChatDefs: jest.fn(defs => {
        storeCalls.chats.push(defs);
    }),
    saveCharacterDefs: jest.fn(async defs => {
        storeCalls.characters.push(defs);
    }),
    validateDef: () => [],
};

await jest.unstable_mockModule(
    '../public/scripts/extensions/third-party/MacroEnhanced/src/custom/store.js',
    () => storeMocks,
);
await jest.unstable_mockModule(
    '../public/scripts/extensions/third-party/MacroEnhanced/src/custom/registrar.js',
    () => ({ syncRegistrations: jest.fn() }),
);

const { createEditorDraft, renderMacroEditor } = await import(
    '../public/scripts/extensions/third-party/MacroEnhanced/src/custom/editor-ui.js'
);

function installContext() {
    const context = {
        userAvatar: 'mika.png',
        powerUserSettings: { personas: { 'mika.png': 'Mika' } },
        characters: [{ name: 'Ren', avatar: 'ren.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } }],
        characterId: 0,
        groupId: null,
        chatId: 'chat-1',
        chatMetadata: { MacroEnhanced: { version: 3, customMacros: [] } },
        extensionSettings: { MacroEnhanced: { settingsVersion: 5, customMacros: [], auditor: { manualCachingAtDepth: null }, compatExpressions: false, fixImportedSyntax: false, pronouns: { personas: {} } } },
        macros: { registry: { hasMacro: () => false, getMacro: () => null } },
        uuidv4: () => 'new-id',
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

describe('Macro Enhanced editor save races', () => {
    let sourceWrite;
    let onSaved;

    beforeEach(() => {
        installDocument();
        installContext();
        storeCalls.characters = [];
        storeCalls.chats = [];
        storeCalls.globals = [];
        storeMocks.getCharacterDefs.mockReturnValue([{ id: 'm1', name: 'greet' }]);
        storeMocks.getChatDefs.mockReturnValue([]);
        sourceWrite = deferred();
        storeMocks.saveCharacterDefs.mockImplementation(async defs => {
            storeCalls.characters.push(defs);
            await sourceWrite.promise;
        });
        storeMocks.saveChatDefs.mockImplementation(defs => {
            storeCalls.chats.push(defs);
        });
        onSaved = jest.fn();
    });

    test('a second save and a scope edit during a pending move do not retarget or duplicate writes', async () => {
        const draft = createEditorDraft({
            existingDef: { id: 'm1', name: 'greet', description: '', template: 'Hello', args: [], enabled: true },
            existingScope: 'character',
        });
        draft.scope = 'chat';
        const host = new FakeNode();
        renderMacroEditor(host, draft, { onSaved, onClose: () => {} });
        const save = findByText(host, 'Save');

        save.dispatch('click');
        while (storeCalls.characters.length === 0) {
            await Promise.resolve();
        }
        expect(storeCalls.chats).toHaveLength(1);
        expect(storeCalls.characters).toHaveLength(1);
        expect(storeCalls.chats[0].map(def => def.id)).toEqual(['m1']);
        expect(storeCalls.characters[0]).toEqual([]);

        // A second click while the source card write is pending is ignored.
        save.dispatch('click');
        // A programmatic scope change must not retarget the in-flight move.
        draft.scope = 'global';
        expect(storeCalls.globals).toHaveLength(0);

        const pending = sourceWrite.promise;
        sourceWrite.resolve();
        await pending;
        await Promise.resolve();
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(storeCalls.chats).toHaveLength(1);
        expect(storeCalls.characters).toHaveLength(1);
        expect(storeCalls.globals).toHaveLength(0);
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', name: 'greet' }), 'chat', { tryAfter: false });
        expect(draft.persistedScope).toBe('chat');
    });

    test('a failed source write leaves the editor open with the original and reports the incomplete move', async () => {
        const draft = createEditorDraft({
            existingDef: { id: 'm1', name: 'greet', description: '', template: 'Hello', args: [], enabled: true },
            existingScope: 'character',
        });
        draft.scope = 'chat';
        const host = new FakeNode();
        const onClose = jest.fn();
        renderMacroEditor(host, draft, { onSaved, onClose });
        const save = findByText(host, 'Save');

        save.dispatch('click');
        while (storeCalls.characters.length === 0) {
            await Promise.resolve();
        }
        sourceWrite.reject(new Error('card write failed'));
        await Promise.resolve();
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(draft.persistedScope).toBe('character');
        expect(host.textContent).toContain('Move incomplete');
        expect(host.textContent).toContain('still in This character');
        expect(storeCalls.chats.at(-1).map(def => def.id)).toEqual([]);
    });
});
