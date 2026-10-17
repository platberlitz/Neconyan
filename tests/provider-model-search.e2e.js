/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.setTimeout(120000);

const models = Array.from({ length: 120 }, (_, index) => ({
    id: `${index < 60 ? 'atlas' : 'zenith'}/catalogue-${String(index).padStart(3, '0')}`,
    name: `Catalogue ${String(index).padStart(3, '0')}`,
    context_length: 128000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    capabilities: { tool_calling: true },
}));

for (const source of ['nanogpt', 'openrouter']) {
    for (const width of [393, 1280]) {
        test(`${source} lists its complete catalogue at ${width}px`, async ({ browser }, info) => {
            const context = await browser.newContext({
                viewport: { width, height: width === 393 ? 852 : 900 },
                hasTouch: width === 393, serviceWorkers: 'block', reducedMotion: 'reduce',
            });
            const page = await context.newPage();
            try {
                await isolateSettingsSaves(page, settings => {
                    settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
                    settings.main_api = 'openai';
                    settings.oai_settings = {
                        ...settings.oai_settings, chat_completion_source: source,
                        [`${source}_model`]: models[0].id, openrouter_group_models: true,
                    };
                });
                await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: models } }));
                await page.route('**/api/nanogpt/**', route => route.fulfill({ json: { supportsProviderSelection: false, providers: [], balance: 0, credits: 0 } }));
                await page.route('**/api/openrouter/**', route => route.fulfill({ json: { data: [] } }));
                await page.goto('/');
                await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
                await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
                await page.locator(`#api_key_${source}`).fill('browser-catalogue-test-not-a-real-key');
                await page.locator('#api_button_openai').click();

                const selectId = `model_${source}_select`;
                const results = page.locator(`#${selectId}_results`);
                const rows = results.locator('.nn-model-list-option');
                const search = page.locator(`#${selectId}_search`);
                const status = page.locator(`[data-model-list-for="${selectId}"] [role="status"]`);
                const count = models.length + (source === 'openrouter' ? 1 : 0);
                await expect(page.locator(`#${selectId} option`)).toHaveCount(count);
                await search.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath('catalogue.png') });
                await info.attach('catalogue', { path: info.outputPath('catalogue.png'), contentType: 'image/png' });
                await expect(rows).toHaveCount(count);
                await expect(status).toHaveText(`${count} of ${count} models`);
                await expect(results.locator('.nn-model-list-group')).toHaveText(source === 'openrouter' ? ['atlas', 'zenith'] : ['Catalogue']);
                if (source === 'openrouter') await expect(rows.first()).toHaveAttribute('data-model-id', 'OR_Website');

                // Scroll to an ordinary model beyond row 50, without entering a search.
                const last = results.locator(`[data-model-id="${models.at(-1).id}"]`);
                await last.scrollIntoViewIfNeeded();
                expect(await results.evaluate(element => element.scrollTop > 0)).toBe(true);
                await last.click();
                await expect(last).toHaveAttribute('aria-pressed', 'true');
                await expect(search).toHaveValue('');
                await expect(search).not.toBeFocused();
                await expect.poll(() => page.evaluate(async source => (await import('/scripts/openai.js')).oai_settings[`${source}_model`], source)).toBe(models.at(-1).id);
                expect(await last.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
                expect(await results.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                await last.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath('last-model-selected.png') });
                await info.attach('last-model-selected', { path: info.outputPath('last-model-selected.png'), contentType: 'image/png' });

                // Broad searches must also show every match, including entire later groups.
                await search.fill('catalogue');
                await expect(rows).toHaveCount(models.length);
                await expect(status).toHaveText(`${models.length} of ${count} models`);
                await search.fill('ZENITH catalogue-119');
                await expect(rows).toHaveCount(1);
                await expect(rows.first()).toHaveAttribute('data-model-id', models.at(-1).id);
                await search.press('Escape');
                await expect(rows).toHaveCount(count);
                await expect(last).toHaveAttribute('aria-pressed', 'true');
            } finally {
                await context.close();
            }
        });
    }
}
