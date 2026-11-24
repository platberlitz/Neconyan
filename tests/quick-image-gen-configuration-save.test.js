import { readFileSync } from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';
import { getConfigurationSaveDefaultName, resolveConfigurationSave } from '../public/scripts/extensions/quick-image-gen/lib/configuration-save.js';
import { createDialogHost } from '../public/scripts/extensions/quick-image-gen/lib/st-dialogs.js';

const configurations = [
    { id: 'a', name: 'Portrait', provider: 'novelai' },
    { id: 'b', name: 'Scenery', provider: 'novelai' },
    { id: 'c', name: 'Portrait', provider: 'pixai' },
];

describe('Quick Image Gen configuration save name', () => {
    test('offers the selected configuration name for the same provider', () => {
        expect(getConfigurationSaveDefaultName(configurations, { activeId: 'b', provider: 'novelai' })).toBe('Scenery');
    });

    test('offers nothing without a selection or for another provider', () => {
        expect(getConfigurationSaveDefaultName(configurations, { activeId: '', provider: 'novelai' })).toBe('');
        expect(getConfigurationSaveDefaultName(configurations, { activeId: 'c', provider: 'novelai' })).toBe('');
        expect(getConfigurationSaveDefaultName(configurations, { activeId: 'missing', provider: 'novelai' })).toBe('');
    });
});

describe('Quick Image Gen configuration save target', () => {
    test('keeping the selected name overwrites it without asking again', () => {
        expect(resolveConfigurationSave(configurations, { name: 'Scenery', activeId: 'b', provider: 'novelai' }))
            .toEqual({ existingIndex: 1, needsConfirm: false });
    });

    test('a name that matches a different configuration still asks first', () => {
        expect(resolveConfigurationSave(configurations, { name: 'Portrait', activeId: 'b', provider: 'novelai' }))
            .toEqual({ existingIndex: 0, needsConfirm: true });
        expect(resolveConfigurationSave(configurations, { name: 'Portrait', activeId: '', provider: 'novelai' }))
            .toEqual({ existingIndex: 0, needsConfirm: true });
    });

    test('a new name or another provider creates a new configuration', () => {
        expect(resolveConfigurationSave(configurations, { name: 'Fresh', activeId: 'b', provider: 'novelai' }))
            .toEqual({ existingIndex: -1, needsConfirm: false });
        expect(resolveConfigurationSave(configurations, { name: 'Scenery', activeId: 'b', provider: 'pixai' }))
            .toEqual({ existingIndex: -1, needsConfirm: false });
    });

    test('prefers the selected entry when an older duplicate shares its name', () => {
        const duplicates = [
            { id: 'old', name: 'Same', provider: 'novelai' },
            { id: 'new', name: 'Same', provider: 'novelai' },
        ];
        expect(resolveConfigurationSave(duplicates, { name: 'Same', activeId: 'new', provider: 'novelai' }))
            .toEqual({ existingIndex: 1, needsConfirm: false });
    });
});

describe('Quick Image Gen input dialog text selection', () => {
    const popupType = { CONFIRM: 1, TEXT: 2, INPUT: 3 };
    const popupResult = { AFFIRMATIVE: 1 };

    test('selects the untouched prefilled name once the popup opens', async () => {
        const select = jest.fn();
        const callGenericPopup = jest.fn(async (_content, _type, value, options) => {
            options.onOpen({ mainInput: { value, select } });
            return value;
        });
        const host = createDialogHost({ callGenericPopup, popupType, popupResult });
        await expect(host.inputDialog('Configuration name:', { defaultValue: 'Scenery', selectText: true })).resolves.toBe('Scenery');
        expect(callGenericPopup.mock.calls[0][2]).toBe('Scenery');
        expect(select).toHaveBeenCalledTimes(1);
    });

    test('leaves text typed during the opening animation unselected', async () => {
        const select = jest.fn();
        const callGenericPopup = jest.fn(async (_content, _type, _value, options) => {
            options.onOpen({ mainInput: { value: 'Typed', select } });
            return 'Typed';
        });
        const host = createDialogHost({ callGenericPopup, popupType, popupResult });
        await host.inputDialog('Configuration name:', { defaultValue: 'Scenery', selectText: true });
        expect(select).not.toHaveBeenCalled();
    });

    test('adds no open handler unless asked', async () => {
        const callGenericPopup = jest.fn(async () => 'Name');
        const host = createDialogHost({ callGenericPopup, popupType, popupResult });
        await host.inputDialog('Configuration name:', { defaultValue: 'Scenery' });
        expect(callGenericPopup.mock.calls[0][3]).not.toHaveProperty('onOpen');
    });

    test('passes the prefilled name to the native prompt fallback', async () => {
        const nativePrompt = jest.fn(() => 'Scenery');
        const host = createDialogHost({ nativePrompt });
        await expect(host.inputDialog('Configuration name:', { defaultValue: 'Scenery', selectText: true })).resolves.toBe('Scenery');
        expect(nativePrompt).toHaveBeenCalledWith('Configuration name:', 'Scenery');
    });
});

describe('Quick Image Gen save wiring', () => {
    const source = readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function saveConfigurationAsNow()');
    const body = source.slice(start, source.indexOf('\n}\n', start));

    test('Save prefills the selected name and skips the repeat confirm for it', () => {
        expect(body).toContain('getConfigurationSaveDefaultName(configurations, { activeId');
        expect(body).toContain('defaultValue, selectText: true');
        expect(body).toContain('resolveConfigurationSave(configurations, { name, activeId');
        expect(body).toContain('if (needsConfirm && !await qigConfirm(');
    });
});
