/* global window, document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', video: 'off' });
test.setTimeout(420000);

async function openAgents(page, reload = false) {
    if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    else await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 120000 });
    await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'), {}, { timeout: 120000 });
    await expect(page.locator('#ica--run-status')).not.toHaveText('Ready', { timeout: 45000 });
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
    await expect(page.locator('#ica--settings')).toBeVisible();
}

for (const width of [393, 1280]) {
    test.describe(`Agents preferences at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, isMobile: width === 393, hasTouch: width === 393, reducedMotion: 'reduce' });

        test('keeps Pinned, workspace and collapsed categories across reloads', async ({ page }, info) => {
            page.setDefaultTimeout(15000);
            // Always return the old account settings, reproducing a reload before
            // the delayed settings save has reached the server.
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage ??= {};
                Object.assign(settings.accountStorage, {
                    'ica--workspace-view': 'manage',
                    'ica--agent-list-tab': 'all',
                    'ica--collapsed-categories': '[]',
                });
            });
            await openAgents(page);
            const id = `preferences-${width}-${Date.now()}`;
            await page.evaluate(async id => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const agent = store.createDefaultAgent();
                Object.assign(agent, { id, name: 'Preferences check', category: 'custom', favorite: true, prompt: 'Test' });
                await store.saveAgent(agent);
            }, id);
            try {
                const pinned = page.locator('#ica--agentTabs [data-tab="quick"]');
                const category = page.locator('.ica--category-header').filter({ has: page.locator('.ica--category-label', { hasText: /^Custom$/ }) });
                await pinned.click();
                await expect(category).toHaveAttribute('aria-expanded', 'true');
                await category.click();
                await page.locator('[data-workspace-view="connections"]').click();
                await openAgents(page, true);
                await expect(page.locator('#ica--workspaceSelect')).toHaveValue('connections');
                await page.locator('[data-workspace-view="manage"]').click();
                await expect(pinned).toHaveAttribute('aria-selected', 'true');
                await expect(page.locator('#ica--agentViewSelect')).toHaveValue('quick');
                await expect(category).toHaveAttribute('aria-expanded', 'false');
                await expect(page.locator(`[data-agent-id="${id}"]`)).toBeHidden();
                const collapsedItems = category.locator('..').locator('.ica--category-items');
                expect(await collapsedItems.evaluate(element => ({ display: getComputedStyle(element).display, height: element.getBoundingClientRect().height })))
                    .toEqual({ display: 'none', height: 0 });
                await category.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath(`preferences-collapsed-${width}.png`) });

                await category.click();
                await openAgents(page, true);
                await expect(category).toHaveAttribute('aria-expanded', 'true');
                await expect(page.locator(`[data-agent-id="${id}"]`)).toBeVisible();
            } finally {
                await page.evaluate(async id => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).deleteAgent(id), id);
            }
        });
    });
}
