/* global document, window */
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { acknowledgeActiveSettings, test as disposableTest } from './neconyan-conversation-durable-fixture.js';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';

const test = disposableTest.extend({
    baseURL: async ({ app }, use) => use(app.url),
    page: async ({ app, viewport, hasTouch }, use) => {
        const account = await app.account({ phone: hasTouch, seedConversation: false, configureSettings(saved) {
            saved.extension_settings.lockedExtensionsUnlockApplied = true;
            saved.extension_settings.disabledExtensions.push('in-chat-agents', 'guided-generations', 'quick-image-gen');
            saved.power_user.reply_generation_location = 'browser';
            saved.power_user.continue_on_send = false;
            Object.assign(saved.power_user.auto_continue ??= {}, { enabled: false });
        } });
        const page = await account.context.newPage();
        if (viewport) await page.setViewportSize(viewport);
        await use(page);
    },
});
test.setTimeout(150000);
test.use({ serviceWorkers: 'block' });

// 'before' runs on the base tree and 'after' on the candidate; pictures go to NECONYAN_REASONING_SHOTS when it is set.
const phase = process.env.NECONYAN_REASONING_PHASE || 'after';
const shotsDirectory = process.env.NECONYAN_REASONING_SHOTS || '';

async function shot(page, testInfo, size, scene, target = page) {
    const directory = shotsDirectory || testInfo.outputDir;
    mkdirSync(directory, { recursive: true });
    await page.evaluate(() => { document.activeElement?.blur?.(); window.toastr?.remove?.(); });
    await target.screenshot({ path: path.join(directory, `${phase}-${size}-${scene}.png`) });
}

const savedProfile = {
    id: 'custom-levels-profile', name: 'Custom levels profile', mode: 'cc',
    api: 'custom', model: 'smol-kimi/kimi-k3',
    'reasoning-effort': 'auto', 'custom-reasoning-param-format': 'openai', 'custom-reasoning-param-name': 'reasoning_effort',
    'custom-reasoning-documented-levels': 'true', exclude: [],
};

const generatePath = '/api/backends/chat-completions/generate';

async function prepare(page, baseURL, { model = 'smol-kimi/kimi-k3', effort = 'auto', format = 'openai', name = 'reasoning_effort', levels = false, seedProfile = null, live = false } = {}) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    await page.context().route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (live) return route.continue();
        if (seedProfile && url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const envelope = await response.json();
            if (typeof envelope.settings !== 'string') return route.fulfill({ response, json: envelope });
            const saved = JSON.parse(envelope.settings);
            saved.extension_settings.connectionManager = { ...saved.extension_settings.connectionManager, profiles: [seedProfile], selectedProfile: seedProfile.id };
            return route.fulfill({ response, json: { ...envelope, settings: JSON.stringify(saved) } });
        }
        if (url.pathname === '/api/mewmory/config/get') {
            const response = await route.fetch();
            const data = await response.json();
            Object.assign(data.config, { enableNewChats: false, autoUpdate: false, autoHide: false });
            return route.fulfill({ response, json: data });
        }
        if (['/api/notebooks/reply-requirements', '/api/mewmory/inspect', '/api/mewmory/prepare', '/api/resumable-generations/list'].includes(url.pathname)) return route.continue();
        if (url.pathname.startsWith('/api/') && !/^\/api\/(settings|secrets|presets|characters|chats|groups|avatars|backgrounds|worldinfo|content|themes|quick-replies|users|stats|tokenizers|chat-navigation)\//.test(url.pathname)
            && !['/api/ping', '/api/extensions/discover'].includes(url.pathname)) return route.abort();
        return route.continue();
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await expect.poll(() => page.evaluate(async () => Boolean((await import('/script.js')).settingsReady || document.querySelector('dialog[open] .onboarding'))), { timeout: 60000 }).toBe(true);
    await dismissOnboardingIfPresent(page);
    const welcomeSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await welcomeSave.isVisible()) await welcomeSave.click();
    await dismissOpenDialogIfPresent(page);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).settingsReady), { timeout: 60000 }).toBe(true);
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    const tour = page.locator('#neconyan-tour-coachmark');
    if (await tour.isVisible()) await tour.locator('[data-tour-coach-skip]').click();
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => wizard.getByRole('button', { name: 'Skip', exact: true }).click());
    await page.evaluate(async ({ model, effort, format, name, levels }) => {
        const core = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
        openai.loadOpenAISettings(await response.json(), { ...structuredClone(openai.oai_settings), custom_model: model,
            reasoning_effort: effort, custom_reasoning_param_format: format, custom_reasoning_param_name: name,
            custom_reasoning_documented_levels: levels, bind_preset_to_connection: false, stream_openai: false, send_if_empty: '' });
        const character = core.characters.findIndex(item => item.name === 'Durable Nova');
        if (character < 0) throw new Error('The owned reasoning fixture character is missing.');
        await core.selectCharacterById(character, { switchMenu: false });
    }, { model, effort, format, name, levels });
    await openConnections(page);
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await setModel(page, model);
}

