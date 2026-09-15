import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { exportProfiles, importProfiles } from '../public/scripts/extensions/third-party/Neconyan-PromptTags/src/settings.js';
import { createSuite } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/schema.js';
import { buildExport, parseImport } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/transfer.js';
import { isPromptTagsAvailable } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/integrations/prompttags.js';
import { createCustomThemeExport, prepareCustomThemeImport } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/custom-themes.js';

const previousHost = globalThis.SillyTavern;
let context;
beforeEach(() => {
    context = { extensionSettings: {}, saveSettingsDebounced: jest.fn() };
    globalThis.SillyTavern = { getContext: () => context };
});
afterEach(() => {
    if (previousHost === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousHost;
});

describe('native export and disabled-ID compatibility', () => {
    test('imports saved Prompt Tags profiles and keeps the old export identifier', () => {
        for (const format of ['sillybunny-prompt-tags', 'neconyan-prompt-tags']) {
            context.extensionSettings = {};
            const saved = JSON.stringify({ format, version: 1, profiles: { 'Saved profile': { rules: {} } } });
            expect(importProfiles(saved)).toMatchObject({ imported: ['Saved profile'], rejected: [], error: null });
            const exported = JSON.parse(exportProfiles());
            expect(exported.format).toBe('sillybunny-prompt-tags');
            expect(exported.profiles['Saved profile'].rules).toBeDefined();
        }
    });

    test('imports old Prompting Lab suites and retains their names and descriptions', () => {
        const exported = JSON.parse(buildExport(createSuite({ name: 'Saved suite', description: 'Keep this description.' }), []).text);
        expect(exported.format).toBe('sillybunny-prompting-lab');
        for (const format of ['sillybunny-prompting-lab', 'neconyan-prompting-lab']) {
            const imported = parseImport(JSON.stringify({ ...exported, format }));
            expect(imported.suite).toMatchObject({ name: 'Saved suite', description: 'Keep this description.', caseIds: [] });
            expect(imported.cases).toEqual([]);
        }
        expect(() => parseImport(JSON.stringify({ ...exported, format: 'unrelated-format' }))).toThrow();
    });

    test('imports old custom themes without changing the public export format', () => {
        const themes = { 'saved-cat': { slug: 'saved-cat', name: 'Saved cat', family: 'custom', mode: 'dark' } };
        for (const format of ['sillybunny-regex-agent-themes', 'neconyan-regex-agent-themes']) {
            const imported = prepareCustomThemeImport({ format, version: 1, themes });
            expect(imported).toMatchObject({ ok: true, accepted: ['saved-cat'], rejected: [] });
            expect(imported.themes['saved-cat']).toMatchObject({ name: 'Saved cat', mode: 'dark' });
            expect(createCustomThemeExport(imported.themes).format).toBe('sillybunny-regex-agent-themes');
        }
        expect(prepareCustomThemeImport({ format: 'unrelated-format', version: 1, themes }).ok).toBe(false);
    });

    test('respects legacy, canonical and short disabled IDs without disabling unrelated tools', () => {
        const host = { extensionSettings: { promptTags: { profiles: {} }, disabledExtensions: [] } };
        expect(isPromptTagsAvailable(host)).toBe(true);
        for (const id of ['SillyBunny-PromptTags', 'third-party/SillyBunny-PromptTags', 'third-party\\SillyBunny-PromptTags', 'Neconyan-PromptTags', 'prompttags']) {
            host.extensionSettings.disabledExtensions = [id];
            expect(isPromptTagsAvailable(host)).toBe(false);
        }
        host.extensionSettings.disabledExtensions = ['SillyBunny-CustomTool'];
        expect(isPromptTagsAvailable(host)).toBe(true);
    });
});
