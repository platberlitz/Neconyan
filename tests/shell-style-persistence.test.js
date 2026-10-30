import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const implementation = source.slice(source.indexOf('// An explicit selection made before account settings arrive'), source.indexOf('function isKittylessActive()'));
const powerUserSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hydrationStart = powerUserSource.indexOf('export async function loadPowerUserSettings(');
const hydrationEnd = powerUserSource.indexOf('    power_user.reply_generation_location =', hydrationStart);
const hydrationPrefix = `${powerUserSource.slice(hydrationStart, hydrationEnd).replace('export async function', 'async function')}\n}`;

function createHarness(options = {}) {
    const { saved = null, local = null, owner = null, ready = true, user = null, writable = true } = options;
    const storage = new Map();
    if (local !== null) storage.set('sb-theme', local);
    if (owner !== null) storage.set('sb-theme-account', owner);
    const writes = [];
    const context = {
        NN_THEMES: [{ id: 'calico' }, { id: 'windows-aero' }, { id: 'kittyless' }],
        NN_STORAGE_KEYS: { theme: 'sb-theme', themeAccount: 'sb-theme-account' },
        power_user: Object.hasOwn(options, 'saved') && options.saved === undefined ? {} : { neconyan_shell_style: saved },
        settingsReady: ready,
        currentUser: user,
        getCurrentUserHandle: () => context.currentUser?.handle || 'default-user',
        nnState: { theme: 'calico' },
        document: { documentElement: { dataset: {} } },
        normalizeTheme: value => ['calico', 'windows-aero', 'kittyless'].includes(value) ? value : 'calico',
        safeGetItem: key => storage.get(key) ?? null,
        safeSetItem: (key, value) => { if (writable) storage.set(key, value); },
        safeRemoveItem: key => { if (writable) storage.delete(key); },
        flushNnStorageWrites: () => {},
        saveSettingsDebounced: () => writes.push(context.power_user.neconyan_shell_style),
        syncShellStyleStylesheet: () => {}, syncKittylessStylesheet: () => {},
        updateThemePickerUi: () => {}, updateThemeBadge: () => {}, syncShellStyleAssistantArt: () => {},
    };
    vm.createContext(context);
    vm.runInContext(implementation, context);
    return { context, storage, writes };
}

describe('Shell Style account persistence', () => {
    test('explicit selections save to account settings even if browser writes fail', () => {
        const { context, writes } = createHarness({ writable: false });
        context.setShellTheme('windows-aero');
        expect(context.power_user.neconyan_shell_style).toBe('windows-aero');
        expect(context.document.documentElement.dataset.sbTheme).toBe('windows-aero');
        expect(writes).toEqual(['windows-aero']);
        context.setShellTheme('calico');
        expect(writes).toEqual(['windows-aero', 'calico']);
    });

    test.each([null, undefined])('migrates valid legacy choice once when preference is %s', saved => {
        const { context, storage, writes } = createHarness({ saved, local: 'kittyless' });
        expect(Object.hasOwn(context.power_user, 'neconyan_shell_style')).toBe(saved !== undefined);
        context.reconcileShellThemeSettings();
        context.reconcileShellThemeSettings();
        expect(context.power_user.neconyan_shell_style).toBe('kittyless');
        expect(storage.get('sb-theme-account')).toBe('default-user');
        expect(writes).toEqual(['kittyless']);
    });

    test.each([null, 'unknown'])('does not save provisional Calico for local value %s', local => {
        const { context, writes } = createHarness({ local });
        context.reconcileShellThemeSettings();
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('calico');
        expect(context.power_user.neconyan_shell_style).toBeNull();
        expect(writes).toEqual([]);
    });

    test('does not migrate a mirror labelled for another account', () => {
        const { context, writes } = createHarness({ local: 'kittyless', owner: 'other', user: { handle: 'peter' } });
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('calico');
        expect(writes).toEqual([]);
    });

    test.each(['calico', 'windows-aero'])('server value %s overrides a conflicting mirror', saved => {
        const { context, storage, writes } = createHarness({ saved, local: 'kittyless' });
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe(saved);
        expect(storage.get('sb-theme')).toBe(saved);
        expect(writes).toEqual([]);
    });

    test.each([42, {}, 'unknown'])('malformed present value %p does not revive local style', saved => {
        const { context, writes } = createHarness({ saved, local: 'kittyless' });
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('calico');
        expect(writes).toEqual([]);
    });

    test('early choice before identity survives hydration into the first established account', () => {
        const { context, writes } = createHarness({ saved: 'calico', ready: false });
        context.setShellTheme('kittyless');
        expect(writes).toEqual([]);
        context.currentUser = { handle: 'peter' };
        context.power_user.neconyan_shell_style = 'windows-aero';
        context.settingsReady = true;
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('kittyless');
        expect(writes).toEqual(['kittyless']);
    });

    test('early choice owned by a different established account is discarded', () => {
        const { context, writes } = createHarness({ ready: false, user: { handle: 'first' } });
        context.setShellTheme('kittyless');
        context.currentUser = { handle: 'second' };
        context.power_user.neconyan_shell_style = null;
        context.settingsReady = true;
        context.reconcileShellThemeSettings();
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('calico');
        expect(writes).toEqual([]);
    });

    test('early choice owned by the same established account survives hydration', () => {
        const { context, writes } = createHarness({ ready: false, user: { handle: 'peter' } });
        context.setShellTheme('kittyless');
        context.power_user.neconyan_shell_style = 'windows-aero';
        context.settingsReady = true;
        context.reconcileShellThemeSettings();
        expect(context.nnState.theme).toBe('kittyless');
        expect(writes).toEqual(['kittyless']);
    });

    test('power-user hydration clears a previous account preference when the new field is absent', async () => {
        const context = {
            power_user: { neconyan_shell_style: 'kittyless', stscript: {} },
            customThemeStyleEntries: {},
            accessibleTheme: () => ({}),
            chat_styles: { DOCUMENT: 2 },
            tag_sort_mode: { ALPHABETICAL: 1, MANUAL: 0 },
        };
        vm.createContext(context);
        vm.runInContext(hydrationPrefix, context);
        await context.loadPowerUserSettings({ power_user: {} }, {});
        expect(context.power_user.neconyan_shell_style).toBeNull();
        await context.loadPowerUserSettings({ power_user: { neconyan_shell_style: 'windows-aero' } }, {});
        expect(context.power_user.neconyan_shell_style).toBe('windows-aero');
        await context.loadPowerUserSettings({}, {});
        expect(context.power_user.neconyan_shell_style).toBeNull();
    });
});
