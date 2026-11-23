/* global document, getComputedStyle, Storage, window */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { normalizeSettings, normalizeSession } from '../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

test.describe.configure({ mode: 'default' });
test.setTimeout(180000);

async function readStore(account) {
    const response = await account.context.request.get('/api/plugins/hopper/store');
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
}

async function seed(account, settings = {}) {
    const current = await readStore(account);
    current.settings = normalizeSettings({ profileId: 'durable', activeSessionId: 'one',
        profiles: { [`character:${account.avatar}`]: { name: 'Nova', handle: 'nova', bio: 'Astronaut', location: 'Moon' } },
        quotas: { posts: 1, replies: 0, reposts: 0, likes: 0 }, ...settings,
        sessions: { one: normalizeSession({ id: 'one', name: 'Native timeline', invited: [account.avatar], ambient: false }, 'one') } });
    current.feeds = { one: { version: 1, epoch: 'fixture', posts: [], interactions: [] } };
    await account.post('/api/plugins/hopper/store', current);
}

async function openMeower(account, running = false) {
    // Rail readiness precedes asynchronous Home and saved-chat startup routing.
    await account.context.addInitScript(() => {
        window.addEventListener('neconyan:ready', () => { window.meowerFixtureReady = true; }, { once: true });
    });
    const page = await account.open({ workspace: false });
    await page.waitForFunction(() => window.meowerFixtureReady === true);
    await page.evaluate(async () => (await import('/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js')).openFeed());
    if (running) await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeEnabled();
    const geometry = await page.locator('.sbtw-shell').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, display: getComputedStyle(element).display };
    });
    expect(geometry.width).toBeGreaterThan(250);
    expect(geometry.height).toBeGreaterThan(200);
    expect(geometry.display).not.toBe('none');
    return page;
}

async function accepted(page, route, action) {
    const pending = page.waitForResponse(response => response.url().endsWith(route) && response.request().method() === 'POST');
    await action();
    const response = await pending;
    expect(response.status(), await response.text()).toBe(202);
    return (await response.json()).job;
}

async function readableStatus(page, locator) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    const box = await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
            top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
    });
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(0);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.width + 1);
    expect(box.scrollHeight).toBeLessThanOrEqual(box.height + 1);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.viewportHeight);
    expect(box.whiteSpace).toBe('normal');
    expect(box.textOverflow).not.toBe('ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    return box;
}

