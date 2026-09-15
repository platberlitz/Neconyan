/* global document, window */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent, trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: true });
test.setTimeout(120000);

const models = {
    nanogpt: [
        { id: 'openai/gpt-oss-20b', open_weights: true },
        { id: 'openai/gpt-4o', open_weights: true },
        { id: 'anthropic/claude-sonnet-5', open_weights: true },
    ],
    custom: [
        { id: 'local-unknown' },
        { id: 'local-typical', supported_parameters: ['temperature', 'top_p', 'typical_p'] },
    ],
};

async function fixture(page) {
    const { errors, navigate } = trackNavigationErrors(page);
    let settings, envelopePromise;
    const state = { statusSources: [], generationRequests: [], saved: null };
    await page.route(/https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.abort());
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => {
        state.generationRequests.push(route.request().url());
        return route.fulfill({ status: 503, json: { error: 'Local sampler UI check' } });
    });
    await page.route('**/api/settings/get', async route => {
        const envelope = await (envelopePromise ??= route.fetch().then(response => response.json()));
        if (!settings) {
            settings = JSON.parse(envelope.settings);
            settings.main_api = 'openai';
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            Object.assign(settings.oai_settings, {
                chat_completion_source: 'nanogpt', nanogpt_model: 'openai/gpt-oss-20b',
                custom_model: 'local-unknown', custom_url: 'http://127.0.0.1:9/v1',
                typical_p_openai: 1, reverse_proxy: '',
            });
            delete settings.oai_settings.model_sampler_metadata;
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        settings = JSON.parse(bytes.toString());
        settings._version = Math.max(Date.now(), Number(settings._version || 0) + 1);
        state.saved = settings;
        await route.fulfill({ json: { version: settings._version } });
    });
    await page.route('**/api/secrets/read', route => route.fulfill({ json: { api_key_nanogpt: true, api_key_openai: true } }));
    await page.route('**/api/backends/chat-completions/status', route => {
        const source = route.request().postDataJSON().chat_completion_source;
        state.statusSources.push(source);
        return route.fulfill({ json: { data: models[source] ?? [] } });
    });
    const ready = async () => {
        await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
        await dismissOnboardingIfPresent(page);
        await dismissOpenDialogIfPresent(page);
        await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
    };
    await ready();
    return { state, errors, ready };
}

async function open(page, tab) {
    await page.evaluate(tab => window.NeconyanShell.openTab('left', tab), tab);
    await expect(page.locator(tab === 'sampling' ? '#sb-sampling-openai' : '#main_api')).toBeVisible();
}

async function noOverflow(page) {
    const width = page.viewportSize().width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const card = page.locator('[data-sb-sampling-control="#typical_p_openai"]');
    const box = await card.boundingBox();
    expect(box.width).toBeGreaterThan(160);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
}

for (const width of [1280, 1024, 997, 768, 390, 320]) {
    test(`Chat Completion samplers stay usable at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        const { errors, state } = await fixture(page);
        await open(page, 'sampling');
        const counter = page.locator('#typical_p_counter_openai');
        await expect(counter).toBeVisible();
        await counter.scrollIntoViewIfNeeded();
        await counter.tap();
        await counter.fill('0.65');
        await counter.press('Tab');
        await expect.poll(() => state.saved?.oai_settings.typical_p_openai).toBe(0.65);
        await page.locator('#typical_p_openai').focus();
        await expect(page.locator('#typical_p_openai')).toBeFocused();
        expect((await page.locator('#typical_p_openai').boundingBox()).width).toBeGreaterThanOrEqual(90);
        expect((await counter.boundingBox()).width).toBeGreaterThanOrEqual(76);
        await noOverflow(page);
        await page.screenshot({ path: info.outputPath(`sampling-${width}.png`) });
        expect(errors).toEqual([]);
        expect(state.generationRequests).toEqual([]);
    });
}

test('status metadata and model switches retain hidden sampling values through reload', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    const { errors, ready, state } = await fixture(page);
    await open(page, 'api');
    await page.locator('#api_button_openai').click();
    await expect.poll(() => state.statusSources.includes('nanogpt')).toBe(true);
    await expect(page.locator('#model_nanogpt_select option[value="openai/gpt-4o"]')).toBeAttached();
    await open(page, 'sampling');
    await page.locator('#typical_p_counter_openai').fill('0.625');
    await page.locator('#typical_p_counter_openai').press('Tab');
    await expect.poll(() => state.saved?.oai_settings.typical_p_openai).toBe(0.625);
    for (const model of ['openai/gpt-4o', 'anthropic/claude-sonnet-5']) {
        await open(page, 'api');
        await page.locator('#model_nanogpt_select').selectOption(model);
        await open(page, 'sampling');
        await expect(page.locator('#typical_p_openai')).toBeHidden();
    }
    await open(page, 'api');
    await expect(page.locator('#sb-sampling-openai .sb-chat-sampling-empty')).toBeAttached();
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_model_id').fill('local-unknown');
    await page.locator('#api_button_openai').click();
    await expect.poll(() => state.statusSources.includes('custom')).toBe(true);
    await open(page, 'sampling');
    await expect(page.locator('#typical_p_openai')).toBeHidden();
    await open(page, 'api');
    await page.locator('#custom_model_id').fill('local-typical');
    await open(page, 'sampling');
    await expect(page.locator('#typical_p_counter_openai')).toHaveValue('0.625');
    await expect(page.locator('#top_k_openai')).toBeHidden();
    await expect.poll(() => state.saved?.oai_settings.custom_model).toBe('local-typical');
    await ready();
    await open(page, 'api');
    await page.locator('#api_button_openai').click();
    await open(page, 'sampling');
    await expect(page.locator('#typical_p_counter_openai')).toBeVisible();
    await expect(page.locator('#typical_p_counter_openai')).toHaveValue('0.625');
    await open(page, 'api');
    await page.locator('#chat_completion_source').selectOption('openai_responses');
    await page.locator('#openai_model_id').fill('gpt-6-astra');
    await open(page, 'sampling');
    await expect(page.locator('#temp_openai')).toBeHidden();
    await expect(page.locator('#typical_p_openai')).toBeHidden();
    await expect(page.locator('#sb-sampling-openai .sb-chat-sampling-empty')).toBeVisible();
    expect(errors).toEqual([]);
    expect(state.generationRequests).toEqual([]);
});
