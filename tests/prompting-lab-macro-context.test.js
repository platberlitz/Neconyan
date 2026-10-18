import { describe, expect, test } from '@jest/globals';
import { macroConfigDiffers, readMacroEnhanced } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/integrations/macroenhanced.js';

function context() {
    return {
        userAvatar: 'persona.png',
        characterId: 0,
        characters: [{ data: { extensions: { MacroEnhanced: { pronouns: 'he/him' } } } }],
        chatMetadata: {},
        extensionSettings: {
            MacroEnhanced: {
                settingsVersion: 1,
                compatExpressions: false,
                fixImportedSyntax: false,
                pronouns: { personas: { 'persona.png': 'she/her', 'other.png': 'they/them' } },
            },
        },
    };
}

describe('Prompting Lab records the macro context that affects a prompt', () => {
    test('changing imported-syntax repair explains a prompt difference', () => {
        const ctx = context();
        const before = readMacroEnhanced(ctx);
        ctx.extensionSettings.MacroEnhanced.fixImportedSyntax = true;
        expect(macroConfigDiffers(before, readMacroEnhanced(ctx))).toBe(true);
    });

    test('changing the active persona pronouns explains a prompt difference', () => {
        const ctx = context();
        const before = readMacroEnhanced(ctx);
        ctx.extensionSettings.MacroEnhanced.pronouns.personas['persona.png'] = 'he/him';
        expect(macroConfigDiffers(before, readMacroEnhanced(ctx))).toBe(true);
    });

    test('changing another persona does not flag an unrelated prompt', () => {
        const ctx = context();
        const before = readMacroEnhanced(ctx);
        ctx.extensionSettings.MacroEnhanced.pronouns.personas['other.png'] = 'it/its';
        expect(macroConfigDiffers(before, readMacroEnhanced(ctx))).toBe(false);
    });

    test('character pronouns are recorded without storing their plain text', () => {
        const ctx = context();
        const before = readMacroEnhanced(ctx);
        ctx.characters[0].data.extensions.MacroEnhanced.pronouns = 'xe/xem/xyr/xyrs/xemself';
        const after = readMacroEnhanced(ctx);
        expect(macroConfigDiffers(before, after)).toBe(true);
        expect(JSON.stringify(after)).not.toContain('xe/xem');
    });

    test('older cases do not falsely report newly recorded fields as changed', () => {
        const current = readMacroEnhanced(context());
        const previous = { ...current };
        delete previous.fixImportedSyntax;
        delete previous.personaPronounsHash;
        delete previous.characterPronounsHash;
        expect(macroConfigDiffers(previous, current)).toBe(false);
        expect(macroConfigDiffers(current, previous)).toBe(false);
        expect(macroConfigDiffers({ ...previous, compatExpressions: true }, current)).toBe(true);
    });

    test('reads follow the latest selected persona and leave live stores untouched', () => {
        const ctx = context();
        const before = readMacroEnhanced(() => ctx);
        ctx.userAvatar = 'other.png';
        const original = JSON.stringify(ctx);
        expect(macroConfigDiffers(before, readMacroEnhanced(() => ctx))).toBe(true);
        expect(JSON.stringify(ctx)).toBe(original);
    });

    test('an uninitialised chat and empty saved pronoun overrides mean the same thing', () => {
        const ctx = context();
        const before = readMacroEnhanced(ctx);
        ctx.chatMetadata.MacroEnhanced = { pronouns: { user: '', char: '' } };
        expect(macroConfigDiffers(before, readMacroEnhanced(ctx))).toBe(false);
        ctx.chatMetadata.MacroEnhanced.pronouns.user = 'he/him';
        expect(macroConfigDiffers(before, readMacroEnhanced(ctx))).toBe(true);
    });
});
