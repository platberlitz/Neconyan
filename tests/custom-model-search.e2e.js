/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

for (const width of [393, 1280]) {
    test(`custom model search only changes the chosen model on selection at ${width}px`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
                settings.main_api = 'openai';
                settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_model: 'aurora-chat', custom_url: 'https://models.invalid/v1' };
            });
            let models = [
                { id: 'aurora-chat', name: 'Aurora Chat' },
                { id: 'aurora-think', name: 'Aurora Reasoning' },
                { id: 'atlas-small', name: 'Atlas Small' },
                { id: 'vendor/atlas-large-with-a-very-long-model-id-that-must-wrap-on-phones', name: 'Atlas Large' },
            ];
            await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: models } }));
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('#api_button_openai').click();
            const search = page.locator('#custom_model_search');
            const results = page.locator('#custom-model-results');
            const chosen = () => page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.custom_model);
            await expect(results.locator('button')).toHaveCount(4);
            await search.fill('  AURORA reasoning ');
            await expect(results.locator('button')).toHaveCount(1);
            await expect(results.locator('button')).toContainText('aurora-think');
            expect(await chosen()).toBe('aurora-chat');
            await search.press('Tab');
            expect(await chosen()).toBe('aurora-chat');
            await results.locator('button').click();
            await expect.poll(chosen).toBe('aurora-think');
            // Picking a model must not move focus back to the search box (that raises the phone keyboard).
            await expect(search).not.toBeFocused();
            await expect(page.locator('#custom_model_id')).toHaveValue('aurora-think');
            await search.fill('unknown model');
            await expect(results.locator('button')).toHaveCount(0);
            await expect(page.locator('#custom-model-search [role="status"]')).toContainText('No models match');
            await search.press('Enter');
            expect(await chosen()).toBe('aurora-think');
            await search.press('Escape');
            await expect(search).toHaveValue('');
            await expect(search).toBeVisible();
            await search.fill('atlas');
            await search.press('ArrowDown');
            await expect(results.locator('button').first()).toBeFocused();
            await page.keyboard.press('Enter');
            await expect.poll(chosen).toBe('atlas-small');
            await expect(search).toHaveValue('atlas');

            // A completed catalogue refresh must retain the query and the chosen model.
            models = [...models, { id: 'atlas-new', name: 'Atlas New' }];
            await page.locator('#api_button_openai').click();
            await expect(results.locator('button')).toHaveCount(3);
            await expect(search).toHaveValue('atlas');
            expect(await chosen()).toBe('atlas-small');
            await page.getByRole('button', { name: 'Clear model search', exact: true }).click();
            await expect(results.locator('button')).toHaveCount(5);
            expect((await search.boundingBox()).height).toBeGreaterThanOrEqual(44);
            expect(await results.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            for (const button of await results.locator('button').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);

            // A manual ID remains valid even when the provider does not advertise it.
            await page.locator('#custom_model_id').fill('private/unlisted');
            await expect.poll(chosen).toBe('private/unlisted');
            await expect(results.locator('[aria-pressed="true"]')).toHaveAttribute('data-model-id', 'private/unlisted');
            await page.locator('[data-sb-model-id-favorite-source="custom"]').click();
            await expect(results.locator('[data-model-id="private/unlisted"]')).toContainText('Favourite');

            // Large catalogues stay bounded, and models beyond the first page are searchable.
            models = Array.from({ length: 80 }, (_, index) => ({ id: `catalogue-${index}`, name: `Catalogue ${index}` }));
            await page.locator('#api_button_openai').click();
            await expect(results.locator('button')).toHaveCount(50);
            await search.fill('catalogue-79');
            await expect(results.locator('button')).toHaveCount(1);
            await search.press('Enter');
            await expect.poll(chosen).toBe('catalogue-79');
        } finally {
            await context.close();
        }
    });
}
