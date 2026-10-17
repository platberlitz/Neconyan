/* global window */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { test } from './neconyan-conversation-durable-fixture.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'} compatible preview and replacement save the current image choice`, async ({ app }, testInfo) => {
    test.setTimeout(180000);
    const account = await app.account({ phone });
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, url }) => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(char => char.avatar === avatar), { switchMenu: false });
        core.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Keep my message.', extra: {
            media: [{ type: 'image', url, title: 'An image for review' }],
        } });
        if (!await core.saveChatConditional()) throw new Error('Fixture chat was not saved.');
        void (await import('/scripts/prompt-media-ui.js')).showPromptMediaReview();
    }, { avatar: account.avatar, url: `data:image/png;base64,${png.toString('base64')}` });
    const panel = page.locator('#prompt-media-review');
    const choice = panel.getByRole('combobox', { name: 'What the model receives from this image' });
    await expect(choice).toHaveValue('include');
    const bounds = await panel.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
    await choice.selectOption('display-only');
    await panel.getByRole('button', { name: 'Prepare a converted copy', exact: true }).click();
    const preview = page.locator('dialog').filter({ has: page.getByRole('heading', { name: 'Save this compatible copy?' }) });
    await expect(preview.getByAltText('Prepared compatible copy')).toBeVisible();
    const materialised = page.waitForResponse(response => response.url().endsWith('/images/materialise'));
    await preview.getByRole('button', { name: 'Save copy', exact: true }).click();
    expect((await materialised).ok()).toBe(true);
    await expect(panel.getByRole('button', { name: 'Save choice', exact: true })).toBeEnabled();
    await fs.mkdir('../screenshots', { recursive: true });
    await page.screenshot({ path: `../screenshots/pr-185-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_REVIEW_SCREENSHOT_STAGE ?? 'after'}.png` });
    await expect(choice).toHaveValue('display-only');

    await choice.selectOption('caption');
    await panel.getByRole('textbox', { name: 'Type the description the model receives' }).fill('A reviewed red square.');
    await panel.locator('input[type="file"]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png });
    await expect(preview.getByAltText('Prepared compatible copy')).toBeVisible();
    const replacement = page.waitForResponse(response => response.url().endsWith('/images/materialise'));
    await preview.getByRole('button', { name: 'Save copy', exact: true }).click();
    expect((await replacement).ok()).toBe(true);
    await expect(panel.getByRole('button', { name: 'Save choice', exact: true })).toBeEnabled();
    await expect(choice).toHaveValue('caption');
    await expect(panel.getByRole('textbox', { name: 'Type the description the model receives' })).toHaveValue('A reviewed red square.');
    const saved = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
    expect(saved.mes).toBe('Keep my message.');
    expect(saved.extra.media[0].neconyan_prompt).toMatchObject({ mode: 'caption', caption: { source: 'custom', text: 'A reviewed red square.' } });
    expect(saved.extra.media[0].url).toBe(`data:image/png;base64,${png.toString('base64')}`);
    await choice.selectOption('detach');
    await panel.getByRole('button', { name: 'Prepare a converted copy', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('To remove the image, use Save choice');
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.media.length)).toBe(1);
    const contrast = await checkImageControlContrast(page, ['#prompt-media-review fieldset button'], phone);
    await testInfo.attach('image-choice-contrast', { body: JSON.stringify(contrast, null, 2), contentType: 'application/json' });
});

test('opening legacy attachments keeps their descriptions subject to the image choice', async ({ app }) => {
    const account = await app.account();
    const page = await account.open({ workspace: false });
    const result = await page.evaluate(async () => {
        const { ensureMessageMediaIsArray } = await import('/script.js');
        const { createPromptMediaContext, selectPromptMedia, promptMediaText } = await import('/scripts/prompt-media-policy.js');
        const { promptAttachmentHash } = await import('/scripts/prompt-media-client.js');
        const context = createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images: 'display-only' } } });
        const messages = [
            { mes: 'Authored text', extra: { image: '/user/images/legacy.png', title: 'Legacy image description', append_title: true } },
            { mes: 'Gallery text', extra: { image: '/user/images/second.png', image_swipes: ['/user/images/first.png', '/user/images/second.png'], title: 'Gallery image description', append_title: true } },
            { mes: 'Modern text', extra: { media: [{ type: 'image', url: '/user/images/modern.png' }], title: 'Authored message title', append_title: true } },
        ];
        for (const message of messages) ensureMessageMediaIsArray(message);
        const projection = selectPromptMedia([{}, ...messages], context, { hash: promptAttachmentHash });
        return { messages: JSON.parse(JSON.stringify(messages)), prompt: projection.records.slice(1).map((message, index) => ({
            text: promptMediaText(message, index, projection), appendTitle: Boolean(message.extra.append_title),
        })) };
    });
    expect(result.messages[0].extra.media[0].title).toBe('Legacy image description');
    expect(result.messages[1].extra.media.map(item => item.title)).toEqual(['Gallery image description', 'Gallery image description']);
    expect(result.messages[1].extra.media_index).toBe(1);
    expect(result.prompt).toEqual([
        { text: 'Authored text', appendTitle: false },
        { text: 'Gallery text', appendTitle: false },
        { text: 'Modern text', appendTitle: true },
    ]);
});
