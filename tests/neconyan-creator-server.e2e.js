/* global globalThis, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

for (const phone of [false, true]) {
    test(`Catelier finishes server writing after closing the ${phone ? 'phone' : 'desktop'} page`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: phone, configureSettings(saved) { saved.power_user.reply_generation_location = 'server'; } });
        let page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        let creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption(phone ? '' : 'durable');
        await creator.getByLabel('Maximum output tokens', { exact: true }).fill('1024');
        await creator.getByLabel('Stream live output', { exact: true }).check();
        await creator.getByRole('button', { name: 'Writing partner', exact: true }).click();
        await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Write a shipwright and an active greeting.');
        await creator.getByLabel('personality', { exact: true }).check();
        app.provider.mode.streamReply = { first: '{"fields":{"description":"A patient', rest: ' shipwright."},"coverage":[],"questions":[]}' };
        await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
        await expect(creator.getByLabel('Model reply', { exact: true })).toHaveValue(/A patient/, { timeout: 30000 });
        const stored = (await account.post('/api/creator/list')).drafts[0];
        const status = async () => {
            const response = await account.context.request.post('/api/creator/generation', { headers: { ...account.headers, 'X-Neconyan-Account': 'default-user' }, data: { id: stored.id } });
            expect(response.ok()).toBe(true);
            return (await response.json()).jobs[0];
        };
        await page.close();
        delete app.provider.mode.streamReply;
        app.provider.mode.reply = { choices: [{ message: { content: '{"fields":{"personality":"Patient and practical."},"coverage":[],"questions":[]}' } }] };
        app.provider.mode.finishStream();
        await expect.poll(async () => (await status()).state, { timeout: 30000 }).toBe('completed');
        expect(app.provider.calls).toHaveLength(2);
        const saved = (await account.post('/api/creator/get', { id: stored.id })).draft;
        expect(saved.card.data.description).toBe('');
        expect(saved.proposals[0].changes).toHaveLength(0);
        page = await account.open({ workspace: false });
        await page.evaluate(async id => globalThis.NeconyanShell.openCreator({ draftId: id }), stored.id);
        creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Server requests', exact: true }).click();
        await creator.getByRole('button', { name: 'Check result', exact: true }).click();
        await expect(creator.getByLabel('Saved server output', { exact: true })).toHaveValue(/Patient and practical/);
        await creator.getByRole('button', { name: 'Recover proposal for review', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/catelier-server-requests-${phone ? 'phone' : 'desktop'}.png` });
        const geometry = await creator.getByRole('button', { name: 'Recover proposal for review', exact: true }).evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { height: rect.height, right: rect.right, viewport: globalThis.innerWidth };
        });
        if (phone) expect(geometry.height).toBeGreaterThanOrEqual(44);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        await creator.getByRole('button', { name: 'Recover proposal for review', exact: true }).click();
        await expect(creator.getByLabel('Proposed text', { exact: true }).first()).toHaveValue('A patient shipwright.');
        await creator.getByLabel('Proposed text', { exact: true }).first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/catelier-server-review-${phone ? 'phone' : 'desktop'}.png` });
        expect((await account.post('/api/creator/get', { id: stored.id })).draft.card.data.description).toBe('');
        expect(app.provider.calls).toHaveLength(2);
        const recover = creator.getByRole('button', { name: 'Recover proposal for review', exact: true });
        for (const accent of [null, 'rgba(245, 235, 210, 1)', 'rgba(45, 20, 70, 1)']) {
            if (accent) await page.evaluate(rgba => {
                for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
            }, accent);
            await settleCssTransitions(page);
            const contrast = await recover.evaluate(node => {
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d');
                const rgba = value => {
                    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data];
                };
                let background = [0, 0, 0];
                const ancestors = []; for (let parent = node; parent; parent = parent.parentElement) ancestors.unshift(parent);
                for (const parent of ancestors) {
                    const [r, g, b, a] = rgba(getComputedStyle(parent).backgroundColor);
                    background = [r, g, b].map((channel, i) => channel * a / 255 + background[i] * (1 - a / 255));
                }
                const luminance = rgb => rgb.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
                const foreground = luminance(rgba(getComputedStyle(node).color));
                const backdrop = luminance(background);
                return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
    });
}

test('Catelier cancels server writing and recovers a saved field suggestion after reopening', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ configureSettings(saved) { saved.power_user.reply_generation_location = 'server'; } });
    let page = await account.open({ workspace: false });
    await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
    await page.locator('#sb_character_tab_creator').click();
    let creator = page.locator('#sb_character_creator_panel');
    await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
    await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
    await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
    await creator.getByLabel('Stream live output', { exact: true }).check();
    await creator.getByRole('button', { name: 'Identity', exact: true }).click();
    app.provider.mode.streamReply = { first: '{"value":"Unfinished', rest: '"}' };
    await creator.getByRole('button', { name: 'Generate Description', exact: true }).click();
    await expect(creator.getByLabel('Model reply', { exact: true })).toHaveValue(/Unfinished/, { timeout: 30000 });
    const stored = (await account.post('/api/creator/list')).drafts[0];
    const jobs = async () => {
        const response = await account.context.request.post('/api/creator/generation', { headers: { ...account.headers, 'X-Neconyan-Account': 'default-user' }, data: { id: stored.id } });
        expect(response.ok()).toBe(true);
        return (await response.json()).jobs;
    };
    await creator.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await jobs())[0].state, { timeout: 30000 }).toBe('cancelled');
    expect((await account.post('/api/creator/get', { id: stored.id })).draft.card.data.description).toBe('');
    app.provider.mode.streamReply = { first: '{"value":"Saved', rest: ' shipwright."}' };
    await creator.getByRole('button', { name: 'Generate Description', exact: true }).click();
    await expect(creator.getByLabel('Model reply', { exact: true })).toHaveValue(/Saved/, { timeout: 30000 });
    await page.close();
    app.provider.mode.finishStream();
    await expect.poll(async () => (await jobs()).find(job => job.state === 'completed')?.state, { timeout: 30000 }).toBe('completed');
    page = await account.open({ workspace: false });
    await page.evaluate(async id => globalThis.NeconyanShell.openCreator({ draftId: id }), stored.id);
    creator = page.locator('#sb_character_creator_panel');
    await creator.getByRole('button', { name: 'Server requests', exact: true }).click();
    const completed = creator.locator('[data-creator-server-requests] > section').filter({ has: page.getByRole('heading', { name: /completed/ }) });
    await completed.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(completed.getByLabel('Saved server output', { exact: true })).toHaveValue('{"value":"Saved shipwright."}');
    await completed.getByRole('button', { name: 'Use saved suggestion', exact: true }).click();
    await expect(creator.getByLabel('Description', { exact: true })).toHaveValue('Saved shipwright.');
    expect(app.provider.calls).toHaveLength(2);
});