const openConnections = page => page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
const setModel = (page, model) => page.evaluate(value => window.$('#custom_model_id').val(value).trigger('input'), model);

async function openEffortSelect(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
    const drawer = page.locator('#sb-openai-advanced');
    if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
    const select = page.locator('#openai_reasoning_effort');
    await select.scrollIntoViewIfNeeded();
    return select;
}

async function openParametersPopup(page) {
    const button = page.locator('#customize_additional_parameters');
    // The button sits inside the collapsed 'Connection tools' disclosure.
    await page.evaluate(() => { document.querySelector('#customize_additional_parameters')?.closest('details')?.setAttribute('open', ''); });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const popup = page.locator('dialog[open]');
    await expect(popup.locator('#custom_reasoning_param_format')).toBeVisible();
    return popup;
}

async function closePopup(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open] #custom_reasoning_param_format')).toHaveCount(0);
}

async function tickSwitch(page) {
    await openConnections(page);
    const toggle = page.locator('#custom_reasoning_documented_levels');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.check();
}

const expectEveryOptionEnabled = async select => {
    const values = await select.locator('option').evaluateAll(options => options.map(option => option.value));
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) await expect(select.locator(`option[value="${value}"]`)).toBeEnabled();
};

const optionState = async (select, values) => Object.fromEntries(await Promise.all(values.map(async value => [value, await select.locator(`option[value="${value}"]`).isDisabled()])));

