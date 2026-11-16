/* global document */
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
    });
}
