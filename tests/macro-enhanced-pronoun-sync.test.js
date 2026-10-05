/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const MODULE = '../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-macros.js';

function installContext() {
    const context = {
        userAvatar: 'me.png',
        extensionSettings: {},
        chatId: 'chat-1',
        chatMetadata: {},
        characters: [{ data: { extensions: { MacroEnhanced: { customMacros: ['kept'] } } } }],
        characterId: 0,
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

describe('Macro Enhanced pronoun change notices', () => {
    let context;
    let pronouns;

    beforeEach(async () => {
        jest.resetModules();
        context = installContext();
        pronouns = await import(MODULE);
    });

    afterEach(() => {
        delete globalThis.SillyTavern;
    });

    test('a persona save tells every listener which side changed and who changed it', () => {
        const heard = [];
        pronouns.onPronounsChanged(({ subject, source }) => heard.push([subject, source]));

        pronouns.savePersonaSpec(' she/her ', { source: 'persona-field' });

        expect(context.extensionSettings.MacroEnhanced.pronouns.personas['me.png']).toBe('she/her');
        expect(pronouns.getPersonaSpec()).toBe('she/her');
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(heard).toEqual([['user', 'persona-field']]);
    });

    test('an empty persona save removes the entry so the default applies', () => {
        pronouns.savePersonaSpec('he/him');
        pronouns.savePersonaSpec('');

        expect(context.extensionSettings.MacroEnhanced.pronouns.personas).not.toHaveProperty('me.png');
        expect(pronouns.getPersonaSpec()).toBe('');
    });

    test('a delayed save lands on the persona it was typed for, not the one now selected', () => {
        context.userAvatar = 'other.png';

        pronouns.savePersonaSpec('it/its', { avatarId: 'me.png' });

        expect(context.extensionSettings.MacroEnhanced.pronouns.personas).toEqual({ 'me.png': 'it/its' });
    });

    test('character saves keep the card fields and announce the character side', async () => {
        const heard = [];
        pronouns.onPronounsChanged(({ subject, source }) => heard.push([subject, source]));

        await pronouns.saveCharacterSpec('she/her', { source: 'drawer' });

        expect(context.writeExtensionField).toHaveBeenCalledWith(0, 'MacroEnhanced', { customMacros: ['kept'], pronouns: 'she/her' });
        expect(heard).toEqual([['char', 'drawer']]);
    });

    test('clearing a chat override announces it', () => {
        const heard = [];
        pronouns.onPronounsChanged(({ subject }) => heard.push(subject));
        context.chatMetadata.MacroEnhanced = { pronouns: { user: 'he/him', char: '' } };

        pronouns.clearOverride(pronouns.SUBJECTS.user, { source: 'persona-field' });

        expect(pronouns.getOverrideSpec(pronouns.SUBJECTS.user)).toBe('');
        expect(heard).toEqual(['user']);
    });

    test('a failing listener does not stop the others, and unsubscribing stops notices', () => {
        const heard = [];
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        pronouns.onPronounsChanged(() => {
            throw new Error('boom');
        });
        const stop = pronouns.onPronounsChanged(({ subject }) => heard.push(subject));

        pronouns.savePersonaSpec('she/her');
        stop();
        pronouns.savePersonaSpec('he/him');

        expect(heard).toEqual(['user']);
        consoleError.mockRestore();
    });
});
