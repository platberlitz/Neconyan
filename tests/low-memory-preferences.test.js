import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, str, idx) => acc + str + (values[idx] !== undefined ? values[idx] : ''), ''),
}));

const {
    LOW_MEMORY_MANAGED_KEYS,
    LOW_MEMORY_PREFERENCES_VERSION,
    LOW_MEMORY_SHIPPED_DEFAULTS,
    createDefaultLowMemoryPreferences,
    initializeLowMemoryPreferences,
    releaseLowMemoryPreferencesToAutomatic,
    resolveLowMemoryPreferences,
    setLowMemoryManagedSetting,
    withLowMemoryControlHydration,
} = await import('../public/scripts/low-memory-mode.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('low-memory preference provenance and resolution', () => {
    test('ships the empty version-1 marker in default/content/settings.json and leaves fresh accounts automatic', () => {
        const template = JSON.parse(readFileSync(path.join(repoRoot, 'default', 'content', 'settings.json'), 'utf8'));
        expect(template.power_user.fast_ui_mode).toBe(false);
        expect(template.power_user.low_memory_preferences).toEqual({
            version: 1,
            explicit: {},
        });

        const target = {
            ...LOW_MEMORY_SHIPPED_DEFAULTS,
            ...template.power_user,
        };
        const needsSave = initializeLowMemoryPreferences(target, template.power_user);
        expect(needsSave).toBe(false);
        expect(target.low_memory_preferences).toEqual({
            version: LOW_MEMORY_PREFERENCES_VERSION,
            explicit: {},
        });

        const policy = resolveLowMemoryPreferences(target, target.low_memory_preferences, true);
        expect(policy.fast_ui_mode).toBe(true);
        expect(policy.roleplayWindowSize).toBe(25);
        expect(policy.roleplayMaxWindowSize).toBe(25);
        expect(policy.roleplayFixedWindow).toBe(true);
        expect(policy.conversationWindowSize).toBe(25);
        expect(policy.appliedKeys).toEqual(['fast_ui_mode', 'chat_truncation']);
        expect(policy.preservedKeys).toEqual([]);
    });

    test('migrates existing accounts without the marker by treating default-equal values as not explicit and differing values as explicit', () => {
        const legacyDefaultSaved = {
            fast_ui_mode: false,
            chat_truncation: 100,
            aggressive_dom_unload: false,
            aggressive_dom_window_size: 5,
        };
        const legacyDefaultTarget = { ...legacyDefaultSaved };
        expect(initializeLowMemoryPreferences(legacyDefaultTarget, legacyDefaultSaved)).toBe(true);
        expect(legacyDefaultTarget.low_memory_preferences).toEqual({
            version: 1,
            explicit: {},
        });

        const activeDefaultPolicy = resolveLowMemoryPreferences(legacyDefaultTarget, undefined, true);
        expect(activeDefaultPolicy.fast_ui_mode).toBe(true);
        expect(activeDefaultPolicy.roleplayWindowSize).toBe(25);
        expect(activeDefaultPolicy.appliedKeys).toEqual(['fast_ui_mode', 'chat_truncation']);
        expect(activeDefaultPolicy.preservedKeys).toEqual([]);

        const legacyCustomSaved = {
            fast_ui_mode: false,
            chat_truncation: 60,
            aggressive_dom_unload: false,
            aggressive_dom_window_size: 5,
        };
        const legacyCustomTarget = { ...legacyCustomSaved };
        expect(initializeLowMemoryPreferences(legacyCustomTarget, legacyCustomSaved)).toBe(true);
        expect(legacyCustomTarget.low_memory_preferences).toEqual({
            version: 1,
            explicit: {
                chat_truncation: true,
            },
        });

        const activeCustomPolicy = resolveLowMemoryPreferences(legacyCustomTarget, undefined, true);
        expect(activeCustomPolicy.fast_ui_mode).toBe(true);
        expect(activeCustomPolicy.roleplayWindowSize).toBe(60);
        expect(activeCustomPolicy.roleplayMaxWindowSize).toBe(200);
        expect(activeCustomPolicy.roleplayFixedWindow).toBe(false);
        expect(activeCustomPolicy.appliedKeys).toEqual(['fast_ui_mode']);
        expect(activeCustomPolicy.preservedKeys).toEqual(['chat_truncation']);
    });

    test('handles partial old settings and malformed or future markers conservatively', () => {
        const partialSaved = {
            chat_truncation: 40,
        };
        const partialTarget = { ...LOW_MEMORY_SHIPPED_DEFAULTS, ...partialSaved };
        expect(initializeLowMemoryPreferences(partialTarget, partialSaved)).toBe(true);
        expect(partialTarget.low_memory_preferences).toEqual({
            version: 1,
            explicit: {
                chat_truncation: true,
            },
        });

        for (const malformedMarker of [
            null,
            'v1',
            [],
            { version: 2, explicit: {} },
            { version: 1, explicit: null },
            { version: 1, explicit: [] },
        ]) {
            const saved = {
                fast_ui_mode: false,
                chat_truncation: 80,
                low_memory_preferences: malformedMarker,
            };
            const target = { ...LOW_MEMORY_SHIPPED_DEFAULTS, ...saved };
            expect(initializeLowMemoryPreferences(target, saved)).toBe(true);
            expect(target.low_memory_preferences).toEqual({
                version: 1,
                explicit: {
                    chat_truncation: true,
                },
            });
        }

        const dirtyMarkerSaved = {
            fast_ui_mode: false,
            chat_truncation: 100,
            low_memory_preferences: {
                version: 1,
                explicit: {
                    fast_ui_mode: true,
                    unknown_setting: true,
                    chat_truncation: 'yes',
                },
            },
        };
        const dirtyTarget = { ...LOW_MEMORY_SHIPPED_DEFAULTS, ...dirtyMarkerSaved };
        expect(initializeLowMemoryPreferences(dirtyTarget, dirtyMarkerSaved)).toBe(true);
        expect(dirtyTarget.low_memory_preferences).toEqual({
            version: 1,
            explicit: {
                fast_ui_mode: true,
            },
        });
    });

    test('honours explicit false for No Blur when the version-1 marker records it', () => {
        const saved = {
            fast_ui_mode: false,
            chat_truncation: 100,
            aggressive_dom_unload: false,
            aggressive_dom_window_size: 5,
            low_memory_preferences: {
                version: 1,
                explicit: {
                    fast_ui_mode: true,
                },
            },
        };
        const target = { ...saved };
        expect(initializeLowMemoryPreferences(target, saved)).toBe(false);

        const policy = resolveLowMemoryPreferences(target, undefined, true);
        expect(policy.fast_ui_mode).toBe(false);
        expect(policy.fastUiApplied).toBe(false);
        expect(policy.fastUiPreserved).toBe(true);
        expect(policy.roleplayWindowSize).toBe(25);
        expect(policy.appliedKeys).toEqual(['chat_truncation']);
        expect(policy.preservedKeys).toEqual(['fast_ui_mode']);
    });

    test('keeps saved base values untouched across repeated Auto, On and Off transitions and serialisation', () => {
        const saved = {
            fast_ui_mode: false,
            chat_truncation: 100,
            aggressive_dom_unload: false,
            aggressive_dom_window_size: 5,
            low_memory_preferences: createDefaultLowMemoryPreferences(),
        };
        const target = JSON.parse(JSON.stringify(saved));
        initializeLowMemoryPreferences(target, saved);

        const activeOne = resolveLowMemoryPreferences(target, undefined, true);
        expect(activeOne.fast_ui_mode).toBe(true);
        expect(activeOne.roleplayWindowSize).toBe(25);

        const inactive = resolveLowMemoryPreferences(target, undefined, false);
        expect(inactive.fast_ui_mode).toBe(false);
        expect(inactive.roleplayWindowSize).toBe(100);
        expect(inactive.conversationWindowSize).toBe(200);

        const activeTwo = resolveLowMemoryPreferences(target, undefined, true);
        expect(activeTwo.fast_ui_mode).toBe(true);
        expect(activeTwo.roleplayWindowSize).toBe(25);

        for (const key of LOW_MEMORY_MANAGED_KEYS) {
            expect(target[key]).toBe(saved[key]);
        }
        expect(JSON.parse(JSON.stringify(target))).toEqual(saved);
    });

    test('records deliberate edits during active mode even when choosing the original default value, while ignoring hydration', () => {
        const target = {
            ...LOW_MEMORY_SHIPPED_DEFAULTS,
            low_memory_preferences: createDefaultLowMemoryPreferences(),
        };
        initializeLowMemoryPreferences(target, target);

        withLowMemoryControlHydration(() => {
            setLowMemoryManagedSetting(target, 'fast_ui_mode', false);
            setLowMemoryManagedSetting(target, 'chat_truncation', 100);
        });
        expect(target.low_memory_preferences.explicit).toEqual({});

        // Deliberately choosing the original default values during active mode marks them explicit.
        setLowMemoryManagedSetting(target, 'fast_ui_mode', false);
        setLowMemoryManagedSetting(target, 'chat_truncation', 100);
        expect(target.low_memory_preferences.explicit).toEqual({
            fast_ui_mode: true,
            chat_truncation: true,
        });

        const policyWhileActive = resolveLowMemoryPreferences(target, undefined, true);
        expect(policyWhileActive.fast_ui_mode).toBe(false);
        expect(policyWhileActive.roleplayWindowSize).toBe(100);
        expect(policyWhileActive.appliedKeys).toEqual([]);
        expect(policyWhileActive.preservedKeys).toEqual(['fast_ui_mode', 'chat_truncation']);

        // Reloading the serialized settings preserves the explicit default choices.
        const serialized = JSON.parse(JSON.stringify(target));
        const reloaded = { ...serialized };
        expect(initializeLowMemoryPreferences(reloaded, serialized)).toBe(false);
        const reloadedPolicy = resolveLowMemoryPreferences(reloaded, undefined, true);
        expect(reloadedPolicy.fast_ui_mode).toBe(false);
        expect(reloadedPolicy.roleplayWindowSize).toBe(100);
    });

    test('conservatively stops managing a setting when an external caller mutates the base value directly', () => {
        const target = {
            ...LOW_MEMORY_SHIPPED_DEFAULTS,
            low_memory_preferences: createDefaultLowMemoryPreferences(),
        };
        initializeLowMemoryPreferences(target, target);

        // External write bypassing setLowMemoryManagedSetting:
        target.chat_truncation = 50;

        const policy = resolveLowMemoryPreferences(target, undefined, true);
        expect(policy.roleplayWindowSize).toBe(50);
        expect(policy.roleplayFixedWindow).toBe(false);
        expect(policy.preservedKeys).toEqual(['chat_truncation']);
        expect(target.chat_truncation).toBe(50);
        expect(target.low_memory_preferences.explicit.chat_truncation).toBe(true);
    });

    test('releases explicit flags to automatic recommendations without erasing saved base values', () => {
        const target = {
            ...LOW_MEMORY_SHIPPED_DEFAULTS,
            low_memory_preferences: createDefaultLowMemoryPreferences(),
        };
        initializeLowMemoryPreferences(target, target);
        setLowMemoryManagedSetting(target, 'chat_truncation', 80);
        setLowMemoryManagedSetting(target, 'fast_ui_mode', false);

        releaseLowMemoryPreferencesToAutomatic(target);
        expect(target.low_memory_preferences).toEqual({
            version: 1,
            explicit: {},
        });
        expect(target.chat_truncation).toBe(80);
        expect(target.fast_ui_mode).toBe(false);

        const activePolicy = resolveLowMemoryPreferences(target, undefined, true);
        expect(activePolicy.fast_ui_mode).toBe(true);
        expect(activePolicy.roleplayWindowSize).toBe(25);

        const offPolicy = resolveLowMemoryPreferences(target, undefined, false);
        expect(offPolicy.fast_ui_mode).toBe(false);
        expect(offPolicy.roleplayWindowSize).toBe(80);
    });

    test('rebuilds provenance on account switch or legacy settings import without keeping previous account flags', () => {
        const sharedPowerUser = {
            ...LOW_MEMORY_SHIPPED_DEFAULTS,
            low_memory_preferences: createDefaultLowMemoryPreferences(),
        };
        initializeLowMemoryPreferences(sharedPowerUser, sharedPowerUser);
        setLowMemoryManagedSetting(sharedPowerUser, 'fast_ui_mode', false);
        setLowMemoryManagedSetting(sharedPowerUser, 'chat_truncation', 70);
        expect(sharedPowerUser.low_memory_preferences.explicit).toEqual({
            fast_ui_mode: true,
            chat_truncation: true,
        });

        // Importing legacy settings without marker into an account that already had the marker:
        const importedLegacy = {
            fast_ui_mode: false,
            chat_truncation: 100,
        };
        Object.assign(sharedPowerUser, importedLegacy);
        expect(initializeLowMemoryPreferences(sharedPowerUser, importedLegacy)).toBe(true);
        expect(sharedPowerUser.low_memory_preferences).toEqual({
            version: 1,
            explicit: {},
        });

        const policyAfterImport = resolveLowMemoryPreferences(sharedPowerUser, undefined, true);
        expect(policyAfterImport.fast_ui_mode).toBe(true);
        expect(policyAfterImport.roleplayWindowSize).toBe(25);
    });
});
