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

        const nativeWorkspaces = await import('../public/scripts/neconyan-native-workspaces.js');
        expect(typeof nativeWorkspaces.mountNeconyanCharacterWorkspace).toBe('function');
        expect(typeof nativeWorkspaces.mountNeconyanModelWorkspace).toBe('function');
        expect(typeof nativeWorkspaces.mountNeconyanLorebookWorkspace).toBe('function');
    });
});
