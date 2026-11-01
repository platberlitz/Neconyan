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

const model = 'openai/gpt-oss-20b';
const variant = 'fixture/unknown';
const models = [{ id: model }, { id: variant }];

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
            const source = route.request().postDataJSON()?.chat_completion_source;
            return route.fulfill({ json: source === 'makersuite'
                ? { data: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.1-pro-preview' }], reasoning_context: { source: 'makersuite', apiVersion: 'v1beta' } }
                : { data: models } });
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
        openai.loadOpenAISettings(await response.json(), { ...structuredClone(openai.oai_settings), groq_model: initialModel,
            reasoning_effort: 'max', bind_preset_to_connection: false, stream_openai: false, send_if_empty: '' });
        const character = core.characters.findIndex(item => item.name === 'Durable Nova');
        if (character < 0) throw new Error('The owned reasoning fixture character is missing.');
        await core.selectCharacterById(character, { switchMenu: false });
    }, model);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('groq');
    await page.locator('#api_key_groq').fill('groq-browser-fixture-not-a-real-key');
    const status = page.waitForResponse('**/api/backends/chat-completions/status');
    await page.locator('#api_button_openai').click();
    expect((await status).ok()).toBe(true);
    await expect(page.locator('#model_groq_select option')).toHaveCount(models.length);
    await chooseModel(page, model);
    return catalogue;
}

async function chooseModel(page, id) {
    await page.evaluate(value => window.$('#model_groq_select').val(value).trigger('change'), id);
    await expect(page.locator('#model_groq_select')).toHaveValue(id);
}


