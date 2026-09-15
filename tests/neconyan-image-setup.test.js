import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const startup = source.match(/if \(!initSettings\.setupWizardSeen[^]*?\n {12}}/)[0];

function runtime(neconyan) {
    const settings = { setupWizardSeen: false, paletteMode: 'direct' };
    const calls = { popups: 0, saves: 0, generations: 0 };
    const context = vm.createContext({
        document: { body: { classList: { contains: name => neconyan && name === 'neconyan' } } },
        getSettings: () => settings,
        initSettings: settings,
        PROVIDERS: {},
        STYLES: {},
        buildOptions: () => '',
        createPopup: () => { calls.popups++; },
        saveSettingsDebounced: () => { calls.saves++; },
        normalizePaletteMode: value => value,
        generateImage: () => { calls.generations++; return 'generated'; },
        generateImageInjectPalette: () => 'injected',
    });
    vm.runInContext([
        functionSource('showSetupWizardOnFirstUse'),
        functionSource('showSetupWizard'),
        functionSource('runConfiguredPaletteGeneration'),
    ].join('\n'), context);
    return { context, settings, calls };
}

describe('Neconyan image setup', () => {
    test('leaves Home clear and introduces setup on the first image action', () => {
        const state = runtime(true);
        vm.runInContext(startup, state.context);
        expect(state.calls.popups).toBe(0);
        expect(state.settings.setupWizardSeen).toBe(false);

        expect(state.context.showSetupWizardOnFirstUse()).toBe(true);
        expect(state.settings.setupWizardSeen).toBe(true);
        expect(state.calls).toEqual({ popups: 1, saves: 1, generations: 0 });
        expect(state.context.showSetupWizardOnFirstUse()).toBe(false);
    });

    test('retains the original startup wizard on other hosts', () => {
        const state = runtime(false);
        vm.runInContext(startup, state.context);
        expect(state.calls.popups).toBe(1);
        expect(state.settings.setupWizardSeen).toBe(true);
    });

    test('does not intercept the programmatic generation API', () => {
        const state = runtime(true);
        expect(state.context.runConfiguredPaletteGeneration()).toBe('generated');
        expect(state.calls).toEqual({ popups: 0, saves: 0, generations: 1 });
    });
});
