/* global document, NodeFilter */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { normalizeSettings, normalizeSession } from '../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

// eslint-disable-next-line playwright/no-skipped-test -- Never create or delete characters in a shared server.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

async function readStore(account) {
    return (await account.context.request.get('/api/plugins/hopper/store')).json();
}

test('Meower disables Add all when no characters are available', async ({ app }) => {
    const account = await app.account();
    const deleted = await account.context.request.post('/api/characters/delete', {
        headers: account.headers, data: { avatar_url: account.avatar },
    });
    expect(deleted.ok()).toBe(true);
    const page = await openSettings(account);
    await expect(page.locator('.sbtw-invite')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add all', exact: true })).toBeDisabled();
    await expect(page.getByText('No characters are available.', { exact: true })).toBeVisible();
    expect(app.provider.calls).toHaveLength(0);
});

async function openSettings(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async () => (await import('/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js')).openFeed());
    await page.locator('.sbtw-shell').getByRole('button', { name: 'Settings', exact: true }).click();
    return page;
}

test('phone Meower keeps character selection controls inside the screen at the largest text size', async ({ app }, info) => {
    const account = await app.account({ phone: true, configureSettings: saved => { saved.power_user.font_scale = 1.5; } });
    const library = [account.avatar];
    for (let index = 1; index <= 11; index++) {
        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers, data: { ch_name: `Guest ${index}`, description: 'A quiet guest.' },
        });
        expect(created.ok()).toBe(true);
        library.push(await created.text());
    }
    const page = await openSettings(account);
    await expect(page.locator('html')).toHaveCSS('--fontScale', '1.5');
    const heading = page.locator('.sbtw-field-heading');
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('character-selection.png') });
    const layout = await heading.evaluate(element => ({
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
        controls: [...element.querySelectorAll('button, .sbtw-invite-count')].map(control => {
            const bounds = control.getBoundingClientRect();
            const parent = element.getBoundingClientRect();
            return { label: control.textContent, inside: bounds.left >= parent.left && bounds.right <= parent.right + 1 };
        }),
    }));
    expect(layout.contentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
    for (const control of layout.controls) expect(control.inside, control.label).toBe(true);
    const addAll = page.getByRole('button', { name: 'Add all', exact: true });
    await addAll.click();
    await expect(addAll).toBeDisabled();
    await expect(page.locator('.sbtw-invite-count')).toHaveText('12 invited');
    await expect.poll(async () => [...(await readStore(account)).settings.sessions.legacy.invited].sort()).toEqual([...library].sort());
    const lines = await heading.evaluate(element => [...element.querySelectorAll('button')].map(control => {
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        const rects = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0));
        }
        const tops = rects.map(rect => rect.top).sort((a, b) => a - b);
        const lines = tops.filter((top, index) => index === 0 || top - tops[index - 1] > 4).length;
        return { label: control.textContent, lines };
    }));
    for (const control of lines) expect(control.lines, control.label).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(addAll).toBeEnabled();
    await expect.poll(async () => (await readStore(account)).settings.sessions.legacy.invited).toEqual([]);
});

for (const phone of [false, true]) {
    const minimumTarget = phone ? 44 : 32;
    test(`${phone ? 'phone' : 'desktop'} Meower adds the whole character library without replacing invites`, async ({ app }) => {
        const account = await app.account({ phone });
        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers, data: { ch_name: 'Luna', description: 'A quiet astronomer.' },
        });
        expect(created.ok()).toBe(true);
        const luna = await created.text();
        const store = await readStore(account);
        store.settings = normalizeSettings({ activeSessionId: 'one', sessions: {
            one: normalizeSession({ id: 'one', name: 'Friends', invited: [account.avatar, 'Unavailable.png'] }, 'one'),
            two: normalizeSession({ id: 'two', name: 'Other timeline', invited: [luna] }, 'two'),
        } });
        store.feeds = Object.fromEntries(['one', 'two'].map(id => [id, { version: 1, epoch: 'fixture', posts: [], interactions: [] }]));
        await account.post('/api/plugins/hopper/store', store);
        const page = await openSettings(account);
        const search = page.getByRole('searchbox', { name: 'Search characters or tags' });
        const addAll = page.getByRole('button', { name: 'Add all', exact: true });
        const novaCheck = page.locator('.sbtw-invite').filter({ hasText: 'Durable Nova' }).getByRole('checkbox');
        const lunaCheck = page.locator('.sbtw-invite').filter({ hasText: 'Luna' }).getByRole('checkbox');
        await expect(novaCheck).toBeChecked();
        await expect(lunaCheck).not.toBeChecked();
        await expect(addAll).toBeEnabled();
        const heading = page.locator('.sbtw-field-heading');
        expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const bounds = await addAll.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(minimumTarget);
        expect(bounds.height).toBeGreaterThanOrEqual(minimumTarget);
        await search.fill('Durable Nova');
        await expect(lunaCheck).toBeHidden();
        await search.fill('No such character');
        await expect(page.getByText('No characters match this search.', { exact: true })).toBeVisible();
        await expect(page.locator('.sbtw-invite:visible')).toHaveCount(0);
        await expect(addAll).toBeEnabled();
        await search.evaluate(element => { element.dataset.selectionAnchor = 'retained'; });
        await addAll.click();
        await expect(addAll).toBeDisabled();
        await expect(search).toHaveValue('No such character');
        await expect(search).toHaveAttribute('data-selection-anchor', 'retained');
        await expect.poll(async () => (await readStore(account)).settings.sessions.one.invited).toEqual([account.avatar, 'Unavailable.png', luna]);
        expect((await readStore(account)).settings.sessions.two.invited).toEqual([luna]);
        await search.fill('');
        await expect(lunaCheck).toBeVisible();
        await expect(lunaCheck).toBeChecked();
        await lunaCheck.uncheck();
        await expect(addAll).toBeEnabled();
        await addAll.click();
        await expect(addAll).toBeDisabled();
        await expect.poll(async () => (await readStore(account)).settings.sessions.one.invited).toEqual([account.avatar, 'Unavailable.png', luna]);

        await page.close();
        const reopened = await openSettings(account);
        await expect(reopened.locator('.sbtw-invite input:checked')).toHaveCount(2);
        await expect(reopened.getByRole('button', { name: 'Add all', exact: true })).toBeDisabled();
        await reopened.getByRole('button', { name: 'Clear invites', exact: true }).click();
        await expect(reopened.locator('.sbtw-invite input:checked')).toHaveCount(0);
        await expect(reopened.getByRole('button', { name: 'Add all', exact: true })).toBeEnabled();
        await expect.poll(async () => (await readStore(account)).settings.sessions.one.invited).toEqual([]);
        expect(app.provider.calls).toHaveLength(0);
    });
}
