/* global document, window */
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test as disposableTest } from './neconyan-conversation-durable-fixture.js';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const test = disposableTest.extend({
    baseURL: async ({ app }, use) => use(app.url),
    page: async ({ app, viewport, hasTouch }, use) => {
        const account = await app.account({ phone: hasTouch, configureSettings(saved) {
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
test.setTimeout(120000);
test.use({ serviceWorkers: 'block' });

const model = 'fixture/reasoning';
const automatic = 'fixture/automatic';
const variant = 'fixture/reasoning:free';
const models = [
    { id: model, name: 'Fixture reasoning', reasoning: { supported_efforts: ['high', 'max'], mandatory: true } },
    { id: automatic, name: 'Fixture automatic', reasoning: { mandatory: true } },
    { id: variant, name: 'Fixture variant' },
].map(record => ({ context_length: 128000, pricing: { prompt: '0', completion: '0' }, ...record }));

async function prepare(page, baseURL) {
    const origin = new URL(baseURL).origin;
    const catalogue = { hold: false, held: [] };
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    await page.context().route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/backends/chat-completions/status') {
            if (catalogue.hold) {
                catalogue.held.push(route);
                return;
            }
            return route.fulfill({ json: { data: models } });
        }
        if (url.pathname === '/api/openrouter/providers') return route.fulfill({ json: ['fixture-provider'] });
        if (url.pathname === '/api/openrouter/models/providers') return route.fulfill({ json: { providers: ['fixture-provider'] } });
        if (url.pathname === '/api/mewmory/config/get') {
            const response = await route.fetch();
            const data = await response.json();
            Object.assign(data.config, { enableNewChats: false, autoUpdate: false, autoHide: false });
            return route.fulfill({ response, json: data });
        }
        if (['/api/notebooks/reply-requirements', '/api/mewmory/inspect', '/api/resumable-generations/list'].includes(url.pathname)) return route.continue();
        if (url.pathname.startsWith('/api/') && !/^\/api\/(settings|secrets|presets|characters|chats|groups|avatars|backgrounds|worldinfo|content|themes|quick-replies|users|stats|tokenizers|chat-navigation)\//.test(url.pathname)
            && !['/api/ping', '/api/extensions/discover'].includes(url.pathname)) return route.abort();
        return route.continue();
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady || document.querySelector('dialog[open] .onboarding'));
    await dismissOnboardingIfPresent(page);
    const welcomeSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await welcomeSave.isVisible()) await welcomeSave.click();
    await dismissOpenDialogIfPresent(page);
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    const tour = page.locator('#neconyan-tour-coachmark');
    if (await tour.isVisible()) await tour.locator('[data-tour-coach-skip]').click();
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => wizard.getByRole('button', { name: 'Skip', exact: true }).click());
    await page.evaluate(async initialModel => {
        const core = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
        openai.loadOpenAISettings(await response.json(), { ...structuredClone(openai.oai_settings), openrouter_model: initialModel,
            reasoning_effort: 'low', bind_preset_to_connection: false, stream_openai: false, send_if_empty: '' });
        const character = core.characters.findIndex(item => item.name === 'Durable Nova');
        if (character < 0) throw new Error('The owned reasoning fixture character is missing.');
        await core.selectCharacterById(character, { switchMenu: false });
    }, model);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('openrouter');
    await page.locator('#api_key_openrouter').fill('router-browser-fixture-not-a-real-key');
    const status = page.waitForResponse('**/api/backends/chat-completions/status');
    await page.locator('#api_button_openai').click();
    expect((await status).ok()).toBe(true);
    await expect(page.locator('#model_openrouter_select option')).toHaveCount(models.length + 1);
    await chooseModel(page, model);
    return catalogue;
}

async function chooseModel(page, id) {
    await page.evaluate(value => window.$('#model_openrouter_select').val(value).trigger('change'), id);
    await expect(page.locator('#model_openrouter_select')).toHaveValue(id);
}

async function savedEffort(page) {
    return page.evaluate(async () => {
        const core = await import('/script.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
        return JSON.parse((await response.json()).settings).oai_settings.reasoning_effort;
    });
}

async function savedReasoningState(page) {
    return page.evaluate(async () => {
        const core = await import('/script.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
        const settings = JSON.parse((await response.json()).settings);
        return { effort: settings.oai_settings.reasoning_effort, model: settings.oai_settings.openrouter_model,
            revision: settings._settingsRevision };
    });
}

async function attachGeometry(page, testInfo, name) {
    const metrics = await page.evaluate(() => {
        const selectors = ['#openai_reasoning_effort', '#openai_reasoning_effort option:checked',
            '#openrouter_reasoning_effort_hint', '#sb-reasoning-effort-button', '#sb-reasoning-effort-picker .sb-persona-option'];
        const describe = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return {
                text: element.textContent.trim(), hidden: element.hidden,
                disabled: 'disabled' in element ? element.disabled : null,
                selected: 'selected' in element ? element.selected : null,
                display: style.display, visibility: style.visibility, opacity: style.opacity,
                colour: style.color, background: style.backgroundColor, font: style.font,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
                displayed: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
                horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
            };
        };
        return { viewport: { width: window.innerWidth, height: window.innerHeight },
            elements: Object.fromEntries(selectors.map(selector => [selector, Array.from(document.querySelectorAll(selector), describe)])) };
    });
    await testInfo.attach(name, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
}

for (const mobile of [false, true]) {
    test.describe(`OpenRouter reasoning ${mobile ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });

        // Run this same visual fixture against the clean base and candidate.
        test('ordinary settings and picker preview', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const drawer = page.locator('#sb-openai-advanced');
            await expect(drawer).toBeVisible();
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            await page.locator('#openai_reasoning_effort').scrollIntoViewIfNeeded();
            await attachGeometry(page, testInfo, 'settings-geometry');
            await page.screenshot({ path: testInfo.outputPath('settings.png') });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await page.locator('#sb-reasoning-effort-button').click();
            await expect(page.locator('#sb-reasoning-effort-picker')).toBeVisible();
            await attachGeometry(page, testInfo, 'picker-geometry');
            await page.screenshot({ path: testInfo.outputPath('picker.png') });
            await page.keyboard.press('Escape');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await chooseModel(page, automatic);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await page.locator('#openai_reasoning_effort').scrollIntoViewIfNeeded();
            await attachGeometry(page, testInfo, 'no-selector-geometry');
            await page.screenshot({ path: testInfo.outputPath('no-selector.png') });
        });

        test('retains unavailable saved choice and distinguishes no-selector and exact variants', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const select = page.locator('#openai_reasoning_effort');
            const drawer = page.locator('#sb-openai-advanced');
            await expect(drawer).toBeVisible();
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            await select.scrollIntoViewIfNeeded();
            await expect(select).toHaveValue('low');
            await expect(select.locator('option[value="low"]')).toBeDisabled();
            await expect(page.locator('#openrouter_reasoning_effort_hint')).toContainText('Choose one before sending');
            await page.evaluate(async () => (await import('/scripts/i18n.js')).applyLocale(document));
            await expect(page.locator('#openrouter_reasoning_effort_hint')).toContainText('Choose one before sending');
            await acknowledgeActiveSettings(page);
            expect(await savedEffort(page)).toBe('low');
            const beforePicker = await savedReasoningState(page);
            expect(beforePicker).toMatchObject({ effort: 'low', model });
            expect(Number.isSafeInteger(beforePicker.revision)).toBe(true);
            await page.screenshot({ path: testInfo.outputPath('reasoning-settings.png') });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            const chip = page.locator('#sb-reasoning-effort-button');
            await expect(chip).toBeVisible();
            await chip.click();
            const picker = page.locator('#sb-reasoning-effort-picker');
            await expect(picker.getByRole('option')).toHaveText(['High', 'Maximum']);
            await page.keyboard.press('Escape');
            await waitForAnimationFrames(page);
            expect(await savedReasoningState(page)).toEqual(beforePicker);
            expect(await savedEffort(page)).toBe('low');
            const command = effort => page.evaluate(async value => {
                const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
                return (await executeSlashCommandsWithOptions(`/reasoning-effort ${value}`)).pipe;
            }, effort);
            expect(await command('high')).toBe('high');
            await expect(chip).toHaveAttribute('aria-label', 'Reasoning Effort: High');
            expect(await command('low')).toBe('low');
            await expect(chip).toHaveAttribute('aria-label', 'Reasoning Effort: Low, unavailable for this model. Choose High or Maximum.');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await chooseModel(page, automatic);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await expect(select).toBeDisabled();
            await expect(select).toHaveValue('low');
            await expect(page.locator('#openrouter_reasoning_effort_hint')).toHaveText('This model does not expose an effort setting. Your saved choice is kept for other models.');
            await page.evaluate(async () => (await import('/scripts/i18n.js')).applyLocale(document));
            await expect(page.locator('#openrouter_reasoning_effort_hint')).toHaveText('This model does not expose an effort setting. Your saved choice is kept for other models.');
            await page.screenshot({ path: testInfo.outputPath('no-selector-settings.png') });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await expect(chip).toBeHidden();
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await chooseModel(page, variant);
            await expect(select).toBeEnabled();
            await expect(select.locator('option[value="low"]')).toBeEnabled();
            await chooseModel(page, model);
            await expect(select.locator('option[value="low"]')).toBeDisabled();
            await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
            expect(await savedEffort(page)).toBe('low');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
            await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
            await page.waitForFunction(() => typeof window.NeconyanShell?.openTab === 'function');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            const status = page.waitForResponse('**/api/backends/chat-completions/status');
            await page.locator('#api_button_openai').click();
            expect((await status).ok()).toBe(true);
            await expect(select).toHaveValue('low');
            await expect(select.locator('option[value="low"]')).toBeDisabled();
            expect(await savedEffort(page)).toBe('low');
        });

        test('a held catalogue cannot apply another model or an old source declaration', async ({ page, baseURL }) => {
            const catalogue = await prepare(page, baseURL);
            const select = page.locator('#openai_reasoning_effort');
            await expect(select.locator('option[value="low"]')).toBeDisabled();
            catalogue.hold = true;
            await page.locator('#api_button_openai').click();
            await expect.poll(() => catalogue.held.length).toBe(1);
            await chooseModel(page, variant);
            await expect(select.locator('option[value="low"]')).toBeEnabled();
            catalogue.hold = false;
            await catalogue.held.pop().fulfill({ json: { data: models } });
            await expect(page.locator('#model_openrouter_select')).toHaveValue(variant);
            await expect(select.locator('option[value="low"]')).toBeEnabled();
            await chooseModel(page, model);
            await expect(select.locator('option[value="low"]')).toBeDisabled();

            catalogue.hold = true;
            await page.locator('#api_button_openai').click();
            await expect.poll(() => catalogue.held.length).toBe(1);
            await page.locator('#chat_completion_source').selectOption('custom');
            const cancelled = catalogue.held.pop();
            // Source changes abort the owned status request; a completed response
            // must never be allowed to install the old source's declaration.
            try { await cancelled.fulfill({ json: { data: models } }); } catch { /* Already aborted by the app. */ }
            await expect(select.locator('option[value="low"]')).toBeEnabled();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.chat_completion_source)).toBe('custom');
        });

        test('ordinary Send keeps the prompt after rejection, retries, and omits a no-selector effort', async ({ page, baseURL }) => {
            await prepare(page, baseURL);
            const requests = [];
            const reply = 'A single supported ordinary reply.';
            await page.route('**/api/backends/chat-completions/generate', async route => {
                if (new URL(route.request().url()).origin !== new URL(baseURL).origin) return route.abort();
                const payload = route.request().postDataJSON();
                requests.push(payload);
                return payload.model === model && payload.reasoning_effort === 'low'
                    ? route.fulfill({ status: 400, json: { error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'Low is not available for this model. Choose High or Maximum in Reasoning Effort, then try again.' } } })
                    : route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] } });
            });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            const prompt = 'An owned prompt must survive the reasoning rejection.';
            const assistantCount = await page.evaluate(async () => (await import('/script.js')).chat.filter(message => !message.is_user).length);
            await acknowledgeActiveSettings(page);
            await page.locator('#send_textarea').fill(prompt);
            await page.locator('#send_but').click();
            await expect.poll(() => requests.length).toBe(1);
            await expect(page.locator('#toast-container')).toContainText('Choose High or Maximum');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
            expect(requests[0]).toMatchObject({ reasoning_effort: 'low', model_sampler_metadata: {
                source: 'openrouter', model, reasoning: { supported_efforts: ['high', 'max'], mandatory: true },
            } });
            expect(await page.evaluate(async original => {
                const { chat } = await import('/script.js');
                return { users: chat.filter(message => message.is_user && message.mes === original).length,
                    assistants: chat.filter(message => !message.is_user).length };
            }, prompt)).toEqual({ users: 1, assistants: assistantCount });
            await page.locator('#sb-reasoning-effort-button').click();
            await page.locator('#sb-reasoning-effort-picker').getByRole('option', { name: 'High', exact: true }).click();
            await acknowledgeActiveSettings(page);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(reply);
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
            expect(requests[1].reasoning_effort).toBe('high');
            expect(requests[1].messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(prompt))).toHaveLength(1);
            expect(await page.evaluate(async ({ prompt, reply }) => {
                const { chat } = await import('/script.js');
                return { users: chat.filter(message => message.is_user && message.mes === prompt).length,
                    replies: chat.filter(message => !message.is_user && message.mes === reply).length };
            }, { prompt, reply })).toEqual({ users: 1, replies: 1 });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await chooseModel(page, automatic);
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await acknowledgeActiveSettings(page);
            await page.locator('#send_textarea').fill('A second prompt with no effort selector.');
            await page.locator('#send_but').click();
            await expect.poll(() => requests.length).toBe(3);
            expect(requests[2].reasoning_effort).toBeUndefined();
            expect(requests[2].model_sampler_metadata).toMatchObject({ source: 'openrouter', model: automatic, reasoning: { mandatory: true } });
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(reply);
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
        });
    });
}
