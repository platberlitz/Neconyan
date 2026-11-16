/* global document, getComputedStyle, window */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const SEED_KEY = 'NeconyanAssistantSeed.v1';
const SIMPLE_KEY = 'NeconyanSimpleMode.v1';

/**
 * Loads the app as an account whose stored flags are the ones given, without touching what the server holds.
 * Saves are answered here and remembered, and assistant installs are recorded instead of creating characters.
 */
async function account(page, flags) {
    const state = { saved: {}, installs: [] };
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const data = JSON.parse(body.settings);
        data.firstRun = false;
        const stored = { ...data.accountStorage };
        for (const key of [SEED_KEY, SIMPLE_KEY, 'NeconyanTutorialStatus.v1', 'NeconyanTutorialIndex.v1', 'NeconyanTutorialHidden.v1']) delete stored[key];
        for (const key of Object.keys(stored)) if (key.startsWith('neconyanAssistantGender:')) delete stored[key];
        data.accountStorage = { ...stored, ...flags, ...state.saved };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(data) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const payload = JSON.parse(bytes.toString());
        state.saved = { ...payload.accountStorage };
        await route.fulfill({ json: {
            result: 'ok',
            version: Number(payload._version || 0) + 1,
            settingsRevision: Number(payload._settingsRevision || 0) + 1,
        } });
    });
    await page.route('**/api/characters/assistants/install', async route => {
        const { id } = route.request().postDataJSON();
        state.installs.push(id);
        await route.fulfill({ json: { id, avatar: `${id}.png`, spriteFolder: `assistants/${id}`, created: true, bundledVersion: 1 } });
    });
    return state;
}

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    // The intercepted settings carry no Quick Image Gen cache id, so its legacy import prompt can cover the page.
    const legacy = page.locator('dialog.popup[open]').filter({ hasText: 'Quick Image Gen found legacy browser-only settings' });
    await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => legacy.getByRole('button', { name: 'Cancel', exact: true }).click(), () => {});
}

test.setTimeout(120_000);

const newAccount = { [SEED_KEY]: 'ask', [SIMPLE_KEY]: 'ask', 'NeconyanTutorialStatus.v1': 'pending', 'NeconyanTutorialIndex.v1': '0' };

