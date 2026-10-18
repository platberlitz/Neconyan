import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const welcomeSource = read('public', 'scripts', 'welcome-screen.js');
const openaiSource = read('public', 'scripts', 'openai.js');
const modelListSource = read('public', 'scripts', 'model-list-search.js');

function welcomeFunction(name) {
    return welcomeSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
}

describe('desktop startup wiring', () => {
    test('creates rail sortables on the first reorder gesture, not at startup', () => {
        const initialize = welcomeFunction('initializeNeconyanRailOrder');
        const apply = welcomeFunction('applyNeconyanRailOrder');

        expect(initialize).toMatch(/const ensureSortable = \(\) => \{[\s\S]*?\$\(host\)\.sortable\(\{/);
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
    });

    test('invalidates the shared recent-chat response on chat and pin changes', () => {
        expect(welcomeSource).toMatch(/let recentChatsDataCache = null/);
        expect(welcomeSource).toMatch(/function invalidateRecentChats\(\)/);
        expect(welcomeSource).toMatch(/private static #saveState|static #saveState\(state\) \{[\s\S]*?invalidateRecentChats\(\)/);
        expect(welcomeSource).toMatch(/event_types\.MESSAGE_RECEIVED/);
        expect(welcomeSource).toMatch(/event_types\.MESSAGE_SWIPE_DELETED/);
        expect(welcomeSource).toMatch(/event_types\.PERSONA_CHANGED/);
        expect(welcomeSource).toMatch(/sb:conversation-workspace-state-changed', 'neconyan:hopper-state-changed', 'neconyan:story-state-changed'\]\) \{\s*window\.addEventListener\(eventName, invalidateRecentChats\)/);
        expect(welcomeSource).toMatch(/async function refreshWelcomeScreen[\s\S]*?invalidateRecentChats\(\)/);
        expect(welcomeSource).not.toMatch(/VALUE_CHECK_MS/);
    });
});
