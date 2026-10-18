/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';

function installContext(overrides = {}) {
    const ctx = {
        userAvatar: 'me.png',
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
        chatId: 'chat-1',
        chatMetadata: { MacroEnhanced: { version: 3, frozen: {}, sticky: {}, daily: {}, rolls: {}, chatVars: {}, counters: {}, customMacros: [], pronouns: { user: '', char: '' } } },
        characters: [{ name: 'Ren', avatar: 'ren.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } }],
        characterId: 0,
        groupId: null,
        uuidv4: () => 'id-1',
        macros: { registry: { hasMacro: () => false, getMacro: () => null } },
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    return ctx;
}

describe('Macro Enhanced custom macro scopes, drafts and packs', () => {
    let scopes;

    beforeEach(async () => {
        jest.resetModules();
        installContext();
        scopes = await import(`${BASE}custom/scopes.js`);
    });

    test('scope availability names exactly why a target cannot be used', () => {
        installContext({ characterId: null, groupId: 'g1' });
        const availability = scopes.scopeAvailability();
        expect(availability.global.available).toBe(true);
        expect(availability.character.available).toBe(false);
        expect(availability.character.reason).toContain('Group chats');
        expect(availability.chat.available).toBe(true);

        installContext({ chatId: null, chatMetadata: {} });
        expect(scopes.scopeAvailability().chat.available).toBe(false);
        expect(scopes.scopeAvailability().chat.reason).toContain('Open a chat');
    });

    test('a draft captured in one chat cannot be saved as chat state in another', () => {
        const first = installContext();
        const snapshot = scopes.snapshotContext(first);

        const second = installContext({ chatId: 'chat-2', chatMetadata: {} });
        const problem = scopes.validateScopeForSave({
            scope: 'chat',
            persistedScope: null,
            snapshot,
            ctx: second,
        });

        expect(problem).toContain('chat changed');
    });

    test('replacing the metadata object in the same chat does not look like a chat switch', () => {
        const first = installContext();
        const snapshot = scopes.snapshotContext(first);
        const sameChat = installContext({
            chatId: 'chat-1',
            chatMetadata: { MacroEnhanced: { version: 3, chatVars: { replaced: 'yes' } } },
        });

        expect(scopes.validateScopeForSave({
            scope: 'chat',
            persistedScope: 'chat',
            snapshot,
            ctx: sameChat,
        })).toBe('');
    });

    test('a draft captured for one character cannot be moved after a character switch', () => {
        const first = installContext();
        const snapshot = scopes.snapshotContext(first);
        const second = installContext({
            characterId: 1,
            characters: [
                { name: 'Ren', avatar: 'ren.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } },
                { name: 'Iris', avatar: 'iris.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } },
            ],
        });

        expect(scopes.validateScopeForSave({ scope: 'character', persistedScope: null, snapshot, ctx: second }))
            .toContain('character changed');
        expect(scopes.validateScopeForSave({ scope: 'global', persistedScope: 'character', snapshot, ctx: second }))
            .toContain('different character');
    });

    test('reordering the character list keeps the same character draft valid', () => {
        const first = installContext();
        const snapshot = scopes.snapshotContext(first);
        const reordered = installContext({
            characterId: 1,
            characters: [
                { name: 'Iris', avatar: 'iris.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } },
                { name: 'Ren', avatar: 'ren.png', data: { extensions: { MacroEnhanced: { customMacros: [] } } } },
            ],
        });

        expect(scopes.validateScopeForSave({
            scope: 'character',
            persistedScope: 'character',
            snapshot,
            ctx: reordered,
        })).toBe('');
    });

    test('deleting the character refuses a character-scoped draft', () => {
        const first = installContext();
        const snapshot = scopes.snapshotContext(first);
        const deleted = installContext({ characters: [], characterId: 0 });

        expect(scopes.validateScopeForSave({
            scope: 'character',
            persistedScope: null,
            snapshot,
            ctx: deleted,
        })).toContain('Open a single-character chat');
    });

    test('editing a macro in the same context is accepted', () => {
        const context = installContext();
        const snapshot = scopes.snapshotContext(context);
        expect(scopes.validateScopeForSave({ scope: 'global', persistedScope: null, snapshot, ctx: context })).toBe('');
        expect(scopes.validateScopeForSave({ scope: 'character', persistedScope: 'character', snapshot, ctx: context })).toBe('');
        expect(scopes.validateScopeForSave({ scope: 'chat', persistedScope: 'chat', snapshot, ctx: context })).toBe('');
    });

    test('/me-define omission keeps the saved arguments and their metadata', async () => {
        const { resolveDefineArgs } = await import(`${BASE}custom/define-args.js`);
        const existing = [
            { name: 'who', optional: false },
            { name: 'mood', optional: true, defaultValue: 'calm', description: 'The tone.' },
        ];

        expect(resolveDefineArgs(undefined, existing)).toEqual(existing);
        expect(resolveDefineArgs(undefined, existing)[1]).not.toBe(existing[1]);
        expect(resolveDefineArgs('a, b', existing)).toEqual([
            { name: 'a', optional: false },
            { name: 'b', optional: false },
        ]);
        expect(resolveDefineArgs('', existing)).toEqual([]);
    });

    test('the try call carries required arguments and leaves optional ones out', async () => {
        const { tryCallFor } = await import(`${BASE}ui/my-macros.js`);
        expect(tryCallFor({
            name: 'greet',
            args: [{ name: 'who' }, { name: 'mood', optional: true }],
        })).toBe('{{greet::who}}');
    });

    test('a pack keeps valid macros, reports invalid ones and surfaces the problems beside the install result', async () => {
        const { parsePack } = await import(`${BASE}custom/pack.js`);
        const { formatInstallStatus } = await import(`${BASE}custom/gallery-ui.js`);

        const parsed = parsePack(JSON.stringify({
            format: 'macro-enhanced-pack',
            version: 1,
            macros: [
                { name: 'greet', template: 'Hello {{who}}', args: [{ name: 'who' }] },
                { name: '__proto__', template: 'bad name' },
                { name: 'greet', template: 'duplicate' },
            ],
        }));

        expect(parsed.macros.map(macro => macro.name)).toEqual(['greet']);
        expect(parsed.problems.length).toBe(2);
        const status = formatInstallStatus({ installed: ['greet'], skipped: [] }, 'global', { problems: parsed.problems });
        expect(status).toContain('Macro #2');
        expect(status).toContain('Installed {{greet}}');
        expect(status).toContain('appears twice');
    });
});
