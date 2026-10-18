/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';

function createRegistry() {
    const defs = new Map();
    return {
        defs,
        hasMacro: name => defs.has(String(name).toLowerCase()),
        getMacro: name => defs.get(String(name).toLowerCase()) ?? null,
        registerMacro: (name, options) => {
            const definition = {
                ...options,
                name,
                category: options.category,
                source: { name: 'MacroEnhanced' },
                aliases: options.aliases ?? [],
            };
            defs.set(String(name).toLowerCase(), definition);
            return definition;
        },
        unregisterMacro: name => {
            defs.delete(String(name).toLowerCase());
        },
        getAllMacros: () => [...defs.values()],
    };
}

function installContext(registry) {
    const customMacros = [{
        id: 'macro-1',
        name: 'greet',
        description: 'A greeting.',
        template: 'Hello {{user}}',
        args: [],
        enabled: true,
    }];
    const context = {
        extensionSettings: {
            MacroEnhanced: {
                settingsVersion: 5,
                customMacros,
                auditor: { manualCachingAtDepth: null },
                compatExpressions: false,
                fixImportedSyntax: false,
                pronouns: { personas: {} },
            },
        },
        chatId: 'chat-1',
        chatMetadata: {},
        characters: [],
        characterId: null,
        groupId: null,
        macros: {
            engine: { evaluate: jest.fn() },
            registry,
        },
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

describe('Macro Enhanced registration change notifications', () => {
    let dataEvents;
    let catalog;
    let registrar;
    let registry;

    beforeEach(async () => {
        jest.resetModules();
        registry = createRegistry();
        installContext(registry);
        dataEvents = await import(`${BASE}data-events.js`);
        catalog = await import(`${BASE}catalog.js`);
        registrar = await import(`${BASE}custom/registrar.js`);
    });

    test('announces after the macro is in the registry and catalogue', () => {
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push({
            kind,
            names: catalog.getMacroCatalog().map(entry => entry.name),
            registered: registry.defs.has('greet'),
        }));

        registrar.syncRegistrations();

        expect(registry.defs.has('greet')).toBe(true);
        expect(heard).toEqual([{ kind: 'macros', names: ['greet'], registered: true }]);
    });

    test('does not announce when the registration state did not change', () => {
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push(kind));
        registrar.syncRegistrations();
        heard.length = 0;

        registrar.syncRegistrations();

        expect(heard).toEqual([]);
    });

    test('announces removal after the catalogue forgets the macro', () => {
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push({
            kind,
            names: catalog.getMacroCatalog().map(entry => entry.name),
        }));
        registrar.syncRegistrations();
        heard.length = 0;

        globalThis.SillyTavern.getContext().extensionSettings.MacroEnhanced.customMacros = [];
        registrar.syncRegistrations();

        expect(registry.defs.has('greet')).toBe(false);
        expect(heard).toEqual([{ kind: 'macros', names: [] }]);
    });
});
