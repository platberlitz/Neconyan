/* global document, window, localStorage */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

const readLocale = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

for (const [layout, viewport, hasTouch] of [
    ['desktop', { width: 1280, height: 900 }, false],
    ['phone', { width: 393, height: 852 }, true],
]) {
    // The test titles below are fixed; this description just distinguishes the two layouts.
    // eslint-disable-next-line playwright/valid-title
    test.describe(layout, () => {
        test.use({ viewport, hasTouch });
        test('panel headers, folder counts and included tools are shown in German', async ({ page }) => {
            const german = { ...await readLocale('../public/locales/de-de.json'), ...await readLocale('../public/locales/neconyan/de-de.json') };
            await page.addInitScript(() => localStorage.setItem('language', 'de-de'));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();

            const header = selector => page.locator(`#right-nav-panel > .sb-character-shell-header ${selector}`);
            const title = () => header('.sb-shell-title').evaluate(element => element.firstChild?.textContent?.trim());
            // The header copy is rewritten on every tab switch, after the page was first translated.
            for (const [tab, english] of [
                ['characters', ['Characters', 'Choose a character and start a little chat.']],
                ['persona', ['Persona', 'Edit your own persona here for roleplay and chats!']],
                ['characters', ['Characters', 'Choose a character and start a little chat.']],
            ]) {
                await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), tab);
                await expect.poll(title).toBe(german[english[0]]);
                await expect(header('.sb-shell-subtitle')).toHaveText(german[english[1]]);
            }

            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
            await expect(page.locator('.neconyan-lorebook-folder').filter({ hasText: german.Unfiled })).toHaveCount(1);
            await expect(page.locator('.neconyan-lorebook-folder').filter({ hasText: 'Unfiled' })).toHaveCount(0);

            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            await expect(page.locator('#ica--run-status')).toHaveText(german['No automatic agents enabled']);
            await expect(page.locator('.ica--card-pill--order').first()).toContainText('Reihenfolge');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            await expect(page.getByText(german['No Roleplay chat selected'], { exact: true })).toBeVisible();

            await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
            await page.waitForFunction(() => document.querySelector('.vectors_settings'));
            await page.evaluate(label => window.NeconyanExtensions.focusUnit(label), german.Vectorization);
            await expect(page.locator('.vectors_settings')).toBeVisible();
            await expect(page.locator('.vectors-title')).toHaveText(german['Find the relevant bits']);
            await expect(page.locator('[data-vectors-state]')).toHaveText(german['Retrieval is off. You can still index sources and try a search.']);
            await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Image Gen'));
            await expect(page.locator('#qig-settings')).toBeVisible();
            await expect(page.locator('#qig-status-meta')).toContainText(german['Review off']);
            await expect(page.locator('#qig-prompt-help')).toHaveText(german['Not used while Chat scene is selected; the selected chat messages become the scene.']);

            // Labels made of a phrase and a name are one translated phrase, written after the locale has loaded.
            const phrase = (key, name) => german[key].replace('${0}', german[name]);
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
            await page.evaluate(label => window.NeconyanExtensions.focusUnit(label), german.Vectorization);
            const vectorsHeader = page.locator('.vectors_settings > .inline-drawer > .inline-drawer-header');
            const vectorsIcon = vectorsHeader.locator('.inline-drawer-icon');
            await expect(vectorsHeader).toBeVisible();
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Collapse ${0}', 'Vectorization'));
            await vectorsHeader.evaluate(header => header.click());
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Expand ${0}', 'Vectorization'));
            await vectorsHeader.evaluate(header => header.click());
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Collapse ${0}', 'Vectorization'));
            await expect(vectorsHeader.locator('.sb-extension-unit-pin')).toHaveAttribute('aria-label', phrase('Pin ${0}', 'Vectorization'));
            await expect(vectorsHeader.locator('.sb-extension-unit-pin')).toHaveAttribute('title', phrase('Pin ${0}', 'Vectorization'));

            await page.evaluate(async () => {
                const { openTimeMachine } = await import('/scripts/extensions/third-party/Neconyan-Time-Machine/src/ui.js');
                void openTimeMachine();
            });
            await expect(page.locator('#sbctm-title')).toHaveText(german['Time Machine']);
            await expect(page.locator('.sbctm-actions button')).toHaveText(german['Snapshot everything now']);
            await expect(page.locator('.sbctm-detail > .sbctm-empty')).toHaveText(german['Pick something on the left to see its history.']);
            // Measure the actual phone popup rather than assuming it fits from its styles.
            const bounds = await page.locator('.sbctm').boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
        });
    });
}
