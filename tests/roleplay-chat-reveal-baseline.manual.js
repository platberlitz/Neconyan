/* eslint-env browser */
/**
 * Manual diagnostic only. This file is deliberately outside the release
 * `*.e2e.js` discovery.
 *
 * Run:
 *   NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 npx playwright test roleplay-chat-reveal-baseline.manual.js \
 *     --config=tests/playwright.roleplay-reveal-baseline.config.js --reporter=line --workers=1
 *
 * It reconstructs the pre-fix source from the current checkout, so it depends
 * on the exact source text below. If that text moves, read the diff and update
 * the reconstruction; never add this file to release discovery.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { runSoloSwitch, screenshotsDir, VIEWPORTS } from './roleplay-chat-reveal-support.js';

test.setTimeout(240000);

const manualVideosDir = path.join(screenshotsDir, 'videos', 'manual-baseline');

function patchedBaselineSources() {
    const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    let scriptPatched = scriptSource
        .replace(
            'import { finishUiMotion, getUiDrawerEdge, getUiSlideOptions, isUiClosing, revealChat, revealUi, setUiVisibility, slideSwipe } from \'./scripts/ui-motion.js\';',
            'import { finishUiMotion, getUiDrawerEdge, getUiSlideOptions, isUiClosing, revealUi, setUiVisibility, slideSwipe } from \'./scripts/ui-motion.js\';',
        )
        .replace('export async function printMessages({ reveal = false } = {}) {', 'export async function printMessages() {')
        .replace(/\n {4}\/\/ Start the arrival before the new messages are painted\.[\s\S]*?if \(reveal\) revealChat\(chatElement\[0\]\);\n/, '\n')
        .replaceAll('await printMessages({ reveal: true });', 'await printMessages();');
    expect(scriptPatched).not.toContain('if (reveal) revealChat(chatElement[0]);');
    expect(scriptPatched).toContain('export async function printMessages() {');

    let tabsPatched = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
        .replace(
            'import { finishUiMotion, getUiDrawerEdge, getUiSlideOptions, isUiClosing, revealUi, setUiVisibility } from \'./ui-motion.js\';',
            'import { finishUiMotion, getUiDrawerEdge, getUiSlideOptions, isUiClosing, revealChat, revealUi, setUiVisibility } from \'./ui-motion.js\';',
        )
        .replace(
            'nnState.initialized = true;',
            'nnState.initialized = true;\n    eventSource.on(event_types.CHAT_CHANGED, () => revealChat(document.getElementById(\'chat\')));',
        );
    expect(tabsPatched).toContain('eventSource.on(event_types.CHAT_CHANGED, () => revealChat(document.getElementById(\'chat\')));');

    const motionPatched = readFileSync(new URL('../public/scripts/ui-motion.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace('if (holdWhileBusy && isVisiblyPainted(element)) return;', '');
    expect(motionPatched).not.toContain('if (holdWhileBusy && isVisiblyPainted(element)) return;');
    return { scriptPatched, tabsPatched, motionPatched };
}

test.describe('Manual pre-fix diagnostic', () => {
    test('reconstructed pre-fix source still blanks on phone and desktop', async ({ app, browserName }) => {
        const baselineSources = patchedBaselineSources();
        mkdirSync(manualVideosDir, { recursive: true });
        for (const viewport of VIEWPORTS) {
            const { result } = await runSoloSwitch(app, {
                browserName,
                viewport,
                baseline: true,
                baselineSources,
                mediaDir: manualVideosDir,
                namePrefix: 'manual-',
            });
            expect(result.firstReadable).not.toBeNull();
            expect(result.hiddenIntervals.length).toBeGreaterThan(0);
            expect(result.opacityResets.length).toBeGreaterThan(0);
            expect(result.transparentAnimations.length).toBeGreaterThan(0);
        }
        expect(app.navigationErrors).toEqual([]);
    });
});
