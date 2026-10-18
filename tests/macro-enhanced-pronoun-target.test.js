/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const MODULE = '../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-ui.js';

function installContext(overrides = {}) {
    const context = {
        userAvatar: 'mika.png',
        powerUserSettings: { personas: { 'mika.png': 'Mika', 'ren.png': 'Ren' } },
        groupId: null,
        characterId: 0,
        characters: [{ name: 'Nova', avatar: 'nova.png' }, { name: 'Iris', avatar: 'iris.png' }],
        extensionSettings: { MacroEnhanced: { settingsVersion: 5, customMacros: [], auditor: { manualCachingAtDepth: null }, compatExpressions: false, fixImportedSyntax: false, pronouns: { personas: {} } } },
        chatId: 'chat-1',
        chatMetadata: {},
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

describe('Macro Enhanced pronoun draft targets', () => {
    let pronounUi;

    beforeEach(async () => {
        jest.resetModules();
        installContext();
        pronounUi = await import(MODULE);
    });

    test('the persona target key changes with the selected persona', () => {
        const subject = { key: 'user' };
        const first = pronounUi.pronounTarget(subject);
        expect(first).toMatchObject({ key: 'user:mika.png', label: 'Mika', unavailable: '' });

        const context = globalThis.SillyTavern.getContext();
        context.userAvatar = 'ren.png';
        const second = pronounUi.pronounTarget(subject);
        expect(second.key).toBe('user:ren.png');
        expect(second.key).not.toBe(first.key);
        expect(second.label).toBe('Ren');
        expect(pronounUi.splitPronounTargetKey(second.key)).toEqual({ kind: 'user', id: 'ren.png' });
    });

    test('the character target key changes with the open character', () => {
        const subject = { key: 'char' };
        const first = pronounUi.pronounTarget(subject);
        expect(first).toMatchObject({ key: 'char:nova.png', label: 'Nova', unavailable: '' });

        const context = globalThis.SillyTavern.getContext();
        context.characterId = 1;
        const second = pronounUi.pronounTarget(subject);
        expect(second.key).toBe('char:iris.png');
        expect(second.key).not.toBe(first.key);
        expect(second.label).toBe('Iris');
    });

    test('a character target key survives list reordering and disappears on delete', () => {
        const subject = { key: 'char' };
        const context = globalThis.SillyTavern.getContext();
        const key = pronounUi.pronounTarget(subject).key;
        expect(key).toBe('char:nova.png');

        context.characters = [
            { name: 'Iris', avatar: 'iris.png' },
            { name: 'Nova', avatar: 'nova.png' },
        ];
        context.characterId = 1;
        expect(pronounUi.pronounTarget(subject).key).toBe(key);
        expect(pronounUi.pronounTargetExists(key)).toBe(true);

        context.characters = [{ name: 'Iris', avatar: 'iris.png' }];
        context.characterId = 0;
        expect(pronounUi.pronounTargetExists(key)).toBe(false);
    });

    test('group chats and unnamed personas have no writable target', () => {
        const subject = { key: 'char' };
        const context = globalThis.SillyTavern.getContext();
        context.groupId = 'group-1';
        expect(pronounUi.pronounTarget(subject).key).toBe('');
        expect(pronounUi.pronounTarget(subject).unavailable).toContain('Group chats');

        context.groupId = null;
        context.userAvatar = 'unknown.png';
        expect(pronounUi.pronounTarget({ key: 'user' }).key).toBe('');
        expect(pronounUi.pronounTarget({ key: 'user' }).unavailable).toContain('Select a named persona');
    });

    test('a split target key keeps ids that contain punctuation', () => {
        expect(pronounUi.splitPronounTargetKey('user:mika.special.png')).toEqual({ kind: 'user', id: 'mika.special.png' });
        expect(pronounUi.splitPronounTargetKey('char:12')).toEqual({ kind: 'char', id: '12' });
    });
});