for (const mobile of [false, true]) {
    const size = mobile ? 'phone' : 'desktop';
    test.describe(`Custom reasoning levels ${size}`, () => {
        test.use({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });

        test('Custom reasoning levels preview', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL, { levels: false, seedProfile: savedProfile });
            // The popup first: the format and the name decide whether the switch exists.
            await openConnections(page);
            const popup = await openParametersPopup(page);
            await popup.locator('#custom_reasoning_param_format').selectOption('openai');
            await popup.locator('#custom_reasoning_param_name').fill('reasoning_effort');
            await popup.locator('.sb-custom-reasoning-format-hint[data-format="openai"]').scrollIntoViewIfNeeded();
            await shot(page, testInfo, size, 'popup');
            await closePopup(page);
            await openConnections(page);
            await tickSwitchWhenPresent(page);
            await shot(page, testInfo, size, 'connections');
            const select = await openEffortSelect(page);
            await shot(page, testInfo, size, 'effort');
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await page.locator('#sb-reasoning-effort-button').click();
            await expect(page.locator('#sb-reasoning-effort-picker')).toBeVisible();
            await shot(page, testInfo, size, 'picker');
            await page.keyboard.press('Escape');
            await expect(select).toBeAttached();
            // The profile's edit popup lists every saved field by name.
            await openConnections(page);
            await page.locator('.neconyan-connection-management summary').click();
            await page.locator('#edit_connection_profile').click();
            const edit = page.locator('dialog[open]');
            await expect(edit.locator('.popup-input, input').first()).toBeVisible();
            const label = edit.getByText('Custom Reasoning Disabled Value', { exact: true });
            await label.scrollIntoViewIfNeeded();
            await shot(page, testInfo, size, 'profile');
            await page.keyboard.press('Escape');
        });

        test('the switch is hidden for other formats and a blank name, and re-enables every option in an open popup', async ({ page, baseURL }) => {
            await prepare(page, baseURL, { levels: false });
            await openConnections(page);
            const toggle = page.locator('#custom_reasoning_documented_levels');
            await expect(toggle).toBeAttached();
            await toggle.scrollIntoViewIfNeeded();
            await expect(toggle).toBeVisible();
            await tickSwitch(page);
            const select = await openEffortSelect(page);
            await expect(select.locator('option[value="medium"]')).toBeDisabled();
            await openConnections(page);
            const popup = await openParametersPopup(page);
            const legacyHint = page.locator('[data-reasoning-legacy-hint][data-source*="custom"]');
            await expect(legacyHint).toHaveCSS('display', 'none');
            await popup.locator('#custom_reasoning_param_format').selectOption('boolean');
            await expect(page.locator('#custom_reasoning_documented_levels_block')).toBeHidden();
            await expectEveryOptionEnabled(select);
            // The select's tab is closed while the popup is open, so the hint's own display (the jQuery toggle) is checked, not its visibility.
            await expect(legacyHint).not.toHaveCSS('display', 'none');
            await popup.locator('#custom_reasoning_param_format').selectOption('openai');
            await expect(select.locator('option[value="medium"]')).toBeDisabled();
            await popup.locator('#custom_reasoning_param_name').fill('');
            await expect(page.locator('#custom_reasoning_documented_levels_block')).toBeHidden();
            await expectEveryOptionEnabled(select);
            await expect(legacyHint).not.toHaveCSS('display', 'none');
            await popup.locator('#custom_reasoning_param_name').fill('reasoning_effort');
            await expect(select.locator('option[value="medium"]')).toBeDisabled();
            await closePopup(page);
            await openConnections(page);
            await expect(page.locator('#custom_reasoning_documented_levels_block')).toBeVisible();
        });

        test('ticking the switch hides unsupported levels and shows the supported list', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL, { levels: false });
            const select = await openEffortSelect(page);
            const hint = page.locator('#native_reasoning_effort_hint');
            await expect(select.locator('option[value="medium"]')).toBeEnabled();
            await expect(hint).toBeHidden();
            await tickSwitch(page);
            await openEffortSelect(page);
            expect(await optionState(select, ['auto', 'none', 'min', 'low', 'medium', 'high', 'xhigh', 'max'])).toEqual({
                auto: false, none: false, min: true, low: false, medium: true, high: false, xhigh: true, max: false });
            for (const value of ['min', 'medium', 'xhigh']) await expect(select.locator(`option[value="${value}"]`)).toBeHidden();
            await expect(hint).toHaveText(`This model supports ${new Intl.ListFormat('en', { type: 'conjunction' }).format(['Low', 'High', 'Maximum'])}.`);
            await expect(page.locator('[data-reasoning-legacy-hint][data-source*="custom"]')).toBeHidden();
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await page.locator('#sb-reasoning-effort-button').click();
            const options = page.locator('#sb-reasoning-effort-picker').getByRole('option');
            await expect(options).toHaveText(['Auto', 'None', 'Low', 'High', 'Maximum']);
            await shot(page, testInfo, size, 'picker-ticked');
            await page.keyboard.press('Escape');
            // None is offered, and sends nothing for a model whose maker documents no None.
            const again = await openEffortSelect(page);
            await again.selectOption('none');
            const noneMessage = 'None isn\'t a documented level for this model, so no reasoning setting is sent.';
            await expect(hint).toHaveText(noneMessage);
            await expect(again).toHaveAttribute('data-reasoning-unavailable', 'false');
            await shot(page, testInfo, size, 'none');
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#sb-reasoning-effort-button')).toHaveAttribute('aria-label', noneMessage);
            // Unticking restores everything.
            await tickSwitchOff(page);
            const final = await openEffortSelect(page);
            await expect(final.locator('option[value="medium"]')).toBeEnabled();
            await expect(hint).toBeHidden();
            await expect(page.locator('[data-reasoning-legacy-hint][data-source*="custom"]')).toBeVisible();
        });

        test('a native model with None unlisted keeps the existing message', async ({ page, baseURL }) => {
            await prepare(page, baseURL, { levels: true, effort: 'none' });
            await openConnections(page);
            await page.locator('#chat_completion_source').selectOption('openai');
            await page.evaluate(() => window.$('#model_openai_select').val('gpt-6-astra').trigger('change'));
            const select = await openEffortSelect(page);
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('None is unavailable for this model. No reasoning effort override is sent.');
            await expect(select).toHaveAttribute('data-reasoning-unavailable', 'true');
        });

        test('the ticked state survives a reload', async ({ page, baseURL }) => {
            await prepare(page, baseURL, { levels: false });
            await tickSwitch(page);
            await acknowledgeActiveSettings(page);
            await waitForSettingsSaveWindow(page);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).settingsReady), { timeout: 60000 }).toBe(true);
            await openConnections(page);
            await page.locator('#chat_completion_source').selectOption('custom');
            await expect(page.locator('#custom_reasoning_documented_levels')).toBeChecked();
        });

        test('a re-host gets its maker levels and an unrecognised model keeps every option', async ({ page, baseURL }) => {
            await prepare(page, baseURL, { model: 'smol-alibaba/kimi-k3', levels: true });
            const select = await openEffortSelect(page);
            expect(await optionState(select, ['auto', 'none', 'low', 'medium', 'high', 'max'])).toEqual({
                auto: false, none: false, low: false, medium: true, high: false, max: false });
            for (const unknown of ['smol-alibaba/cmaas-qwen3.8-flash', 'gpt-6-sol:online', 'kimi-k3:thinking',
                'claude-opus-5.5-lite', 'kimi-k3-pro', '[kimi-k3]other-model', '[kimi-k3]']) {
                await openConnections(page);
                await setModel(page, unknown);
                await openEffortSelect(page);
                await expectEveryOptionEnabled(select);
            }
        });

        for (const [canonical, variants, unavailable, labels] of [
            ['claude-opus-5-5', ['anthropic/claude-opus-5-5', '[anthropic]claude-opus-5-5', 'anthropic/claude-opus-5.5', 'anthropic:claude-opus-5-5'],
                'min', ['Auto', 'None', 'Low', 'Medium', 'High', 'Extra High', 'Maximum']],
            ['kimi-k3', ['[kimi]/kimi-k3', '[kimi] / kimi-k3'], 'medium', ['Auto', 'None', 'Low', 'High', 'Maximum']],
        ]) {
            test(`${canonical} prefixed models use maker controls and keep the exact outbound ID`, async ({ page, baseURL, app }, testInfo) => {
                const errors = [];
                page.on('pageerror', error => errors.push(String(error)));
                page.on('console', message => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
                await prepare(page, baseURL, { levels: 'true', live: true });
                await expect(page.locator('#custom_reasoning_documented_levels')).toBeChecked();
                await page.locator('#api_button_openai').click();
                const headers = await page.evaluate(async () => (await import('/script.js')).getRequestHeaders());
                const button = page.locator('#sb-reasoning-effort-button');
                const picker = page.locator('#sb-reasoning-effort-picker');
                const high = picker.getByRole('option', { name: 'High', exact: true });
                const inspect = async model => {
                    await openConnections(page);
                    await setModel(page, model);
                    const select = await openEffortSelect(page);
                    await expect(select.locator(`option[value="${unavailable}"]`)).toBeDisabled();
                    await expect(select.locator('option[value="high"]')).toBeEnabled();
                    await select.selectOption('high');
                    await page.evaluate(() => window.NeconyanShell.openTab('left', 'sampling'));
                    await expect(page.locator('#sb-sampling-openai')).toBeVisible();
                    for (const key of ['temp', 'top_p', 'freq_pen', 'pres_pen']) await expect(page.locator(`#${key}_openai`)).toBeHidden();
                    await page.locator('#left-nav-panel .sb-shell-close').click();
                    await button.click();
                    await expect(picker.getByRole('option')).toHaveText(labels);
                    await expect(high).toHaveAttribute('aria-selected', 'true');
                    const dimensions = async locator => {
                        const { width, height } = await locator.boundingBox();
                        return [Math.round(width), Math.round(height)];
                    };
                    return { picker: await dimensions(picker), button: await dimensions(button), composer: await dimensions(page.locator('#send_textarea')) };
                };
                const canonicalLayout = await inspect(canonical);
                await high.click();
                for (const model of variants) {
                    await test.step(model, async () => {
                        expect(await inspect(model)).toEqual(canonicalLayout);
                        await shot(page, testInfo, size, model.replace(/[^a-z0-9.-]/gi, '_'), picker);
                        await high.click();
                        const sent = page.waitForResponse(response => new URL(response.url()).pathname === generatePath);
                        await page.locator('#send_textarea').fill(`Check ${model}`);
                        await page.locator('#send_but').click();
                        const response = await sent;
                        expect(response.status()).toBe(200);
                        expect(response.request().postDataJSON()).toMatchObject({ model, reasoning_effort: 'high', custom_reasoning_documented_levels: true });
                        await expect.poll(() => app.provider.calls.filter(call => call.model === model).at(-1)?.body).toMatchObject({ model, reasoning_effort: 'high' });
                        const last = app.provider.calls.filter(call => call.model === model).at(-1).body;
                        for (const sampler of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) expect(last).not.toHaveProperty(sampler);
                        const calls = app.provider.calls.length;
                        const refused = await page.request.post(baseURL + generatePath, { headers, data: { ...response.request().postDataJSON(), reasoning_effort: unavailable } });
                        expect(refused.status()).toBe(400);
                        expect((await refused.json()).error.code).toBe('UNSUPPORTED_REASONING_EFFORT');
                        expect(app.provider.calls).toHaveLength(calls);
                        await expect(page.locator('#chat > .mes[is_user="false"] .mes_text').last()).toContainText('Durable first reply.');
                        await expect(page.locator('body')).not.toHaveAttribute('data-generating', /.+/);
                    });
                }
                expect(errors).toEqual([]);
            });
        }

        test('a saved alias shows as unavailable and names the level it acts as', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL, { model: 'qwen3.8-max', effort: 'high', levels: true });
            const select = await openEffortSelect(page);
            await expect(select.locator('option:checked')).toHaveText('High (unavailable)');
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('High acts as Extra High on this model. Choose None, Low, Medium, or Extra High.');
            await shot(page, testInfo, size, 'alias');
            await acknowledgeActiveSettings(page);
        });

        test('xAI keeps the legacy hint after the native hint gained Custom', async ({ page, baseURL }) => {
            await prepare(page, baseURL, { levels: true });
            await openConnections(page);
            await page.locator('#chat_completion_source').selectOption('xai');
            await openEffortSelect(page);
            await expect(page.locator('[data-reasoning-legacy-hint][data-source^="custom,xai"]')).toBeVisible();
            await expect(page.locator('#native_reasoning_effort_hint')).toBeHidden();
        });
    });
}

// The base tree has no switch, so the preview scene ticks it only when it exists and scrolls to the nearest control otherwise.
async function tickSwitchWhenPresent(page) {
    await openConnections(page);
    const toggle = page.locator('#custom_reasoning_documented_levels');
    const present = await toggle.count();
    await (present ? toggle : page.locator('#custom_model_icon_detection')).scrollIntoViewIfNeeded();
    if (present) await toggle.check();
}

async function waitForSettingsSaveWindow(page) {
    await page.evaluate(async () => {
        const { DEFAULT_SAVE_EDIT_TIMEOUT } = await import('/script.js');
        await new Promise(resolve => window.setTimeout(resolve, DEFAULT_SAVE_EDIT_TIMEOUT + 100));
    });
}

async function tickSwitchOff(page) {
    await openConnections(page);
    const toggle = page.locator('#custom_reasoning_documented_levels');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.uncheck();
}
