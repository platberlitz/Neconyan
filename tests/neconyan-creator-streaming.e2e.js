/* global globalThis, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

for (const phone of [false, true]) {
    test(`Catelier prefills and streams a real provider reply on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, configureSettings(saved) {
            const profile = saved.extension_settings.connectionManager.profiles[0];
            saved.extension_settings.connectionManager.profiles.push({ ...profile, id: 'kimi', name: 'Kimi writing', model: 'kimi-k3.1-pro' });
        } });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByLabel('Prefill', { exact: true }).fill('{');
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('kimi');
        await creator.getByLabel('Partial prefill', { exact: true }).fill('<think>Plan the character carefully.</think>{"fields":');
        await creator.getByLabel('Stream live output', { exact: true }).check();
        await creator.getByLabel('Prefill', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/catelier-prefill-after-${phone ? 'phone' : 'desktop'}.png` });
        // Desktop covers a saved Kimi profile; phone covers the unchanged current connection path.
        if (phone) await creator.getByLabel('Connection profile', { exact: true }).selectOption('');
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const stored = (await account.post('/api/creator/list')).drafts[0];
        const saved = (await account.post('/api/creator/get', { id: stored.id })).draft;
        expect(saved.writing.connection.prefill).toBe('{');
        expect(saved.writing.connection.partialPrefill).toContain('<think>');
        expect(saved.writing.connection.stream).toBe(true);
        await page.reload();
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        await page.evaluate(async id => globalThis.NeconyanShell.openCreator({ draftId: id }), stored.id);
        await creator.getByRole('button', { name: 'Writing partner', exact: true }).click();
        await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Describe a patient shipwright.');
        app.provider.mode.streamReply = { reasoning: 'Considering the dossier.', first: (phone ? '"fields":' : '') + '{"description":"A patient', rest: 'shipwright."},"questions":[],"coverage":["Added description"]}' };
        await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
        const live = creator.getByLabel('Model reply', { exact: true });
        await expect(live).toHaveValue('{"fields":{"description":"A patient', { timeout: 30000 });
        // Streaming output leads the section so it stays visible while the model writes.
        expect(await creator.locator('[data-creator-live-reply]').evaluate(node => node === node.parentElement.firstElementChild)).toBe(true);
        expect(app.provider.calls.at(-1).completedAt).toBeNull();
        const lastMessage = app.provider.calls.at(-1).messages.at(-1);
        expect(lastMessage.role).toBe('assistant');
        if (!phone) expect(lastMessage.partial).toBe(true);
        await live.scrollIntoViewIfNeeded();
        await expect(creator.getByLabel('Model reasoning', { exact: true })).toHaveValue('Considering the dossier.');
        await page.screenshot({ path: `../screenshots/catelier-stream-after-${phone ? 'phone' : 'desktop'}.png` });
        for (const accent of [null, 'rgba(245, 235, 210, 1)', 'rgba(45, 20, 70, 1)']) {
            if (accent) await page.evaluate(rgba => {
                for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
            }, accent);
            await settleCssTransitions(page);
            const measured = await creator.getByRole('button', { name: 'Expand Model reply', exact: true }).evaluate(node => {
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
                const foreground = luminance(rgba(getComputedStyle(node.querySelector('i')).color));
                const backdrop = luminance(background);
                return { contrast: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05), height: node.getBoundingClientRect().height };
            });
            expect(measured.contrast).toBeGreaterThanOrEqual(3);
            if (phone) expect(measured.height).toBeGreaterThanOrEqual(44);
        }
        const geometry = await live.evaluate(node => ({ width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right, viewport: globalThis.innerWidth, readonly: node.readOnly }));
        expect(geometry.width).toBeGreaterThan(200);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.readonly).toBe(true);
        await creator.getByRole('button', { name: 'Expand Model reply', exact: true }).click();
        const expanded = page.getByRole('dialog', { name: 'Model reply', exact: true });
        await expect(expanded.getByRole('textbox')).toHaveAttribute('readonly', '');
        app.provider.mode.writeStream(' ');
        await expect(expanded.getByRole('textbox')).toHaveValue('{"fields":{"description":"A patient ');
        await expanded.getByRole('button', { name: 'Done', exact: true }).click();
        app.provider.mode.finishStream();
        await expect(creator.getByLabel('Proposed text', { exact: true })).toHaveValue('A patient shipwright.', { timeout: 30000 });
        expect((await account.post('/api/creator/get', { id: stored.id })).draft.card.data.description).toBe('');
    });
}

test('Catelier keeps cancelled, length-limited and disconnected streams out of the card', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
    await page.locator('#sb_character_tab_creator').click();
    const creator = page.locator('#sb_character_creator_panel');
    await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
    await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
    await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
    await creator.getByLabel('Stream live output', { exact: true }).check();
    await creator.getByRole('button', { name: 'Writing partner', exact: true }).click();
    await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Write a description.');
    app.provider.mode.streamReply = { first: '{"fields":{"description":"Do not apply this', rest: '"}}' };
    await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
    await expect(creator.getByLabel('Model reply', { exact: true })).toHaveValue(/Do not apply/, { timeout: 30000 });
    await creator.getByRole('button', { name: 'Cancel active request', exact: true }).click();
    await expect(creator.locator('[data-creator-live-status]')).toHaveText('Cancelled. Nothing was applied.');
    expect(app.provider.calls).toHaveLength(1);
    delete app.provider.mode.streamReply;
    const completeJson = JSON.stringify({ fields: { description: 'Still incomplete.' }, questions: [], coverage: [] });
    app.provider.mode.streamEvents = [{ choices: [{ index: 0, delta: { content: completeJson }, finish_reason: 'length' }] }];
    await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Try again.');
    await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
    await expect(creator.getByText(/ran out of output space/).first()).toBeVisible({ timeout: 30000 });
    delete app.provider.mode.streamEvents;
    app.provider.mode.streamRaw = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: completeJson } }] })}\n\n`;
    await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Try once more.');
    await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
    await expect(creator.getByText(/disconnected before completing/).first()).toBeVisible({ timeout: 30000 });
    delete app.provider.mode.streamRaw;
    const refusedJson = JSON.stringify({ fields: { description: 'I cannot help with this request.' }, questions: [], coverage: [] });
    app.provider.mode.streamEvents = [{ choices: [{ index: 0, delta: { content: refusedJson }, finish_reason: 'stop' }] }];
    await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Try another description.');
    await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
    await expect(creator.getByText(/The model refused the request/).first()).toBeVisible({ timeout: 30000 });
    await expect(creator.locator('[data-creator-live-status]')).toHaveText('Request failed. Nothing was applied.');
    await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
    const stored = (await account.post('/api/creator/list')).drafts[0];
    const saved = (await account.post('/api/creator/get', { id: stored.id })).draft;
    expect(saved.card.data.description).toBe('');
    expect(saved.proposals.every(proposal => !proposal.fields?.description)).toBe(true);
});
