/* global document, window */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect, playwright/no-standalone-expect -- Shared viewport and baseline helpers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

const baseline = process.env.NECONYAN_SCRATCHPAD_EDIT_BASELINE_ROOT;
if (baseline) test.use({ initialServerOptions: { checkoutRoot: baseline } });
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';

function picture(blue = false) {
    const image = new PNG({ width: 384, height: 256 });
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const roof = y > 70 && y < 120 && Math.abs(x - 180) < y - 60;
        const house = x > 130 && x < 230 && y >= 120 && y < 215;
        const moon = (x - 295) ** 2 + (y - 55) ** 2 < 25 ** 2;
        const colour = roof ? blue ? [65, 155, 230] : [195, 90, 65] : house ? [226, 191, 139] : moon ? [248, 231, 179] : [35, 57, 79];
        image.data.set([...colour, 255], (y * image.width + x) * 4);
    }
    return PNG.sync.write(image);
}

async function send(page, app, account, reply, prompt) {
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: reply } }] };
    await page.locator('.scratchpad-composer').fill(prompt);
    const waiting = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const response = await waiting;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
}

async function generate(page, card, account, label) {
    const waiting = page.waitForResponse('**/api/scratchpad/images/generate');
    await card.getByRole('button', { name: label, exact: true }).click();
    const response = await waiting;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(card.locator('.scratchpad-generated-image')).toBeVisible();
}

for (const phone of [true, false]) {
    test(`${phone ? 'phone' : 'desktop'} edits saved and attached images only after the chosen action`, async ({ app }) => {
        test.setTimeout(240000);
        const imageProvider = await app.images();
        const original = picture();
        imageProvider.mode.reply = { data: [{ b64_json: original.toString('base64') }] };
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.oai_settings.media_inlining = true;
            saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key',
                gptImageModel: 'gpt-image-2.6-flare', gptImageProxyUrl: `${imageProvider.url}/responses`, width: 1024, height: 1024,
                style: 'none', appendQuality: false, useSTStyle: false, reviewBeforeGenerate: false, setupWizardSeen: true };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await send(page, app, account, fence({ type: 'image', action: 'generate', target: 'image', prompt: 'A moonlit observatory with a red roof.' }), 'Draw a moonlit observatory.');
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        const first = page.locator('.scratchpad-image-card').first();
        await generate(page, first, account, 'Generate image');
        const messageId = await first.locator('xpath=ancestor::*[@data-message-id]').getAttribute('data-message-id');
        const originalUrl = await first.locator('.scratchpad-generated-image').getAttribute('src');
        const savedOriginal = path.join(app.dataRoot, 'default-user', originalUrl.replace(/^\//, ''));
        const originalBytes = await fs.readFile(savedOriginal);
        const edit = { type: 'image', action: 'edit', target: 'image', source: { messageId, kind: 'generated', index: 0 },
            prompt: 'Make the roof blue. Keep the building, moon and night sky unchanged.', reason: 'Change just the roof colour.' };
        await send(page, app, account, fence(edit), 'Make the roof blue in that picture.');
        const size = phone ? 'phone' : 'desktop';
        if (baseline) {
            await expect(page.getByRole('button', { name: 'Edit image', exact: true })).toHaveCount(0);
            await page.evaluate(() => window.toastr.remove());
            await page.screenshot({ path: `../screenshots/scratchpad-edit-${size}-before.png` });
            return;
        }
        expect(JSON.stringify(app.provider.calls.at(-1))).toContain(`Image source {\\"messageId\\":\\"${messageId}\\"`);
        const edited = page.locator('.scratchpad-image-card').nth(1);
        await expect(edited.getByRole('link', { name: 'View source image' })).toHaveAttribute('href', originalUrl);
        expect(imageProvider.calls).toHaveLength(1);
        await checkImageControlContrast(page, ['.scratchpad-image-card button.menu_button_primary', '.scratchpad-image-card >> nth=1 >> a.scratchpad-image-link'], phone);
        imageProvider.mode.reply = { data: [{ b64_json: picture(true).toString('base64') }] };
        await generate(page, edited, account, 'Edit image');
        expect(imageProvider.calls).toHaveLength(2);
        const request = imageProvider.calls[1];
        expect(request.tools[0].action).toBe('edit');
        expect(request.input[0].content.find(part => part.type === 'input_image').image_url).toBe(`data:image/png;base64,${originalBytes.toString('base64')}`);
        expect(await fs.readFile(savedOriginal)).toEqual(originalBytes);
        await edited.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.toastr.remove());
        await page.screenshot({ path: `../screenshots/scratchpad-edit-${size}-after.png` });
        const geometry = await edited.evaluate(element => ({ width: document.documentElement.scrollWidth, card: element.getBoundingClientRect().width,
            image: element.querySelector('img').getBoundingClientRect().width }));
        expect(geometry.width).toBe(phone ? 393 : 1280);
        expect(geometry.image).toBeLessThan(geometry.card);
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await open();
        await expect(edited.locator('.scratchpad-generated-image')).toBeVisible();
        expect(imageProvider.calls).toHaveLength(2);

        await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'observatory.png', mimeType: 'image/png', buffer: original });
        await expect(page.locator('.scratchpad-draft-attachments img')).toBeVisible();
        await send(page, app, account, 'I can use this attached picture for the edit.', 'Use this attached picture next.');
        const uploaded = page.locator('.scratchpad-message').filter({ has: page.locator('.scratchpad-file-preview') }).last();
        const uploadId = await uploaded.getAttribute('data-message-id');
        await send(page, app, account, fence({ ...edit, source: { messageId: uploadId, kind: 'attachment', index: 0 } }), 'Now make this roof blue too.');
        const attachmentEdit = page.locator('.scratchpad-image-card').last();
        await expect(attachmentEdit).toContainText('Edit attached image: observatory.png');
        await generate(page, attachmentEdit, account, 'Edit image');
        expect(imageProvider.calls).toHaveLength(3);
        expect(imageProvider.calls[2].input[0].content.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/png;base64,'))).toBe(true);
        expect(app.navigationErrors).toEqual([]);
    });
}
