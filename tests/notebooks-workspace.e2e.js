/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { openWorkspace } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block', hasTouch: true });
test.setTimeout(120000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`Notes sidebar selection follows open, beside chat and close at ${viewport.width}px`, async ({ page }, info) => {
        await page.setViewportSize(viewport);
        await openWorkspace(page);
        const phone = viewport.width <= 768;
        if (phone) await page.locator('#sb-hamburger').click();
        const notes = page.locator('#neconyan-workspace-rail [data-neconyan-route="notes"]');
        await notes.click();
        await expect(page.locator('#neconyan-notes')).toBeVisible();
        await expect(notes).toHaveAttribute('aria-current', 'page');
        if (phone) await page.locator('#sb-hamburger').click();
        const geometry = await notes.evaluate(element => {
            const box = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            return { width: box.width, height: box.height, background: styles.backgroundColor, colour: styles.color };
        });
        if (phone) expect(geometry.height).toBeGreaterThanOrEqual(44);
        expect(geometry.background).not.toBe(await page.locator('#neconyan-workspace-rail [data-neconyan-route="home"]').evaluate(element => getComputedStyle(element).backgroundColor));
        await info.attach('Notes selection geometry', { body: JSON.stringify({ viewport, ...geometry }), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('notes-selected.png') });
        if (phone) await page.locator('#sb-hamburger').click();
        if (!phone) {
            await page.getByRole('button', { name: 'Show notes beside the chat', exact: true }).click();
            await expect(notes).toHaveAttribute('aria-current', 'page');
            await page.locator('#neconyan-workspace-rail [data-neconyan-route="model"]').click();
            await expect(page.locator('#neconyan-notes')).toBeVisible();
            await expect(notes).toHaveAttribute('aria-current', 'page');
            await page.getByRole('button', { name: 'Close Connections', exact: true }).click();
        }
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(page.locator('#neconyan-notes')).toBeHidden();
        await expect(notes).not.toHaveAttribute('aria-current', 'page');
        // Direct opens (including Save to note) use the same selection path.
        await page.evaluate(() => window.NeconyanNotes.open({ layout: 'full' }));
        await expect(notes).toHaveAttribute('aria-current', 'page');
        if (phone) await page.locator('#sb-hamburger').click();
        await page.locator('#neconyan-workspace-rail [data-neconyan-route="home"]').click();
        await expect(page.locator('#neconyan-notes')).toBeHidden();
        await expect(notes).not.toHaveAttribute('aria-current', 'page');
    });
}
