/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';

class MemoryStorage {
    constructor(initial = {}) {
        this.map = new Map(Object.entries(initial));
        this.setCalls = 0;
    }

    get length() {
        return this.map.size;
    }

    key(index) {
        return [...this.map.keys()][index] ?? null;
    }

    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }

    setItem(key, value) {
        this.setCalls += 1;
        this.map.set(String(key), String(value));
    }

    removeItem(key) {
        this.map.delete(key);
    }

    clear() {
        this.map.clear();
    }
}

class QuotaStorage extends MemoryStorage {
    setItem() {
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        throw error;
    }
}

function macro(name, partial = {}) {
    return {
        id: `id-${name}`,
        name,
        description: '',
        template: `Hello from ${name}`,
        args: [],
        enabled: true,
        ...partial,
    };
}

function installContext(overrides = {}) {
    const context = {
        currentUserHandle: 'alice',
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
        chatMetadata: {
            MacroEnhanced: {
                version: 3,
                frozen: {},
                sticky: {},
                daily: {},
                rolls: {},
                chatVars: {},
                counters: { userMessages: 0, charMessages: 0, swipes: 0, generations: 0, firstSeenAt: 0 },
                customMacros: [],
                pronouns: { user: '', char: '' },
            },
        },
        characters: [{
            name: 'Ren',
            avatar: 'ren.png',
            data: { extensions: { MacroEnhanced: { customMacros: [] } } },
        }],
        characterId: 0,
        groupId: null,
        chatId: 'chat-1',
        uuidv4: jest.fn(() => 'generated-id'),
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
        macros: { registry: { hasMacro: () => false, getMacro: () => null } },
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

function browserKey(account = 'alice') {
    return `MacroEnhanced.browserMacros.v1:${account}`;
}

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
        this.parentElement = null;
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
        const event = { target: this, currentTarget: this, preventDefault: () => {}, stopPropagation: () => {} };
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') {
            this.id = String(value);
        }
        if (name === 'class') {
            this.className = String(value);
        }
        if (name === 'hidden') {
            this.hidden = true;
        }
        if (name === 'disabled') {
            this.disabled = true;
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

    matches(selector) {
        if (selector.startsWith('.') && !selector.includes(' ')) {
            return String(this.className).split(/\s+/).includes(selector.slice(1));
        }
        const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (attribute) {
            const [, name, value] = attribute;
            if (name.startsWith('data-')) {
                const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                const actual = this.dataset[key];
                return value === undefined ? actual !== undefined : actual === value;
            }
            return value === undefined
                ? Object.hasOwn(this.attributes, name)
                : this.attributes[name] === value;
        }
        const option = /^option\[value="([^"]*)"\]$/.exec(selector);
        if (option) {
            return this.tagName === 'OPTION' && (this.value === option[1] || this.attributes.value === option[1]);
        }
        return false;
    }

    closest(selector) {
        let node = this.parentElement;
        while (node) {
            if (node.matches(selector)) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    querySelectorAll(selector) {
        const found = [];
        const walk = node => {
            for (const child of node.children) {
                if (child.matches(selector)) {
                    found.push(child);
                }
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
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
    globalThis.requestAnimationFrame = () => 0;
    globalThis.CSS = { escape: value => String(value) };
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

async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

function blockedStorage() {
    return {
        getItem() {
            throw new Error('Site data is blocked.');
        },
        setItem() {
            throw new Error('Site data is blocked.');
        },
    };
}

describe('Macro Enhanced browser-local custom macros', () => {
    let storage;
    let context;

    beforeEach(() => {
        jest.resetModules();
        storage = new MemoryStorage();
        globalThis.localStorage = storage;
        context = installContext();
    });

    test('saves version 1 data in true localStorage under the account handle', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const alice = macro('greet');

        browser.writeBrowserDefs([alice], { storage, account: 'alice' });

        expect(storage.getItem(browserKey())).toBe(JSON.stringify({ version: 1, macros: [alice] }));
        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toEqual([alice]);
        expect(browser.getBrowserDefs({ storage, account: 'bob' })).toEqual([]);
        expect(storage.map.size).toBe(1);
    });

    test('keeps optional assistant review metadata within 512 characters', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const longId = 'p'.repeat(600);
        browser.writeBrowserDefs([
            macro('with-review', { authoringProposalId: 'proposal-42' }),
            macro('long-review', { authoringProposalId: longId }),
            macro('bad-review', { authoringProposalId: 42 }),
        ], { storage, account: 'alice' });

        const defs = browser.getBrowserDefs({ storage, account: 'alice' });
        expect(defs[0].authoringProposalId).toBe('proposal-42');
        expect(defs[1].authoringProposalId).toHaveLength(512);
        expect(defs[2]).not.toHaveProperty('authoringProposalId');

        // An editor save rebuilds the macro without the hidden field. The store
        // keeps the existing marker for the same id so a retry stays idempotent.
        browser.writeBrowserDefs([
            macro('with-review', { template: 'An edited template' }),
        ], { storage, account: 'alice' });
        expect(browser.getBrowserDefs({ storage, account: 'alice' })[0]).toMatchObject({
            name: 'with-review',
            template: 'An edited template',
            authoringProposalId: 'proposal-42',
        });
    });

    test('reads damaged JSON as empty, reports it, and refuses to overwrite it', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        storage.setItem(browserKey(), '{"version":1,"macros":[');

        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toEqual([]);
        expect(browser.getBrowserStoreProblem({ storage, account: 'alice' })).toContain('could not be read');
        await expect(async () => {
            browser.writeBrowserDefs([macro('replacement')], { storage, account: 'alice' });
        }).rejects.toThrow('could not be read');
        expect(storage.getItem(browserKey())).toBe('{"version":1,"macros":[');

        // Another account is unaffected by the first account's damage.
        browser.writeBrowserDefs([macro('clean')], { storage, account: 'bob' });
        expect(browser.getBrowserDefs({ storage, account: 'bob' }).map(def => def.name)).toEqual(['clean']);
    });

    test('refuses unsupported versions and malformed macro entries without writing', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        storage.setItem(browserKey(), JSON.stringify({ version: 2, macros: [macro('future')] }));
        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toEqual([]);
        expect(() => browser.writeBrowserDefs([], { storage, account: 'alice' })).toThrow('could not be read');

        storage.setItem(browserKey(), JSON.stringify({ version: 1, macros: [{ name: 'no-template' }] }));
        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toEqual([]);
        expect(() => browser.writeBrowserDefs([macro('later')], { storage, account: 'alice' })).toThrow('could not be read');
    });

    test('enforces the 200 macro and 20,000 character limits', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const many = Array.from({ length: 201 }, (_, index) => macro(`macro-${index}`));
        expect(() => browser.writeBrowserDefs(many, { storage, account: 'alice' })).toThrow('at most 200');

        const longest = Array.from({ length: 200 }, (_, index) => macro(`macro-${index}`));
        browser.writeBrowserDefs(longest, { storage, account: 'alice' });
        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toHaveLength(200);

        expect(() => browser.writeBrowserDefs([
            macro('too-long', { template: 'x'.repeat(20001) }),
        ], { storage, account: 'alice' })).toThrow('20,000-character limit');
        browser.writeBrowserDefs([
            macro('long-but-fine', { template: 'x'.repeat(20000) }),
        ], { storage, account: 'alice' });
    });

    test('reports a full browser storage explicitly and leaves the old data alone', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const quota = new QuotaStorage({ [browserKey()]: JSON.stringify({ version: 1, macros: [macro('kept')] }) });

        expect(() => browser.writeBrowserDefs([macro('new')], { storage: quota, account: 'alice' }))
            .toThrow('no room left');
        expect(JSON.parse(quota.getItem(browserKey())).macros.map(def => def.name)).toEqual(['kept']);
    });

    test('resolves the account from either the context getter or getCurrentUserHandle', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        delete context.currentUserHandle;
        context.getCurrentUserHandle = () => 'alice';

        browser.writeBrowserDefs([macro('from-getter')], { storage });
        expect(browser.getBrowserIdentity()).toBe('alice');
        expect(browser.getBrowserDefs({ storage }).map(def => def.name)).toEqual(['from-getter']);
    });

    test('injected storage and account work without touching the global browser store', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const isolated = new MemoryStorage();
        globalThis.localStorage = {
            getItem() {
                throw new Error('the global store should not be touched');
            },
            setItem() {
                throw new Error('the global store should not be touched');
            },
        };

        browser.writeBrowserDefs([macro('private')], { storage: isolated, account: 'alice' });
        expect(browser.getBrowserDefs({ storage: isolated, account: 'alice' }).map(def => def.name)).toEqual(['private']);
    });

    test('includes browser definitions in collision checks and the precedence chain', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const store = await import(`${BASE}custom/store.js`);

        context.extensionSettings.MacroEnhanced.customMacros = [
            macro('shared', { template: 'global' }),
            macro('global-only'),
        ];
        browser.writeBrowserDefs([
            macro('shared', { template: 'browser' }),
            macro('browser-only'),
        ], { storage, account: 'alice' });
        context.characters[0].data.extensions.MacroEnhanced.customMacros = [
            macro('shared', { template: 'character' }),
            macro('character-only'),
        ];
        context.chatMetadata.MacroEnhanced.customMacros = [
            macro('shared', { template: 'chat' }),
            macro('chat-only'),
        ];

        const effective = new Map(store.getEffectiveDefs().map(({ def, scope }) => [def.name, scope]));
        expect(effective.get('shared')).toBe('chat');
        expect(effective.get('global-only')).toBe('global');
        expect(effective.get('browser-only')).toBe('browser');
        expect(effective.get('character-only')).toBe('character');
        expect(effective.get('chat-only')).toBe('chat');
        expect(store.getAllCustomNames()).toEqual(expect.arrayContaining([
            'shared', 'global-only', 'browser-only', 'character-only', 'chat-only',
        ]));

        context.chatMetadata.MacroEnhanced.customMacros = [];
        expect(new Map(store.getEffectiveDefs().map(({ def, scope }) => [def.name, scope])).get('shared')).toBe('character');
        context.characters[0].data.extensions.MacroEnhanced.customMacros = [];
        expect(new Map(store.getEffectiveDefs().map(({ def, scope }) => [def.name, scope])).get('shared')).toBe('browser');
        browser.writeBrowserDefs([], { storage, account: 'alice' });
        expect(new Map(store.getEffectiveDefs().map(({ def, scope }) => [def.name, scope])).get('shared')).toBe('global');
    });

    test('browser saves make no server settings, card or chat metadata call', async () => {
        const store = await import(`${BASE}custom/store.js`);
        const dataEvents = await import(`${BASE}data-events.js`);
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push(kind));
        await store.saveDefsForScope('browser', [macro('local-only')], { storage, account: 'alice' });

        expect(heard).toEqual(['macros']);
        expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(context.writeExtensionField).not.toHaveBeenCalled();
        expect(JSON.parse(storage.getItem(browserKey())).macros[0].name).toBe('local-only');
    });

    test('moves a macro from this browser to the server scopes and back without losing it', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const store = await import(`${BASE}custom/store.js`);
        const { moveMacroBetweenScopes } = await import(`${BASE}custom/scope-move.js`);
        const { exportPack } = await import(`${BASE}custom/pack.js`);

        browser.writeBrowserDefs([macro('greet')], { storage, account: 'alice' });
        const identityFor = scope => scope === 'browser' ? context.currentUserHandle : scope === 'character' ? 'ren.png' : scope === 'chat' ? 'chat-1' : 'global';
        const readDefs = scope => store.getDefsForScope(scope);
        const persist = (scope, defs) => store.saveDefsForScope(scope, defs);

        await moveMacroBetweenScopes({
            sourceScope: 'browser',
            targetScope: 'global',
            defId: 'id-greet',
            sourceDefs: [],
            targetDefs: [macro('greet')],
            identityFor,
            readDefs,
            persist,
        });
        expect(store.getGlobalDefs().map(def => def.name)).toEqual(['greet']);
        expect(browser.getBrowserDefs({ storage, account: 'alice' })).toEqual([]);
        expect(context.saveSettingsDebounced).toHaveBeenCalled();

        await moveMacroBetweenScopes({
            sourceScope: 'global',
            targetScope: 'browser',
            defId: 'id-greet',
            sourceDefs: [],
            targetDefs: [macro('greet')],
            identityFor,
            readDefs,
            persist,
        });
        expect(context.extensionSettings.MacroEnhanced.customMacros).toEqual([]);
        expect(browser.getBrowserDefs({ storage, account: 'alice' }).map(def => def.name)).toEqual(['greet']);

        const pack = exportPack(store.getDefsForScope('browser'));
        expect(pack.macros.map(def => def.name)).toEqual(['greet']);
        expect(pack.macros[0]).not.toHaveProperty('id');
    });

    test('switching accounts changes the browser definitions and never exposes the previous account', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const store = await import(`${BASE}custom/store.js`);
        browser.writeBrowserDefs([macro('alice-macro')], { storage, account: 'alice' });
        browser.writeBrowserDefs([macro('bob-macro')], { storage, account: 'bob' });

        expect(store.getEffectiveDefs().map(({ def }) => def.name)).toEqual(['alice-macro']);
        context.currentUserHandle = 'bob';
        expect(store.getEffectiveDefs().map(({ def }) => def.name)).toEqual(['bob-macro']);
        expect(store.getAllCustomNames()).toEqual(['bob-macro']);
    });

    test('an open browser draft cannot follow an account switch', async () => {
        const scopes = await import(`${BASE}custom/scopes.js`);
        const snapshot = scopes.snapshotContext();
        context.currentUserHandle = 'bob';

        expect(scopes.validateScopeForSave({
            scope: 'browser',
            persistedScope: null,
            snapshot,
        })).toContain('account changed');
        expect(scopes.validateScopeForSave({
            scope: 'browser',
            persistedScope: 'browser',
            snapshot,
        })).toContain('different account');
    });

    test('scope copy says where browser macros live and that they are not synced', async () => {
        const scopes = await import(`${BASE}custom/scopes.js`);
        expect(scopes.SCOPE_COPY.browser.title).toBe('This browser');
        expect(scopes.SCOPE_COPY.browser.hint).toContain('this device');
        expect(scopes.SCOPE_COPY.browser.hint).toContain('this account');
        expect(scopes.SCOPE_COPY.browser.hint).toContain('Not synced or backed up');
        expect(scopes.SCOPE_COPY.browser.hint).toContain('Export to move');

        const availability = scopes.scopeAvailability();
        expect(availability.browser.available).toBe(true);
    });

    test('recognises only this extension browser keys for a cross-tab refresh', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        expect(browser.isBrowserStoreKey(browserKey('alice'))).toBe(true);
        expect(browser.isBrowserStoreKey(browserKey('bob'))).toBe(true);
        expect(browser.isBrowserStoreKey('MacroEnhanced.ui.v1')).toBe(false);
        expect(browser.isBrowserStoreKey(null)).toBe(false);
    });

    test('gallery mounting survives blocked browser storage and shows the reason', async () => {
        installDocument();
        globalThis.localStorage = blockedStorage();
        const { renderTemplateGallery } = await import(`${BASE}custom/gallery-ui.js`);
        const host = new FakeNode();

        const gallery = renderTemplateGallery(host, { announce: () => {} });

        expect(host.textContent).toContain('This browser');
        expect(host.textContent).toContain('could not read its saved macros');
        expect(() => gallery.refresh()).not.toThrow();
    });

    test('gallery mounting survives damaged browser storage and shows the reason', async () => {
        installDocument();
        storage.setItem(browserKey(), '{"version":1,"macros":[');
        const { renderTemplateGallery } = await import(`${BASE}custom/gallery-ui.js`);
        const host = new FakeNode();

        const gallery = renderTemplateGallery(host, { announce: () => {} });

        expect(host.textContent).toContain('could not be read');
        expect(host.textContent).toContain('not overwritten');
        expect(() => gallery.refresh()).not.toThrow();
    });

    test('editor save turns a blocked browser read into a form problem', async () => {
        installDocument();
        globalThis.localStorage = blockedStorage();
        const { createEditorDraft, renderMacroEditor } = await import(`${BASE}custom/editor-ui.js`);
        const draft = createEditorDraft();
        draft.scope = 'browser';
        const host = new FakeNode();
        const controller = renderMacroEditor(host, draft, { onClose: () => {}, onSaved: () => {} });
        findById(host, 'me-editor-name').value = 'local-greet';
        findById(host, 'me-editor-template').value = 'Hello {{user}}.';

        findByText(host, 'Save').dispatch('click');
        await settle();

        expect(host.textContent).toContain('Could not read This browser macros');
        expect(host.textContent).toContain('could not read its saved macros');
        controller.destroy();
    });

    test('editor save declines a damaged browser list before writing', async () => {
        installDocument();
        storage.setItem(browserKey(), '{"version":1,"macros":[');
        const { createEditorDraft, renderMacroEditor } = await import(`${BASE}custom/editor-ui.js`);
        const draft = createEditorDraft();
        draft.scope = 'browser';
        const host = new FakeNode();
        const controller = renderMacroEditor(host, draft, { onClose: () => {}, onSaved: () => {} });
        findById(host, 'me-editor-name').value = 'local-greet';
        findById(host, 'me-editor-template').value = 'Hello {{user}}.';

        findByText(host, 'Save').dispatch('click');
        await settle();

        expect(host.textContent).toContain('could not be read');
        expect(storage.getItem(browserKey())).toBe('{"version":1,"macros":[');
        controller.destroy();
    });

    test('commands report corrupted browser data instead of claiming there are no macros', async () => {
        storage.setItem(browserKey(), '{"version":1,"macros":[');
        context.extensionSettings.MacroEnhanced.customMacros = [macro('greet')];
        const commands = new Map();
        Object.assign(context, {
            SlashCommandParser: { addCommandObject: command => commands.set(command.name, command) },
            SlashCommand: { fromProps: props => props },
            SlashCommandArgument: class {},
            SlashCommandNamedArgument: { fromProps: props => props },
            ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean' },
        });
        const { registerCommands } = await import(`${BASE}commands.js`);
        expect(registerCommands()).toBe(true);

        const exported = commands.get('me-export').callback({ scope: 'browser' });
        expect(exported).toContain('Could not read This browser macros');
        expect(exported).not.toContain('No custom macros');

        const removed = await commands.get('me-undefine').callback({}, 'greet');
        expect(removed).toContain('removed from the readable scopes');
        expect(removed).toContain('could not be read');
        expect(context.extensionSettings.MacroEnhanced.customMacros).toEqual([]);
    });

    test('a delete confirmed after an account switch leaves the other account alone', async () => {
        installDocument();
        const browser = await import(`${BASE}custom/browser-store.js`);
        browser.writeBrowserDefs([
            macro('alice-greet', { id: 'shared-id' }),
        ], { storage, account: 'alice' });
        browser.writeBrowserDefs([
            macro('bob-greet', { id: 'shared-id' }),
        ], { storage, account: 'bob' });

        let release;
        const confirmation = new Promise(resolve => {
            release = resolve;
        });
        context.Popup = { show: { confirm: jest.fn(() => confirmation) } };
        const { createMyMacrosPanel } = await import(`${BASE}ui/my-macros.js`);
        const panel = createMyMacrosPanel({ onTry: () => {}, announce: () => {} });
        const deleteButton = findByText(panel.element, 'Delete');
        expect(deleteButton).toBeTruthy();

        deleteButton.dispatch('click');
        expect(context.Popup.show.confirm).toHaveBeenCalledTimes(1);
        context.currentUserHandle = 'bob';
        release(true);
        await settle();

        expect(browser.getBrowserDefs({ storage, account: 'alice' }).map(def => def.name)).toEqual(['alice-greet']);
        expect(browser.getBrowserDefs({ storage, account: 'bob' }).map(def => def.name)).toEqual(['bob-greet']);
        panel.destroy();
    });

    test('Prompting Lab records the browser fingerprint that affects a prompt', async () => {
        const browser = await import(`${BASE}custom/browser-store.js`);
        const { macroConfigDiffers, readMacroEnhanced } = await import(
            '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/integrations/macroenhanced.js'
        );
        browser.writeBrowserDefs([macro('greet', { template: 'Hello {{user}}' })], { storage, account: 'alice' });
        const before = readMacroEnhanced(context);

        expect(before.browserMacros).toEqual([{ name: 'greet', template: 'Hello {{user}}', args: [] }]);

        browser.writeBrowserDefs([macro('greet', { template: 'Goodbye {{user}}' })], { storage, account: 'alice' });
        expect(macroConfigDiffers(before, readMacroEnhanced(context))).toBe(true);
    });
});
