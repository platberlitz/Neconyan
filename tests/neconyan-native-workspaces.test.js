import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

describe('Neconyan native workspace module', () => {
    test('queued localisation accepts a label whose translation attribute was removed', () => {
        const source = readFileSync(new URL('../public/scripts/i18n.js', import.meta.url), 'utf8');
        const translate = source.match(/^function translateElement\([\s\S]*?^}/m)[0];
        const context = vm.createContext({ localeData: { Before: 'After' } });
        vm.runInContext(translate, context);
        const element = { getAttribute: () => '[title]Before;Before', setAttribute: jest.fn(), textContent: '' };
        context.translateElement(element);
        expect(element.textContent).toBe('After');
        expect(element.setAttribute).toHaveBeenCalledWith('title', 'After');
        element.getAttribute = () => null;
        expect(() => context.translateElement(element)).not.toThrow();
        expect(element.textContent).toBe('After');
    });
    test('a bracketed word inside a caption is not read as an attribute name', () => {
        const source = readFileSync(new URL('../public/scripts/i18n.js', import.meta.url), 'utf8');
        const translate = source.match(/^function translateElement\([\s\S]*?^}/m)[0];
        const key = 'Channels like [SP] use the compatible API.';
        const context = vm.createContext({ localeData: { [key]: 'Translated [SP] caption.' } });
        vm.runInContext(translate, context);
        const element = { getAttribute: () => key, setAttribute: jest.fn(), textContent: '' };
        context.translateElement(element);
        expect(element.textContent).toBe('Translated [SP] caption.');
        expect(element.setAttribute).not.toHaveBeenCalled();
        // translateElement and getMissingTranslations must parse a spec the same way.
        expect(source.split('key.match(/^\\[([^\\]]+)\\](.+)$/s)')).toHaveLength(3);
    });
    test('multiline tooltips do not replace the control label', () => {
        const source = readFileSync(new URL('../public/scripts/i18n.js', import.meta.url), 'utf8');
        const translate = source.match(/^function translateElement\([\s\S]*?^}/m)[0];
        const key = 'Open checkpoint chat\nShift+Click to replace the existing checkpoint with a new one';
        const tooltip = 'Checkpoint-Chat öffnen\nUmschalt+Klick ersetzt den vorhandenen Checkpoint durch einen neuen';
        const context = vm.createContext({ localeData: {
            [key]: tooltip,
            [`[data-tooltip]${key}`]: 'Checkpoint',
            'Open checkpoint chat': 'Checkpoint-Chat öffnen',
        } });
        vm.runInContext(translate, context);
        const element = {
            getAttribute: () => `[data-tooltip]${key};[aria-label]Open checkpoint chat`,
            setAttribute: jest.fn(),
            textContent: 'Original label',
        };
        context.translateElement(element);
        expect(element.setAttribute).toHaveBeenCalledWith('data-tooltip', tooltip);
        expect(element.setAttribute).toHaveBeenCalledWith('aria-label', 'Checkpoint-Chat öffnen');
        expect(element.textContent).toBe('Original label');
    });
    test('links its folder helpers and exposes all native mount points', async () => {
        jest.resetModules();
        await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
            getNeconyanLorebookFolders: jest.fn(() => ({ folders: [], assignments: {} })),
            getWorldInfoEditorBookName: jest.fn(() => ''),
            updateNeconyanLorebookFolders: jest.fn(),
            world_names: [],
        }));
        await jest.unstable_mockModule('../public/scripts/neconyan-lorebook-folders.js', () => ({
            createNeconyanFolder: jest.fn(name => ({ id: 'folder-test', name })),
            moveNeconyanLorebook: jest.fn(value => value),
        }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
        await jest.unstable_mockModule('../public/scripts/neconyan-model-rotation.js', () => ({
            initModelRotation: jest.fn(),
            mountModelRotationPanel: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            callGenericPopup: jest.fn(),
            POPUP_RESULT: { AFFIRMATIVE: 1 },
            POPUP_TYPE: { CONFIRM: 2 },
        }));

        const nativeWorkspaces = await import('../public/scripts/neconyan-native-workspaces.js');
        expect(typeof nativeWorkspaces.mountNeconyanCharacterWorkspace).toBe('function');
        expect(typeof nativeWorkspaces.mountNeconyanModelWorkspace).toBe('function');
        expect(typeof nativeWorkspaces.mountNeconyanLorebookWorkspace).toBe('function');
    });
});
