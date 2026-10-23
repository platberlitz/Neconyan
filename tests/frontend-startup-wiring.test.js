import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const welcomeSource = read('public', 'scripts', 'welcome-screen.js');
const openaiSource = read('public', 'scripts', 'openai.js');
const modelListSource = read('public', 'scripts', 'model-list-search.js');
const naiSettingsSource = read('public', 'scripts', 'nai-settings.js');

function welcomeFunction(name) {
    return welcomeSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
}

describe('desktop startup wiring', () => {
    test('creates rail sortables on the first reorder gesture, not at startup', () => {
        const initialize = welcomeFunction('initializeNeconyanRailOrder');
        const apply = welcomeFunction('applyNeconyanRailOrder');

        expect(initialize).toMatch(/const ensureSortable = \(\) => \{[\s\S]*?\$\(target\.host\)\.sortable\(\{/);
        // Sections share buttons, so every drop target is built in the same gesture; Modes stays on its own.
        expect(initialize).toMatch(/connectWith: isFixed\(name\) \? false : '\[data-neconyan-rail-group\]:not\(\[data-neconyan-rail-group="modes"\], \[hidden\]\)'/);
        expect(initialize).toMatch(/host\.addEventListener\('pointerdown', ensureSortableFromGrip, true\)/);
        expect(initialize).toMatch(/host\.addEventListener\('mousedown', ensureSortableFromGrip, true\)/);
        expect(initialize).toMatch(/host\.addEventListener\('touchstart', ensureSortableFromGrip, \{ capture: true, passive: true \}\)/);
        expect(initialize).toMatch(/group\.sortableReady = true/);
        expect(apply).toMatch(/group\?\.sortableReady/);
        expect(welcomeFunction('initializeNeconyanRailOrder')).toMatch(/\['ArrowUp', 'ArrowDown'\]\.includes\(event\.key\)/);
    });

    test('disconnects the body-wide inline picker observer once the eight selects are bound', () => {
        const bind = openaiSource.match(/^function bindInlineSelectPickerControls\([\s\S]*?^}/m)?.[0] ?? '';

        expect(bind).toMatch(/inlineSelectPickerTargetsBound\(\)/);
        expect(bind).toMatch(/inlineSelectPickerBodyObserver\?\.disconnect\(\)/);
        expect(bind).toMatch(/observeInlineSelectPickerReplacements\(\)/);
        expect(openaiSource).toMatch(/const container = document\.getElementById\('left-nav-panel'\) \?\? document\.getElementById\('openai_settings'\)/);
    });

    test('binds model list value changes from events instead of a poll', () => {
        expect(modelListSource).not.toMatch(/setInterval\(/);
        expect(modelListSource).toMatch(/on\('change input', syncPressed\)/);
        expect(modelListSource).toMatch(/addEventListener\('focusin', syncPressed\)/);
        expect(modelListSource).toMatch(/addEventListener\('pointerdown', syncPressed/);
        expect(modelListSource).toMatch(/export function syncModelListSearchValue/);
        expect(openaiSource).toMatch(/syncModelListSearchValue\(document\.querySelector\('#model_claude_select'\)\)/);
        expect(openaiSource).toMatch(/for \(const selector of MODEL_LIST_SEARCH_SELECTS\) \{\s*syncModelListSearchValue\(document\.querySelector\(selector\)\)/);
        expect(openaiSource).toMatch(/syncModelListSearchValue\(document\.querySelector\('#model_ai21_select'\)\)/);
        expect(openaiSource).toMatch(/syncModelListSearchValue\(document\.querySelector\('#model_custom_select'\)\)/);
        expect(openaiSource).toMatch(/syncModelListSearchValue\(document\.querySelector\(selector\)\)/);
        expect(naiSettingsSource).toMatch(/syncModelListSearchValue\(document\.querySelector\('#model_novel_select'\)\)/);
    });

    test('shares only an in-flight recent request and fetches fresh afterwards', () => {
        expect(welcomeSource).toMatch(/let recentChatsInFlight = null/);
        expect(welcomeSource).not.toMatch(/recentChatsDataCache/);
        expect(welcomeSource).not.toMatch(/recentChatsGeneration/);
        expect(welcomeSource).toMatch(/function invalidateRecentChats\(\) \{\s*recentChatsInFlight = null;/);
        expect(welcomeSource).toMatch(/function requestRecentChatsData\(settings, requestKey\) \{\s*const inFlight = recentChatsInFlight;/);
        expect(welcomeSource).toMatch(/function scheduleNeconyanRailRefresh\(\{ invalidate = true \} = \{\}\) \{\s*if \(invalidate\) \{\s*invalidateRecentChats\(\);/);
        expect(welcomeSource).toMatch(/export async function openWelcomeScreen\([^)]*\) \{\s*if \(force\) \{[\s\S]{0,200}?invalidateRecentChats\(\)/);
        expect(welcomeSource).toMatch(/eventSource\.makeFirst\(event_types\.CHAT_CHANGED, async \(\.\.\.args\) => \{\s*invalidateRecentChats\(\);\s*await openWelcomeScreen\(\.\.\.args\);/);
        expect(welcomeSource).toMatch(/createForegroundRefreshCoalescer\(\{/);
        expect(welcomeSource).toMatch(/window\.addEventListener\('pageshow', requestForegroundRefresh/);
        expect(welcomeSource).not.toMatch(/VALUE_CHECK_MS/);
    });
});