for (const mobile of [false, true]) {
    test.describe(`Native reasoning ${mobile ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
        test('known native picker focuses an option and returns focus after Escape', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await page.evaluate(() => {
                const describeElement = element => element instanceof window.Element
                    ? { tag: element.tagName, id: element.id, className: element.className } : null;
                const events = [];
                const originalFocus = window.HTMLElement.prototype.focus;
                const isRelevant = element => element?.id === 'sb-reasoning-effort-button'
                    || Boolean(element?.closest?.('#sb-reasoning-effort-picker'));
                const focus = function (...args) {
                    if (!isRelevant(this)) return Reflect.apply(originalFocus, this, args);
                    const picker = document.getElementById('sb-reasoning-effort-picker');
                    const record = { kind: 'focus-call', target: describeElement(this), connected: this.isConnected,
                        inlineVisibility: picker?.style.visibility, before: describeElement(document.activeElement), time: window.performance.now() };
                    const result = Reflect.apply(originalFocus, this, args);
                    record.after = describeElement(document.activeElement);
                    record.computedVisibilityAfter = picker ? window.getComputedStyle(picker).visibility : null;
                    events.push(record);
                    return result;
                };
                const focusEvent = event => events.push({ kind: event.type, target: describeElement(event.target),
                    active: describeElement(document.activeElement), time: window.performance.now() });
                const keyEvent = event => {
                    if (event.key === 'Escape') events.push({ kind: 'escape', target: describeElement(event.target),
                        active: describeElement(document.activeElement), time: window.performance.now() });
                };
                const observer = new window.MutationObserver(records => {
                    for (const record of records) if (record.target.id === 'sb-reasoning-effort-picker') {
                        events.push({ kind: 'picker-style', oldValue: record.oldValue, inlineVisibility: record.target.style.visibility, time: window.performance.now() });
                    }
                });
                observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
                window.HTMLElement.prototype.focus = focus;
                document.addEventListener('focusin', focusEvent, true);
                document.addEventListener('focusout', focusEvent, true);
                document.addEventListener('keydown', keyEvent, true);
                window.__reasoningFocusTrace = { events, originalFocus, focusEvent, keyEvent, observer };
            });
            const snapshot = () => page.evaluate(() => {
                const picker = document.getElementById('sb-reasoning-effort-picker');
                const active = document.activeElement;
                const activeInsidePicker = Boolean(picker?.contains(active));
                return { active: active instanceof window.Element ? { tag: active.tagName, id: active.id, className: active.className } : null,
                    activeInsidePicker, activeText: activeInsidePicker ? active?.textContent?.trim() : null, pickerPresent: Boolean(picker),
                    pickerVisibility: picker ? window.getComputedStyle(picker).visibility : null,
                    chipFocused: active?.id === 'sb-reasoning-effort-button',
                    chipExpanded: document.getElementById('sb-reasoning-effort-button')?.getAttribute('aria-expanded'),
                    escapeEvents: window.__reasoningFocusTrace.events.filter(event => event.kind === 'escape') };
            });
            const trace = {};
            try {
                await page.locator('#sb-reasoning-effort-button').click();
                trace.afterClickCompletion = await snapshot();
                await waitForAnimationFrames(page);
                trace.afterPositioningFrames = await snapshot();
                await page.keyboard.press('Escape');
                trace.afterEscape = await snapshot();
            } finally {
                trace.events = await page.evaluate(() => {
                    const instrument = window.__reasoningFocusTrace;
                    instrument.observer.disconnect();
                    window.HTMLElement.prototype.focus = instrument.originalFocus;
                    document.removeEventListener('focusin', instrument.focusEvent, true);
                    document.removeEventListener('focusout', instrument.focusEvent, true);
                    document.removeEventListener('keydown', instrument.keyEvent, true);
                    return instrument.events;
                });
                await testInfo.attach('known-native-picker-focus-trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
            }
            expect(trace.afterPositioningFrames.activeInsidePicker).toBe(true);
            expect(trace.afterPositioningFrames.activeText).toBe('Low');
            expect(trace.afterEscape.escapeEvents).toHaveLength(1);
            expect(trace.afterEscape.pickerPresent).toBe(false);
            expect(trace.afterEscape.chipFocused).toBe(true);
        });

        // This same visual-only case runs against the clean base and the candidate.
        test('ordinary native settings and picker preview', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const drawer = page.locator('#sb-openai-advanced');
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            const select = page.locator('#openai_reasoning_effort');
            const settingPresent = await select.isVisible();
            const anchor = settingPresent ? select : drawer.locator(':scope > .inline-drawer-header');
            await anchor.scrollIntoViewIfNeeded();
            await waitForAnimationFrames(page);
            await page.screenshot({ path: testInfo.outputPath('native-preview-settings.png') });
            const measure = selectors => page.evaluate(items => {
                const describe = element => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return { text: element.textContent.trim(), hidden: element.hidden,
                        disabled: 'disabled' in element ? element.disabled : null,
                        display: style.display, visibility: style.visibility, opacity: style.opacity,
                        colour: style.color, background: style.backgroundColor, font: style.font,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
                        displayed: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                        withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight };
                };
                return { viewport: { width: window.innerWidth, height: window.innerHeight },
                    elements: Object.fromEntries(items.map(selector => [selector, Array.from(document.querySelectorAll(selector), describe)])) };
            }, selectors);
            await testInfo.attach('native-preview-settings-geometry', { body: JSON.stringify({ state: settingPresent ? 'control present' : 'before: control absent or hidden',
                ...(await measure(['#openai_reasoning_effort', '#native_reasoning_effort_hint', '#sb-openai-advanced > .inline-drawer-header'])) }, null, 2),
            contentType: 'application/json' });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            const chip = page.locator('#sb-reasoning-effort-button');
            const chipVisible = await chip.isVisible();
            if (chipVisible) await chip.click();
            await waitForAnimationFrames(page);
            const pickerPresent = await page.locator('#sb-reasoning-effort-picker').isVisible();
            await page.screenshot({ path: testInfo.outputPath('native-preview-composer.png') });
            await testInfo.attach('native-preview-composer-geometry', { body: JSON.stringify({ state: pickerPresent ? 'picker present' : chipVisible ? 'before: visible control without picker' : 'before: control absent or hidden',
                ...(await measure(['#sb-reasoning-effort-button', '#sb-reasoning-effort-picker .sb-persona-option', '#send_textarea', '#send_but'])) }, null, 2),
            contentType: 'application/json' });
            if (pickerPresent) await page.keyboard.press('Escape');
        });

        test('ordinary unknown native settings and picker preview', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await chooseModel(page, variant);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const drawer = page.locator('#sb-openai-advanced');
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            const select = page.locator('#openai_reasoning_effort');
            const settingPresent = await select.isVisible();
            const anchor = settingPresent ? select : drawer.locator(':scope > .inline-drawer-header');
            await anchor.scrollIntoViewIfNeeded();
            await waitForAnimationFrames(page);
            await page.screenshot({ path: testInfo.outputPath('unknown-preview-settings.png') });
            const measure = selectors => page.evaluate(items => {
                const describe = element => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return { text: element.textContent.trim(), hidden: element.hidden,
                        disabled: 'disabled' in element ? element.disabled : null,
                        display: style.display, visibility: style.visibility, opacity: style.opacity,
                        colour: style.color, background: style.backgroundColor, font: style.font,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
                        displayed: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                        withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight };
                };
                return { viewport: { width: window.innerWidth, height: window.innerHeight },
                    elements: Object.fromEntries(items.map(selector => [selector, Array.from(document.querySelectorAll(selector), describe)])) };
            }, selectors);
            await testInfo.attach('unknown-preview-settings-geometry', { body: JSON.stringify({ state: settingPresent ? 'control present' : 'before: control absent or hidden',
                ...(await measure(['#openai_reasoning_effort', '#native_reasoning_effort_hint', '#sb-openai-advanced > .inline-drawer-header'])) }, null, 2),
            contentType: 'application/json' });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            const chip = page.locator('#sb-reasoning-effort-button');
            const chipVisible = await chip.isVisible();
            if (chipVisible) await chip.click();
            await waitForAnimationFrames(page);
            const pickerPresent = await page.locator('#sb-reasoning-effort-picker').isVisible();
            await page.screenshot({ path: testInfo.outputPath('unknown-preview-composer.png') });
            await testInfo.attach('unknown-preview-composer-geometry', { body: JSON.stringify({ state: pickerPresent ? 'picker present' : chipVisible ? 'before: visible control without picker' : 'before: control absent or hidden',
                ...(await measure(['#sb-reasoning-effort-button', '#sb-reasoning-effort-picker .sb-persona-option', '#send_textarea', '#send_but'])) }, null, 2),
            contentType: 'application/json' });
            if (pickerPresent) await page.keyboard.press('Escape');
        });

        test('DeepSeek unknown models use the shared hint and proxy restores legacy copy', async ({ page, baseURL }) => {
            await prepare(page, baseURL);
            await page.locator('#chat_completion_source').selectOption('deepseek');
            await page.evaluate(() => {
                const select = window.$('#model_deepseek_select');
                select.append(new window.Option('V4 fixture', 'deepseek-v4-pro'));
                select.append(new window.Option('Unknown fixture', 'fixture/unknown'));
                select.val('deepseek-v4-pro').trigger('change');
            });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const drawer = page.locator('#sb-openai-advanced');
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            const oldHint = page.locator('[data-reasoning-legacy-hint][data-source="deepseek"]');
            await expect(oldHint).toBeHidden();
            await expect(page.locator('#native_reasoning_effort_hint')).toContainText('None');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.evaluate(() => window.$('#model_deepseek_select').val('fixture/unknown').trigger('change'));
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await expect(oldHint).toBeHidden();
            const effortSelect = page.locator('#openai_reasoning_effort');
            await expect(effortSelect).toHaveAttribute('aria-describedby', 'native_reasoning_effort_hint');
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            for (const effort of ['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']) {
                await expect(effortSelect.locator(`option[value="${effort}"]`)).toBeEnabled();
            }
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.evaluate(() => window.$('#openai_reverse_proxy').val('https://fixture.invalid/v1').trigger('input'));
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await expect(oldHint).toBeVisible();
        });

        test('held Google status cannot install context after model changes away and back', async ({ page, baseURL }) => {
            const catalogue = await prepare(page, baseURL);
            const loading = page.locator('#api_button_openai + .api_loading');
            await expect(loading).toHaveCount(1);
            await page.locator('#chat_completion_source').selectOption('makersuite');
            await page.locator('#api_key_makersuite').fill('google-browser-fixture-not-a-real-key');
            await page.locator('#makersuite_model_id').fill('gemini-3.8-flash');
            catalogue.hold = true;
            await page.locator('#api_button_openai').click();
            await expect.poll(() => catalogue.held.length).toBe(1);
            await expect(loading).toBeVisible();
            await page.locator('#makersuite_model_id').fill('gemini-3.1-pro-preview');
            await page.locator('#makersuite_model_id').fill('');
            await page.locator('#makersuite_model_id').fill('gemini-3.8-flash');
            await acknowledgeActiveSettings(page);
            const savedBefore = await page.evaluate(async () => {
                const core = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await response.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.google_model };
            });
            expect(Number.isSafeInteger(savedBefore.revision)).toBe(true);
            expect(savedBefore).toMatchObject({ effort: 'max', model: 'gemini-3.8-flash' });
            await expect(loading).toBeVisible();
            catalogue.hold = false;
            await catalogue.held.pop().fulfill({ json: { data: [{ id: 'gemini-3.8-flash' }],
                reasoning_context: { source: 'makersuite', apiVersion: 'v1beta' } } });
            await expect(loading).toBeHidden();
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            await expect(page.locator('#openai_reasoning_effort option[value="max"]')).toBeEnabled();
            expect(await page.evaluate(async () => {
                const core = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await response.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.google_model };
            })).toEqual(savedBefore);
            const status = page.waitForResponse('**/api/backends/chat-completions/status');
            await page.locator('#api_button_openai').click();
            expect((await status).ok()).toBe(true);
            await expect(page.locator('#openai_reasoning_effort option[value="max"]')).toBeDisabled();

            catalogue.hold = true;
            await page.locator('#api_button_openai').click();
            await expect.poll(() => catalogue.held.length).toBe(1);
            await expect(loading).toBeVisible();
            await page.evaluate(() => {
                window.$('#openai_reverse_proxy').val('https://fixture.invalid/v1').trigger('input');
                window.$('#openai_reverse_proxy').val('').trigger('input');
            });
            await expect(loading).toBeVisible();
            catalogue.hold = false;
            await catalogue.held.pop().fulfill({ json: { data: [{ id: 'gemini-3.8-flash' }],
                reasoning_context: { source: 'makersuite', apiVersion: 'v1beta' } } });
            await expect(loading).toBeHidden();
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            await expect(page.locator('#openai_reasoning_effort option[value="max"]')).toBeEnabled();

            catalogue.hold = true;
            await page.locator('#api_button_openai').click();
            await expect.poll(() => catalogue.held.length).toBe(1);
            const oldSource = catalogue.held.pop();
            expect(oldSource.request().postDataJSON().chat_completion_source).toBe('makersuite');
            catalogue.hold = false;
            await page.locator('#chat_completion_source').selectOption('custom');
            try { await oldSource.fulfill({ json: { data: [{ id: 'gemini-3.8-flash' }],
                reasoning_context: { source: 'makersuite', apiVersion: 'v1beta' } } }); } catch { /* Source switch aborts the request. */ }
            catalogue.hold = true;
            await page.locator('#chat_completion_source').selectOption('makersuite');
            await expect.poll(() => catalogue.held.length).toBe(1);
            const freshSource = catalogue.held.pop();
            expect(freshSource).not.toBe(oldSource);
            expect(freshSource.request().postDataJSON().chat_completion_source).toBe('makersuite');
            await expect(loading).toBeVisible();
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            await expect(page.locator('#openai_reasoning_effort option[value="max"]')).toBeEnabled();
            catalogue.hold = false;
            await freshSource.fulfill({ json: { data: [{ id: 'gemini-3.8-flash' }],
                reasoning_context: { source: 'makersuite', apiVersion: 'v1beta' } } });
            await expect(loading).toBeHidden();
            await expect(page.locator('#openai_reasoning_effort option[value="max"]')).toBeDisabled();
        });

        test('ordinary Groq Send preserves a rejected prompt and retries the supported choice', async ({ page, baseURL }) => {
            await prepare(page, baseURL);
            await chooseModel(page, variant);
            await page.evaluate(async () => {
                const openai = await import('/scripts/openai.js');
                openai.oai_settings.reasoning_effort = 'none';
                window.$('#openai_reasoning_effort').val('none');
                window.$('#model_groq_select').trigger('change');
            });
            await acknowledgeActiveSettings(page);
            await expect(page.locator('#openai_reasoning_effort')).toHaveValue('none');
            await expect(page.locator('#openai_reasoning_effort option[value="none"]')).toBeEnabled();
            const requests = [];
            const reply = 'A single native reasoning reply.';
            await page.route('**/api/backends/chat-completions/generate', async route => {
                if (new URL(route.request().url()).origin !== new URL(baseURL).origin) return route.abort();
                const payload = route.request().postDataJSON();
                requests.push(payload);
                return payload.reasoning_effort === 'none'
                    ? route.fulfill({ status: 400, json: { error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'None is not available for this model. Choose Low, Medium or High.' } } })
                    : route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] } });
            });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            const prompt = 'A native reasoning prompt must survive rejection.';
            const assistantCount = await page.evaluate(async () => (await import('/script.js')).chat.filter(message => !message.is_user).length);
            await acknowledgeActiveSettings(page);
            await page.locator('#send_textarea').fill(prompt);
            await page.locator('#send_but').click();
            await expect.poll(() => requests.length).toBe(1);
            await expect(page.locator('#toast-container')).toContainText('Choose Low, Medium or High');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
            expect(requests[0]).toMatchObject({ chat_completion_source: 'groq', model: variant, reasoning_effort: 'none' });
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
            expect(requests).toHaveLength(2);
            expect(requests[1].reasoning_effort).toBe('high');
            expect(await page.evaluate(async original => {
                const { chat } = await import('/script.js');
                return { users: chat.filter(message => message.is_user && message.mes === original).length,
                    assistants: chat.filter(message => !message.is_user).length };
            }, prompt)).toEqual({ users: 1, assistants: assistantCount + 1 });
            expect(requests[1].messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(prompt))).toHaveLength(1);
        });

        test('Groq retains its preference and exposes unverified unknown choices', async ({ page, baseURL }, testInfo) => {
            await prepare(page, baseURL);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            const drawer = page.locator('#sb-openai-advanced');
            if (!await drawer.locator(':scope > .inline-drawer-content').isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            const select = page.locator('#openai_reasoning_effort');
            await select.scrollIntoViewIfNeeded();
            await expect(select).toHaveValue('max');
            await expect(select.locator('option[value="max"]')).toBeDisabled();
            await expect(select.locator('option[value="none"]')).toBeDisabled();
            await expect(page.locator('#native_reasoning_effort_hint')).toContainText('Choose one before sending');
            const metrics = await select.evaluate(element => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
                    display: style.display, visibility: style.visibility, colour: style.color, background: style.backgroundColor,
                    font: style.font, disabled: element.disabled, viewport: { width: window.innerWidth, height: window.innerHeight } };
            });
            await testInfo.attach('native-settings-geometry', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
            await page.screenshot({ path: testInfo.outputPath('native-settings.png') });
            await acknowledgeActiveSettings(page);
            const revision = await page.evaluate(async () => {
                const core = await import('/script.js');
                const result = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await result.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.groq_model };
            });
            expect(Number.isSafeInteger(revision.revision)).toBe(true);
            expect(revision).toMatchObject({ effort: 'max', model });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await page.locator('#sb-reasoning-effort-button').click();
            const picker = page.locator('#sb-reasoning-effort-picker');
            await expect(picker.getByRole('option')).toHaveText(['Low', 'Medium', 'High']);
            const pickerMetrics = await picker.getByRole('option').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return { text: element.textContent.trim(), hidden: element.hidden, display: style.display, visibility: style.visibility,
                    colour: style.color, background: style.backgroundColor, font: style.font,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
                    viewport: { width: window.innerWidth, height: window.innerHeight } };
            }));
            await testInfo.attach('native-picker-geometry', { body: JSON.stringify(pickerMetrics, null, 2), contentType: 'application/json' });
            await page.screenshot({ path: testInfo.outputPath('native-picker.png') });
            await page.keyboard.press('Escape');
            await waitForAnimationFrames(page);
            expect(await page.evaluate(async () => {
                const core = await import('/script.js');
                const result = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await result.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.groq_model };
            })).toEqual(revision);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            const chip = page.locator('#sb-reasoning-effort-button');
            await chooseModel(page, variant);
            await expect(select).toHaveAttribute('data-reasoning-control-available', 'true');
            await expect(select).toHaveAttribute('aria-describedby', 'native_reasoning_effort_hint');
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            for (const effort of ['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']) {
                await expect(select.locator(`option[value="${effort}"]`)).toBeEnabled();
            }
            await expect(chip).toHaveJSProperty('hidden', false);
            await acknowledgeActiveSettings(page);
            const unknownSaved = await page.evaluate(async () => {
                const core = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await response.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.groq_model };
            });
            expect(Number.isSafeInteger(unknownSaved.revision)).toBe(true);
            expect(unknownSaved).toMatchObject({ effort: 'max', model: variant });
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await expect(chip).toBeVisible();
            await chip.click();
            await expect(page.locator('#sb-reasoning-effort-picker').getByRole('option')).toHaveText(['None', 'Minimum', 'Low', 'Medium', 'High', 'Extra High', 'Maximum']);
            await expect(page.locator('#sb-reasoning-effort-picker').getByRole('option', { name: 'Maximum', exact: true })).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-reasoning-effort-picker')).toHaveCount(0);
            await waitForAnimationFrames(page);
            await expect(chip).toBeFocused();
            expect(await page.evaluate(async () => {
                const core = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: core.getRequestHeaders(), body: '{}' });
                const saved = JSON.parse((await response.json()).settings);
                return { revision: saved._settingsRevision, effort: saved.oai_settings.reasoning_effort, model: saved.oai_settings.groq_model };
            })).toEqual(unknownSaved);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
            await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
            await page.waitForFunction(() => typeof window.NeconyanShell?.openTab === 'function');
            await page.waitForFunction(async () => (await import('/script.js')).characters.some(item => item.name === 'Durable Nova'), null, { timeout: 60000 });
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const character = core.characters.findIndex(item => item.name === 'Durable Nova');
                if (character < 0) throw new Error('The owned reasoning fixture character is missing after reload.');
                await core.selectCharacterById(character, { switchMenu: false });
            });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            const reconnected = page.waitForResponse(response => response.url().endsWith('/api/backends/chat-completions/status')
                && response.request().postDataJSON()?.chat_completion_source === 'groq');
            await page.locator('#api_button_openai').click();
            expect((await reconnected).ok()).toBe(true);
            await expect(page.locator('#model_groq_select')).toHaveValue(variant);
            await expect(select).toHaveValue('max');
            await expect(page.locator('#native_reasoning_effort_hint')).toHaveText('Available reasoning levels are not known for this model.');
            for (const effort of ['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']) {
                await expect(select.locator(`option[value="${effort}"]`)).toBeEnabled();
            }
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await expect(chip).toBeVisible();
            await chip.click();
            await expect(page.locator('#sb-reasoning-effort-picker').getByRole('option')).toHaveText(['None', 'Minimum', 'Low', 'Medium', 'High', 'Extra High', 'Maximum']);
            await expect(page.locator('#sb-reasoning-effort-picker').getByRole('option', { name: 'Maximum', exact: true })).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-reasoning-effort-picker')).toHaveCount(0);
            await expect(chip).toBeFocused();

            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await chooseModel(page, model);
            await expect(select).toHaveAttribute('data-reasoning-control-available', 'true');
            await expect(chip).toHaveJSProperty('hidden', false);
            await page.locator('#left-nav-panel .sb-shell-close').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await expect(chip).toBeVisible();
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('#chat_completion_source').selectOption('custom');
            await expect(select.locator('option[value="none"]')).toBeEnabled();
            const groqReconnect = page.waitForResponse(response => response.url().endsWith('/api/backends/chat-completions/status')
                && response.request().postDataJSON()?.chat_completion_source === 'groq');
            await page.locator('#chat_completion_source').selectOption('groq');
            expect((await groqReconnect).ok()).toBe(true);
            await expect(page.locator('#model_groq_select option')).toHaveCount(models.length);
            await chooseModel(page, model);
            await expect(select.locator('option[value="none"]')).toBeDisabled();
        });
    });
}