for (const [name, viewport, hasTouch] of [['desktop', { width: 1280, height: 900 }, false], ['phone', { width: 393, height: 852 }, true]]) {
    test.describe(`first run on ${name}`, () => {
        test.use({ viewport, hasTouch, isMobile: hasTouch });
        // A settings request still in flight when a test ends must not fail it.
        test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

        test('a new account chooses how Miso, Taro and Nori look, then answers the Simple Mode question', async ({ page }) => {
            const state = await account(page, newAccount);
            await ready(page);
            const tour = page.locator('#neconyan-tour-coachmark');
            await expect(tour.locator('[data-tour-coach-title]')).toHaveText('Who would you like to meet?');
            await expect(tour.locator('[data-tour-coach-next]')).toBeHidden();
            const rows = tour.locator('.neconyan-tour-assistant-row');
            await expect(rows).toHaveCount(3);
            await expect(tour.locator('[data-tour-assistant][aria-pressed="true"]')).toHaveText(['Neutral', 'Neutral', 'Neutral']);

            // Every choice is a full-size target and nothing spills out of the card sideways.
            const fit = await tour.evaluate(card => {
                const bounds = card.getBoundingClientRect();
                const buttons = [...card.querySelectorAll('[data-tour-assistant], [data-tour-assistants-confirm]')].map(button => button.getBoundingClientRect());
                return {
                    inside: buttons.every(box => box.left >= bounds.left && box.right <= bounds.right),
                    shortest: Math.min(...buttons.map(box => box.height)),
                    sideways: card.querySelector('[data-tour-content]').scrollWidth - card.querySelector('[data-tour-content]').clientWidth,
                };
            });
            expect(fit.inside).toBe(true);
            expect(fit.shortest).toBeGreaterThanOrEqual(44);
            expect(fit.sideways).toBeLessThanOrEqual(1);

            const misoFemale = tour.locator('[data-tour-assistant="miso"][data-tour-assistant-gender="female"]');
            await misoFemale.click();
            await expect(misoFemale).toHaveAttribute('aria-pressed', 'true');
            await expect(tour.locator('[data-tour-assistant="miso"][aria-pressed="true"]')).toHaveCount(1);
            await expect(tour.locator('.neconyan-tour-assistant-row img').first()).toHaveAttribute('src', /female/);
            await tour.locator('[data-tour-assistant="taro"][data-tour-assistant-gender="male"]').click();

            await tour.locator('[data-tour-assistants-confirm]').click();
            await expect(tour.locator('[data-tour-coach-title]')).toHaveText('Want to keep things simple?');
            expect(state.installs).toEqual(['miso-female', 'taro-male', 'nori-neutral']);
            expect(state.saved[SEED_KEY]).toBe('done');

            await tour.locator('[data-tour-simple-mode-answer="on"]').click();
            await expect(tour.locator('[data-tour-coach-step]')).toHaveText(/^Step 1 of \d+$/);
            await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);

            // A reload does not ask or install again.
            await expect.poll(() => state.saved[SIMPLE_KEY]).toBe('on');
            await ready(page);
            await expect(tour.locator('[data-tour-coach-step]')).toHaveText(/^Step 1 of \d+$/);
            expect(state.installs).toHaveLength(3);
        });

        test('skipping the tour still brings all three in, as Neutral', async ({ page }) => {
            const state = await account(page, newAccount);
            await ready(page);
            const tour = page.locator('#neconyan-tour-coachmark');
            await expect(tour.locator('[data-tour-coach-title]')).toHaveText('Who would you like to meet?');
            await tour.locator('[data-tour-coach-skip]').click();
            await expect(tour).toHaveCount(0);
            await expect.poll(() => state.installs).toEqual(['miso-neutral', 'taro-neutral', 'nori-neutral']);
            await expect.poll(() => state.saved[SEED_KEY]).toBe('done');
        });

        test('an account from before this change is not asked and gets nothing installed', async ({ page }) => {
            const state = await account(page, { [SIMPLE_KEY]: 'off', 'NeconyanTutorialStatus.v1': 'pending', 'NeconyanTutorialIndex.v1': '0' });
            await ready(page);
            const tour = page.locator('#neconyan-tour-coachmark');
            await expect(tour.locator('[data-tour-coach-step]')).toHaveText(/^Step 1 of \d+$/);
            await expect(tour.locator('.neconyan-tour-assistant-row')).toHaveCount(0);
            await tour.locator('[data-tour-coach-skip]').click();
            await expect(tour).toHaveCount(0);
            await page.waitForTimeout(500);
            expect(state.installs).toEqual([]);
            expect(state.saved[SEED_KEY]).toBeUndefined();
        });

        test('Simple Mode keeps the character search within reach, under a plain name', async ({ page }) => {
            await account(page, { [SIMPLE_KEY]: 'on', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);
            const railButton = page.locator('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="botsearcher"]');
            await expect(railButton).toHaveAttribute('aria-label', 'Find characters');
            await expect(railButton.locator('span').first()).toHaveText('Find characters');
            const shown = route => page.locator(`#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="${route}"]`)
                .evaluate(button => !button.hidden && getComputedStyle(button).display !== 'none');
            expect(await shown('botsearcher')).toBe(true);
            expect(await shown('persona')).toBe(true);
            expect(await shown('sampling')).toBe(false);

            const home = page.locator('.neconyan-home-actions');
            await expect(home.getByRole('button', { name: /^Import a character/ })).toBeVisible();
            await home.getByRole('button', { name: /^Find characters online/ }).click();
            const search = page.locator('#sbbs_query');
            await expect(search).toBeVisible();
            // With Simple Mode on, a pasted card link is imported directly; the full interface reviews it first.
            await search.fill('https://chub.ai/characters/example/example-card');
            await expect(page.locator('#sbbs_go')).toHaveAttribute('aria-label', 'Import card URL');
        });

        test('with every feature shown the search keeps its own name and reviews cards first', async ({ page }) => {
            await account(page, { [SIMPLE_KEY]: 'off', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            const railButton = page.locator('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="botsearcher"]');
            await expect(railButton.locator('span').first()).toHaveText('BotSearcher');
            await page.locator('.neconyan-home-actions').getByRole('button', { name: /^Import a character/ }).click();
            await expect(page.locator('#sbbs_import_action')).toBeVisible();
            await page.locator('#sbbs_import_action').click();
            const search = page.locator('#sbbs_query');
            await search.fill('https://chub.ai/characters/example/example-card');
            await expect(page.locator('#sbbs_go')).toHaveAttribute('aria-label', 'Review card URL');
        });
        const openConnections = async (page, isPhone) => {
            if (isPhone) await page.getByRole('button', { name: 'Open menu' }).click();
            await page.locator('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="model"]').first().click();
            await expect(page.locator('#chat_completion_source')).toBeVisible();
        };

        test('Simple Mode shortens Connections to provider, key, model, Connect and Test', async ({ page, isMobile }) => {
            await account(page, { [SIMPLE_KEY]: 'on', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            await openConnections(page, isMobile);
            const api = page.locator('#rm_api_block');
            const provider = page.locator('#chat_completion_source');
            const offered = () => provider.evaluate(select => [...select.options].filter(option => !option.hidden).map(option => option.value).sort());
            await expect(api).toHaveClass(/neconyan-connections-short/);
            expect(await offered()).toEqual(['claude', 'custom', 'deepseek', 'makersuite', 'openai', 'openrouter']);
            await expect(provider.locator('option[value="custom"]')).toHaveText('Proxy or other');
            for (const hidden of ['.neconyan-model-saved', '#main-API-selector-block', '#prompt_post_processing_form']) {
                await expect(api.locator(hidden).first()).toBeHidden();
            }

            await provider.selectOption('openai');
            for (const kept of ['#api_key_openai', '#api_button_openai', '#test_api_button', '#openai_model_id']) {
                await expect(api.locator(kept).first()).toBeVisible();
            }
            await page.locator('#api_key_openai').fill('');
            await page.locator('#api_button_openai').click();
            await expect(page.locator('.toast-warning', { hasText: 'Paste your API key into the key box first' })).toBeVisible();

            await provider.selectOption('openrouter');
            const signIn = api.locator('.openrouter_authorize[data-source="openrouter"]');
            await expect(signIn).toBeVisible();
            expect(await signIn.evaluate(node => Boolean(node.closest('.neconyan-provider-connection')))).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

            const more = api.locator('.neconyan-connections-more');
            await expect(more).toHaveText('More connection options');
            await more.click();
            await expect(more).toHaveText('Fewer connection options');
            await expect(api).not.toHaveClass(/neconyan-connections-short/);
            await expect(api.locator('#main-API-selector-block')).toBeVisible();
            expect((await offered()).length).toBeGreaterThan(6);
            // A provider outside the short list stays selectable once it is the saved one.
            await provider.selectOption('mistralai');
            await more.click();
            await expect(api).toHaveClass(/neconyan-connections-short/);
            expect(await offered()).toContain('mistralai');
        });

        test('with every feature shown Connections is the full page', async ({ page, isMobile }) => {
            await account(page, { [SIMPLE_KEY]: 'off', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            await openConnections(page, isMobile);
            const api = page.locator('#rm_api_block');
            await expect(api).not.toHaveClass(/neconyan-connections-short/);
            await expect(api.locator('.neconyan-connections-more')).toBeHidden();
            await expect(api.locator('#main-API-selector-block')).toBeVisible();
            await expect(page.locator('#chat_completion_source option[value="custom"]')).toHaveText('Custom (OpenAI-compatible)');
            expect(await api.locator('.openrouter_authorize[data-source="openrouter"]').evaluate(node => Boolean(node.closest('.neconyan-connection-tools')))).toBe(true);
        });

        test('Simple Mode has one Memory button that opens Story so far and still reaches Mewmory', async ({ page, isMobile }) => {
            await account(page, { [SIMPLE_KEY]: 'on', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
            await page.locator('#neconyan-workspace-rail [data-neconyan-simple-memory]').click();
            const story = page.locator('.neconyan-story-so-far');
            await expect(story.getByRole('heading', { name: 'Story so far' })).toBeVisible();
            await expect(story).toContainText('the LLM writes down what happened');
            const toggle = story.locator('[data-story-so-far-enabled]');
            await expect(toggle).toBeEnabled();
            const before = await toggle.isChecked();
            await toggle.click();
            await expect.poll(() => page.evaluate(() => window.NeconyanAgents.memoryShard.getState().enabled)).toBe(!before);
            await toggle.click();
            await expect.poll(() => page.evaluate(() => window.NeconyanAgents.memoryShard.getState().enabled)).toBe(before);
            await expect(story.locator('[data-story-so-far-summarise]')).toBeDisabled();
            expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
            await story.locator('[data-story-so-far-mewmory]').click();
            await expect(story).toBeHidden();
            await expect(page.locator('#mewmory-workspace')).toBeVisible();
        });

        test('with every feature shown there is no Memory button', async ({ page, isMobile }) => {
            await account(page, { [SIMPLE_KEY]: 'off', 'NeconyanTutorialStatus.v1': 'completed' });
            await ready(page);
            if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
            await expect(page.locator('#neconyan-workspace-rail [data-neconyan-route="home"]').first()).toBeVisible();
            await expect(page.locator('#neconyan-workspace-rail [data-neconyan-simple-memory]')).toBeHidden();
        });
    });
}
