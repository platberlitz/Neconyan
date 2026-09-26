/* global getComputedStyle */
import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';
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
    const page = await account.open({ workspace: false });
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

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
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
    expect(interrupted.error.message).toContain('provider result is unknown');
    expect(interrupted.recoverySteps.length).toBeGreaterThan(0);
    await app.release();
    const reopened = await openMeower(account);
    await reopened.getByRole('button', { name: 'Refresh timeline', exact: true }).click();
    await expect(reopened.locator('.sbtw-shell')).toContainText(/interrupted|unknown|Review it in Jobs/);
    expect((await readStore(account)).feeds.one.posts).toHaveLength(0);
    expect(app.provider.calls).toHaveLength(1);
});