test('Meower reads an exact cached host catalogue without changing the chosen profile or fetching on render', async ({ app }) => {
    const account = await app.account({ configureSettings(saved) {
        saved.main_api = 'openai';
        Object.assign(saved.oai_settings, { chat_completion_source: 'openrouter', openrouter_model: 'fixture-active' });
        saved.extension_settings.connectionManager.profiles.push({ id: 'cached', name: 'Cached model', api: 'openrouter', mode: 'cc', model: 'fixture-selected' });
    } });
    await account.post('/api/secrets/write', { key: 'api_key_openrouter', value: 'not-a-real-fixture-key' });
    await seed(account, { profileId: 'cached', reasoningEffort: 'low' });
    let catalogues = 0;
    await account.context.route('**/api/backends/chat-completions/status', async route => {
        catalogues++;
        await route.fulfill({ json: { data: [
            { id: 'fixture-active', reasoning: { supported_efforts: ['low'] } },
            { id: 'fixture-selected', reasoning: { supported_efforts: ['high', 'max'] } },
        ] } });
    });
    const page = await openMeower(account);
    await page.evaluate(() => document.getElementById('api_button_openai').click());
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().getChatCompletionSamplerMetadata({ chat_completion_source: 'openrouter' }, 'fixture-selected'))).not.toBeNull();
    const count = catalogues;
    await page.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.sbtw-shell').getByText('Generation', { exact: true }).click();
    const select = page.locator('.sbtw-shell').getByRole('combobox', { name: 'Reasoning effort', exact: true });
    await expect(select).toHaveValue('low');
    await expect(select.locator('option[value="low"]')).toHaveJSProperty('disabled', true);
    await expect(select.locator('option[value="high"]')).toHaveJSProperty('disabled', false);
    await expect(page.getByText('Your saved effort is unavailable for this model. Choose another level or use the connection setting.', { exact: true })).toBeVisible();
    const identities = await page.evaluate(async () => {
        const api = await import('/scripts/extensions/third-party/Neconyan-Hopper/src/api.js');
        const context = window.SillyTavern.getContext();
        const copy = context.getChatCompletionSamplerMetadata({ chat_completion_source: 'openrouter' }, 'fixture-selected');
        copy.reasoning.supported_efforts.push('low');
        return { selected: api.reasoningConnection('cached'), active: api.reasoningConnection(''),
            missing: context.getChatCompletionSamplerMetadata({ chat_completion_source: 'openrouter' }, 'fixture-missing'),
            wrongSource: context.getChatCompletionSamplerMetadata({ chat_completion_source: 'nanogpt' }, 'fixture-selected') };
    });
    expect(identities.selected.model).toBe('fixture-selected');
    expect(identities.selected.metadata.reasoning.supported_efforts).toEqual(['high', 'max']);
    expect(identities.active.model).toBe('fixture-active');
    expect(identities.missing).toBeNull();
    expect(identities.wrongSource).toBeNull();
    expect(catalogues).toBe(count);
    expect(app.provider.calls).toHaveLength(0);
});

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} Meower retains a readable refusal and only explicit Refresh replaces it`, async ({ app }) => {
        const account = await app.account({ phone });
        await seed(account);
        const reason = 'The selected reasoning effort is unavailable for this model. Choose another effort in Meower settings and refresh the timeline.';
        app.provider.mode.httpError = { status: 400, body: { error: { message: reason } } };
        const submissions = [];
        account.context.on('request', request => { if (request.url().endsWith('/api/meower/refresh/submit')) submissions.push(request.postDataJSON()); });
        const page = await openMeower(account);
        const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        await account.settled(job.id, 'failed');
        await expect(page.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeEnabled();
        await page.waitForTimeout(6000); // Read the persistent row after the normal error toast expires.
        const status = page.locator('.sbtw-composer .sbtw-status');
        const geometry = await status.evaluate(element => {
            const css = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return { text: element.textContent, whiteSpace: css.whiteSpace, overflow: css.overflow, textOverflow: css.textOverflow,
                top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight,
                width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight };
        });
        if (process.env.MEOWER_SCREENSHOT_PHASE) {
            await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.screenshot({ path: new URL(`../screenshots/meower-error-${viewport}-${process.env.MEOWER_SCREENSHOT_PHASE}.png`, import.meta.url).pathname });
        }
        await test.info().attach('persistent-error-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
        await expect(status).toBeVisible();
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.text).toContain(reason);
        expect(geometry.whiteSpace).toBe('normal');
        expect(geometry.textOverflow).not.toBe('ellipsis');
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
        const refreshButton = page.getByRole('button', { name: 'Refresh timeline', exact: true });
        await expect(refreshButton).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const store = await readStore(account);
        store.settings.catchUpHours = 1;
        await account.post('/api/plugins/hopper/store', store);
        await page.close();
        const reopened = await openMeower(account);
        await expect(reopened.locator('.sbtw-composer .sbtw-status')).toContainText(reason);
        await expect(reopened.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeEnabled();
        expect(submissions).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(1);
        await reopened.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        await reopened.locator('.sbtw-shell').getByText('Generation', { exact: true }).click();
        const effort = reopened.locator('.sbtw-shell').getByRole('combobox', { name: 'Reasoning effort', exact: true });
        await effort.selectOption('xhigh');
        await reopened.locator('.sbtw-shell').getByRole('button', { name: 'Home', exact: true }).click();
        const replacement = await accepted(reopened, '/api/meower/refresh/submit', () => reopened.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        expect(replacement.id).not.toBe(job.id);
        await account.settled(replacement.id, 'failed');
        expect(app.provider.calls).toHaveLength(2);
        expect(submissions).toHaveLength(2);
        expect(submissions[1].previousJobId).toBe(job.id);
        expect(submissions[1].submissionKey).not.toBe(submissions[0].submissionKey);
    });

    test(`${viewport} Meower settings persist a local effort without mutating the connection`, async ({ app }) => {
        const model = 'models:[anthropic]claude-opus-5.5';
        const account = await app.account({ phone, seedConversation: false, configureSettings(saved) {
            Object.assign(saved.extension_settings.connectionManager.profiles[0], { model, 'reasoning-effort': 'low',
                'custom-reasoning-param-format': 'openai', 'custom-reasoning-param-name': 'reasoning_effort', 'custom-reasoning-documented-levels': 'true' });
            saved.oai_settings.reasoning_effort = 'xhigh';
            saved.oai_settings.custom_reasoning_documented_levels = false;
        } });
        const consoleErrors = [];
        account.context.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${message.location().url}: ${message.text()}`); });
        await seed(account);
        app.provider.mode.reply = { choices: [{ message: { content: JSON.stringify({ posts: [], interactions: [], strangers: [], follows: [], trends: [] }) } }] };
        const page = await openMeower(account);
        await acknowledgeActiveSettings(page);
        const before = (await account.post('/api/settings/get')).settings;
        await page.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('.sbtw-shell').getByText('Generation', { exact: true }).click();
        if (process.env.MEOWER_SCREENSHOT_PHASE === 'before') {
            await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.locator('.sbtw-shell').getByText('Reply budget (tokens)', { exact: true }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: new URL(`../screenshots/meower-reasoning-settings-${viewport}-before.png`, import.meta.url).pathname });
        }
        const effort = page.locator('.sbtw-shell').getByRole('combobox', { name: 'Reasoning effort', exact: true });
        // The picker renders this control inside a label; assert the native option property directly.
        await expect(effort.locator('option[value="min"]')).toHaveJSProperty('disabled', true);
        await expect(effort.locator('option[value="xhigh"]')).toHaveJSProperty('disabled', false);
        await effort.selectOption('xhigh');
        await expect(effort).toHaveValue('xhigh');
        const betweenEffortAndBudget = await effort.evaluate(select => {
            let sibling = select.closest('.sbtw-field').nextSibling;
            let text = '';
            while (sibling) {
                if (sibling.nodeType === 1 && sibling.querySelector('.sbtw-field-label')?.textContent === 'Reply budget (tokens)') return text;
                if (sibling.nodeType === 3) text += sibling.textContent;
                sibling = sibling.nextSibling;
            }
            throw new Error('The reply budget field must follow the effort field.');
        });
        expect(betweenEffortAndBudget.trim()).toBe('');
        if (process.env.MEOWER_SCREENSHOT_PHASE) {
            await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.locator('.sbtw-shell').getByRole('combobox', { name: 'Reasoning effort', exact: true }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: new URL(`../screenshots/meower-reasoning-settings-${viewport}-${process.env.MEOWER_SCREENSHOT_PHASE}.png`, import.meta.url).pathname });
        }
        await page.locator('.sbtw-shell').getByRole('button', { name: 'Home', exact: true }).click();
        const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        await account.settled(job.id);
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].body.model).toBe(model);
        expect(app.provider.calls[0].body.reasoning_effort).toBe('xhigh');
        expect(app.provider.calls[0].max_tokens).toBe(32768);
        expect((await readStore(account)).settings.reasoningEffort).toBe('xhigh');
        const after = JSON.parse((await account.post('/api/settings/get')).settings);
        expect(after.oai_settings).toEqual(JSON.parse(before).oai_settings);
        expect(after.extension_settings.connectionManager.profiles).toEqual(JSON.parse(before).extension_settings.connectionManager.profiles);
        await page.close();
        const reopened = await openMeower(account);
        await reopened.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        await reopened.locator('.sbtw-shell').getByText('Generation', { exact: true }).click();
        await expect(reopened.locator('.sbtw-shell').getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveValue('xhigh');
        expect(consoleErrors).toEqual([]);
        expect(app.navigationErrors).toEqual([]);
    });

    test(`${viewport} Meower wraps a 500-character operation refusal after the toast expires`, async ({ app }) => {
        const account = await app.account({ phone });
        await seed(account);
        const reason = ('The fixture request exceeded its declared output limit; choose a smaller reply budget and try again. ').repeat(6).slice(0, 500);
        app.provider.mode.httpError = { status: 400, body: { error: { message: reason } } };
        const page = await openMeower(account);
        const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        await account.settled(job.id, 'failed');
        const status = page.locator('.sbtw-composer .sbtw-status');
        await expect(status).toHaveText(reason);
        await page.waitForTimeout(6000);
        const geometry = await readableStatus(page, status);
        await expect(page.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeInViewport();
        await test.info().attach('stress-operation-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
        if (process.env.MEOWER_SCREENSHOT_PHASE) {
            await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.screenshot({ path: new URL(`../screenshots/meower-error-stress-${viewport}-${process.env.MEOWER_SCREENSHOT_PHASE}.png`, import.meta.url).pathname });
        }
    });

    for (const failure of ['draft', 'sync', 'save']) test(`${viewport} Meower ${failure} failure stays readable through patches and rerender without losing a draft`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings(saved) {
            saved.user_avatar = 'default.png';
            saved.power_user.personas['default.png'] = 'Fixture user';
            saved.power_user.persona_descriptions['default.png'] = { description: 'A fixture botanist.' };
        } });
        await seed(account);
        const seeded = await readStore(account);
        seeded.settings.sessions.one.personaId = account.personaId;
        await account.post('/api/plugins/hopper/store', seeded);
        const page = await openMeower(account);
        const draft = page.locator('.sbtw-shell .sbtw-composer textarea.sbtw-composer-input');
        await draft.fill('Keep this unsent draft and its focus.');
        await expect(draft).toBeFocused();
        const compact = page.locator('.sbtw-composer .sbtw-save-status');
        await expect(compact).toHaveAttribute('data-state', 'saved');
        // The existing 620px phone rule wraps routine save status.
        expect(await compact.evaluate(element => getComputedStyle(element).whiteSpace)).toBe(phone ? 'normal' : 'nowrap');
        const reason = `Fixture ${failure} could not be saved. Keep this tab open while you restore the connection, export recovery, and retry saving your changes.`;
        const refusedMethods = [];
        if (failure === 'draft') {
            await page.evaluate(message => {
                const original = Storage.prototype.setItem;
                Storage.prototype.setItem = function (key, value) {
                    if (key.startsWith('hopper:draft:')) throw new Error(message);
                    return original.call(this, key, value);
                };
            }, reason);
            await draft.fill('Keep this unsent draft and its focus. Still here.');
        } else {
            await page.route(url => url.pathname === '/api/plugins/hopper/store', async route => {
                if ((failure === 'save') === (route.request().method() === 'POST')) {
                    refusedMethods.push(route.request().method());
                    await route.fulfill({ status: 503, json: { error: reason } });
                }
                else await route.continue();
            });
            if (failure === 'save') await page.evaluate(async () => {
                const api = await import('/scripts/extensions/third-party/Neconyan-Hopper/src/api.js');
                api.updateSettings({ reasoningEffort: 'high' });
                await api.flushFeed().catch(() => {});
            });
            else await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        }
        await expect(compact).toHaveAttribute('data-state', 'error');
        await expect(compact).toContainText(reason);
        if (failure !== 'draft') {
            expect(refusedMethods.length).toBeGreaterThan(0);
            expect(refusedMethods.every(method => method === (failure === 'save' ? 'POST' : 'GET'))).toBe(true);
        }
        await expect(draft).toBeFocused();
        await expect(draft).toHaveValue(/Keep this unsent draft/);
        const patched = await readableStatus(page, compact);
        await expect(page.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeInViewport();
        await page.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        const initial = page.locator('.sbtw-recovery-section .sbtw-save-status');
        await expect(initial).toHaveAttribute('data-state', 'error');
        await expect(initial).toContainText(reason);
        const rerendered = await readableStatus(page, initial);
        await test.info().attach(`${failure}-geometry`, { body: JSON.stringify({ patched, rerendered }, null, 2), contentType: 'application/json' });
        if (process.env.MEOWER_SCREENSHOT_PHASE) {
            await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.screenshot({ path: new URL(`../screenshots/meower-${failure}-error-${viewport}-${process.env.MEOWER_SCREENSHOT_PHASE}.png`, import.meta.url).pathname });
        }
    });

    test(`${viewport} Meower refresh and image finish with every page closed`, async ({ app, browser }) => {
        const images = await app.images();
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = { provider: 'local', localUrl: images.url.replace(/\/v1$/, ''),
                localType: 'stable-diffusion', a1111Model: 'nova.safetensors', sampler: 'euler_a' };
        } });
        await seed(account, { incremental: phone, images: { enabled: true, perRefresh: 1 } });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
            posts: [{ authorHandle: 'nova', tempId: 'one', content: 'A garden on the moon.', imagePrompt: 'Roses on the moon' }],
            interactions: [], strangers: [], follows: [], trends: [],
        }) } }] };
        app.provider.mode.hold = MODEL;
        const page = await openMeower(account);
        const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.release();
        await account.settled(job.id);
        const store = await readStore(account);
        expect(store.feeds.one.posts).toHaveLength(1);
        expect(store.feeds.one.posts[0].body).toBe('A garden on the moon.');
        const image = await account.context.request.get(store.feeds.one.posts[0].image.url);
        expect((await image.body()).subarray(1, 4).toString()).toBe('PNG');
        const reopened = await openMeower(account);
        await expect(reopened.locator('.sbtw-shell')).toContainText('A garden on the moon.');
        // Read the retained completion through the real observer, without submitting again.
        await reopened.getByRole('button', { name: 'Refresh timeline', exact: true }).click();
        await expect(reopened.getByRole('button', { name: 'Refresh timeline', exact: true })).toBeEnabled();
        // Loading the image adds its measured dimensions to the same saved post.
        expect((await readStore(account)).feeds).toMatchObject(store.feeds);
        expect(app.provider.calls).toHaveLength(1);
        expect(images.calls).toHaveLength(1);
    });

    test(`${viewport} Meower profile regeneration finishes with every page closed`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        await seed(account);
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ profiles: [
            { entityId: account.avatar, name: 'Moon Nova', handle: 'moon_nova', bio: 'A new profile saved without a page.', location: 'Moon' },
        ] }) } }] };
        app.provider.mode.hold = MODEL;
        const page = await openMeower(account);
        await page.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('.sbtw-shell').getByText('Cast upkeep', { exact: true }).click();
        const job = await accepted(page, '/api/meower/profile/submit', () => page.getByRole('button', { name: 'New profiles for everyone', exact: true }).click());
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.release();
        await account.settled(job.id);
        const store = await readStore(account);
        expect(store.settings.profiles[`character:${account.avatar}`]).toMatchObject({ handle: 'moon_nova', bio: 'A new profile saved without a page.' });
        const reopened = await openMeower(account);
        await reopened.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
        await reopened.locator('.sbtw-shell').getByText('Cast upkeep', { exact: true }).click();
        await reopened.getByRole('button', { name: 'New profiles for everyone', exact: true }).click();
        await expect(reopened.getByRole('button', { name: 'New profiles for everyone', exact: true })).toBeEnabled();
        expect((await readStore(account)).settings.profiles).toEqual(store.settings.profiles);
        expect(app.provider.calls).toHaveLength(1);
    });

    test(`${viewport} reopening observes the accepted refresh and Stop persists`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        await seed(account);
        app.provider.mode.hold = MODEL;
        const page = await openMeower(account);
        const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const reopened = await openMeower(account, true);
        await reopened.getByRole('button', { name: 'Stop', exact: true }).click();
        await account.settled(job.id, 'cancelled');
        await app.release();
        expect((await readStore(account)).feeds.one.posts).toHaveLength(0);
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('Meower restart preserves an unknown paid outcome without submitting again', async ({ app, browser }) => {
    const account = await app.account();
    await seed(account);
    app.provider.mode.hold = MODEL;
    const page = await openMeower(account);
    const job = await accepted(page, '/api/meower/refresh/submit', () => page.getByRole('button', { name: 'Refresh timeline', exact: true }).click());
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    await app.restart();
    const interrupted = await account.settled(job.id, 'interrupted');
    expect(interrupted.error.message).toContain('unknown after a restart');
    expect(interrupted.recoverySteps.length).toBeGreaterThan(0);
    await app.release();
    const reopened = await openMeower(account);
    await reopened.getByRole('button', { name: 'Refresh timeline', exact: true }).click();
    await expect(reopened.locator('.sbtw-shell')).toContainText(/interrupted|unknown|Review it in Jobs/);
    expect((await readStore(account)).feeds.one.posts).toHaveLength(0);
    expect(app.provider.calls).toHaveLength(1);
});
