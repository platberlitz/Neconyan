/* global document, window */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect, playwright/no-standalone-expect -- Owned baseline/viewport variants and setup helpers share checks. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_IMAGES_BEFORE === '1';
if (before) {
    if (!process.env.NECONYAN_SCRATCHPAD_IMAGES_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_IMAGES_BASELINE_ROOT for before captures.');
    test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_IMAGES_BASELINE_ROOT } });
}
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function mockPicture() {
    const picture = new PNG({ width: 384, height: 256 });
    for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) {
        const moon = (x - 270) ** 2 + (y - 65) ** 2 < 35 ** 2;
        const hill = y > 190 + Math.sin(x / 50) * 15;
        const house = x > 100 && x < 190 && y > 120 && y < 200;
        const roof = y > 85 && y < 125 && Math.abs(x - 145) < y - 85;
        const colour = moon ? [245, 226, 160] : house || roof ? [218, 135, 101] : hill ? [42, 82, 74] : [34, 52, 90];
        const offset = (y * picture.width + x) * 4;
        picture.data.set([...colour, 255], offset);
    }
    return PNG.sync.write(picture);
}

async function openRail(page, phone) {
    if (phone) await page.locator('#sb-hamburger').click();
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="scratchpad"]').click();
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
}

async function sendProposal(page, app, account, text) {
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: text } }] };
    await page.locator('.scratchpad-composer').fill('Suggest the requested picture for me to review.');
    const waiting = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const response = await waiting;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
}

async function generate(card, page, account) {
    const waiting = page.waitForResponse('**/api/scratchpad/images/generate');
    await card.getByRole('button', { name: 'Generate image', exact: true }).click();
    const response = await waiting;
    expect(response.ok(), await response.text()).toBe(true);
    const accepted = await response.json();
    await account.settled(accepted.job.id);
    await expect(card.locator('.scratchpad-generated-image')).toBeVisible();
    return accepted;
}

for (const { phone, textProfile } of [{ phone: true, textProfile: false }, { phone: false, textProfile: false }, { phone: false, textProfile: true }]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size}${textProfile ? ' text completion' : ''} keeps generated images separate from reviewed avatars and preserves the previous PNG`, async ({ app }) => {
        test.setTimeout(240000);
        test.skip(before && textProfile, 'Before screenshots need the phone and desktop layouts only.');
        const imageProvider = await app.images();
        const picture = mockPicture();
        imageProvider.mode.reply = { data: [{ b64_json: picture.toString('base64') }] };
        const account = await app.account({ phone, textProfile, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1',
                gptImageProxyUrl: imageProvider.url, width: 1024, height: 1024, style: 'none', appendQuality: false, useSTStyle: false,
                reviewBeforeGenerate: false, setupWizardSeen: true };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: before });
        if (before) await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        else await openRail(page, phone);
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await sendProposal(page, app, account, before ? 'We can talk through your illustration idea here.'
            : fence({ type: 'image', action: 'generate', target: 'image', prompt: 'A little observatory below a moonlit sky.', reason: 'An illustration of the idea.' }));
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        if (before) {
            await expect(page.locator('.scratchpad-image-card')).toHaveCount(0);
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: `../screenshots/item2-${size}-before.png` });
            return;
        }
        const plain = page.locator('.scratchpad-image-card').first();
        expect(imageProvider.calls).toHaveLength(0);
        if (!textProfile) await checkImageControlContrast(page, ['.scratchpad-image-card button.menu_button_primary'], phone);
        await expect(page.getByRole('button', { name: 'Image idea', exact: true })).toBeVisible();
        const original = await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar));
        await generate(plain, page, account);
        expect(imageProvider.calls).toHaveLength(1);
        expect(hash(await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar)))).toBe(hash(original));
        await expect(plain.getByRole('link', { name: 'Open image', exact: true })).toBeVisible();
        await expect(plain.getByRole('button', { name: 'Review avatar', exact: true })).toHaveCount(0);
        if (!textProfile) await checkImageControlContrast(page, ['.scratchpad-image-link'], phone);
        if (!textProfile) { await plain.scrollIntoViewIfNeeded(); await page.evaluate(() => window.toastr.remove()); await page.screenshot({ path: `../screenshots/item2-${size}-after.png` }); }
        await page.locator('.scratchpad-close').click();
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openRail(page, phone);
        await expect(plain.locator('.scratchpad-generated-image')).toBeVisible();
        expect(imageProvider.calls).toHaveLength(1);
        await page.locator('.scratchpad-close').click();
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await sendProposal(page, app, account, fence({ type: 'image', action: 'generate', target: 'avatar', character: 'Durable Nova', prompt: 'A new portrait for Durable Nova.' }));
        const avatarSources = () => page.evaluate(avatar => [...document.querySelectorAll('img')].filter(image => image.src.includes(encodeURIComponent(avatar))
            || image.src.includes(avatar.replaceAll(' ', '+'))).map(image => image.src), account.avatar);
        const oldAvatarSources = await avatarSources();
        expect(oldAvatarSources.length).toBeGreaterThan(0);
        const avatar = page.locator('.scratchpad-image-card').last();
        await generate(avatar, page, account);
        if (!textProfile) await checkImageControlContrast(page, ['.scratchpad-image-card button.menu_button_primary'], phone);
        expect(imageProvider.calls).toHaveLength(2);
        expect(hash(await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar)))).toBe(hash(original));
        await avatar.getByRole('button', { name: 'Review avatar', exact: true }).click();
        const popup = page.locator('dialog.popup[open]');
        await expect(popup.getByText('Current avatar', { exact: true })).toBeVisible();
        await expect(popup.getByText('Proposed avatar', { exact: true })).toBeVisible();
        const previousUrl = await popup.locator('.scratchpad-avatar-review img').first().getAttribute('src');
        const previous = path.join(app.dataRoot, 'default-user', previousUrl.slice(1));
        expect(hash(await fs.readFile(previous))).toBe(hash(original));
        if (!textProfile) await checkImageControlContrast(page, ['dialog.popup[open] .popup-button-ok'], phone);
        if (!textProfile) { await page.evaluate(() => window.toastr.remove()); await page.screenshot({ path: `../screenshots/item2-${size}-avatar-review.png` }); }
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect(hash(await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar)))).toBe(hash(original));
        if (!textProfile) {
            await avatar.getByRole('button', { name: 'Review avatar', exact: true }).click();
            const edit = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers,
                data: { avatar: account.avatar, data: { description: 'Edited by another tab during review.' } } });
            expect(edit.ok(), await edit.text()).toBe(true);
            const edited = await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar));
            const refused = page.waitForResponse('**/api/characters/edit-avatar');
            await popup.getByRole('button', { name: 'Save change', exact: true }).click();
            expect((await refused).status()).toBe(409);
            expect(hash(await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar)))).toBe(hash(edited));
            await page.evaluate(() => window.toastr.remove());
        }
        await avatar.getByRole('button', { name: 'Review avatar', exact: true }).click();
        const upload = page.waitForResponse('**/api/characters/edit-avatar');
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        const uploaded = await upload;
        expect(uploaded.ok(), await uploaded.text()).toBe(true);
        await expect(avatar).toContainText('Avatar saved');
        await expect.poll(avatarSources).not.toEqual(oldAvatarSources);
        expect(hash(await fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', account.avatar)))).not.toBe(hash(original));
        expect(hash(await fs.readFile(previous))).toBe(hash(original));
        await expect(avatar.getByRole('link', { name: 'Previous avatar', exact: true })).toBeVisible();
        expect(imageProvider.calls).toHaveLength(2);
        const geometry = await page.locator('#neconyan-scratchpad').evaluate(element => {
            const image = element.querySelector('.scratchpad-generated-image').getBoundingClientRect();
            return { documentWidth: document.documentElement.scrollWidth, imageWidth: image.width, panelWidth: element.getBoundingClientRect().width };
        });
        expect(geometry.documentWidth).toBe(phone ? 393 : 1280);
        expect(geometry.imageWidth).toBeLessThan(geometry.panelWidth);
    });
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size}: review before generate opens the processed prompt straight from Generate image`, async ({ app }) => {
        test.setTimeout(240000);
        const imageProvider = await app.images();
        imageProvider.mode.reply = { data: [{ b64_json: mockPicture().toString('base64') }] };
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1',
                gptImageProxyUrl: imageProvider.url, width: 1024, height: 1024, appendQuality: false, useSTStyle: false,
                reviewBeforeGenerate: true, setupWizardSeen: true };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: before });
        if (before) await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        else await openRail(page, phone);
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await sendProposal(page, app, account, fence({ type: 'image', action: 'generate', target: 'image', prompt: 'A little observatory below a moonlit sky.', reason: 'An illustration of the idea.' }));
        const card = page.locator('.scratchpad-image-card').first();
        const accepted = page.waitForResponse('**/api/scratchpad/images/generate');
        await card.getByRole('button', { name: 'Generate image', exact: true }).click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        const job = (await response.json()).job;
        await expect.poll(async () => (await account.job(job.id)).state, { timeout: 30000 }).toBe('waiting');
        if (before) {
            await expect(card.getByRole('button', { name: 'Review image prompt', exact: true })).toBeVisible();
            await expect(card.getByRole('button', { name: 'Stop image', exact: true })).toBeVisible();
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: `../screenshots/scratchpad-review-${size}-before.png` });
            return;
        }
        const popup = page.locator('dialog.popup[open]');
        await expect(popup.getByText('Processed image prompt', { exact: true })).toBeVisible({ timeout: 30000 });
        await expect(popup.locator('.scratchpad-image-prompt')).toContainText('observatory');
        await expect(card.getByRole('button', { name: 'Stop image', exact: true })).toHaveCount(0);
        expect(imageProvider.calls).toHaveLength(0);
        await page.evaluate(() => window.toastr.clear());
        await page.screenshot({ path: `../screenshots/scratchpad-review-${size}-after.png` });
        const approved = page.waitForResponse(response => response.url().includes(`/api/jobs/${job.id}/approval/`));
        await popup.getByRole('button', { name: 'Generate reviewed image', exact: true }).click();
        expect((await approved).ok()).toBe(true);
        await account.settled(job.id);
        await expect(card.locator('.scratchpad-generated-image')).toBeVisible();
        expect(imageProvider.calls).toHaveLength(1);
        await page.locator('.scratchpad-close').click();
    });
}

test('an accepted image finishes after closing the page and remains in its original General list', async ({ app }) => {
    test.skip(before, 'Before captures cover the original UI only.');
    test.setTimeout(180000);
    const imageProvider = await app.images();
    imageProvider.mode.reply = { data: [{ b64_json: mockPicture().toString('base64') }] };
    imageProvider.mode.hold = 'gpt-image-1';
    const account = await app.account({ configureSettings: saved => {
        saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1',
            gptImageProxyUrl: imageProvider.url, width: 1024, height: 1024, appendQuality: false, useSTStyle: false, reviewBeforeGenerate: false, setupWizardSeen: true };
    } });
    let page = await account.open({ workspace: false });
    await openRail(page, false);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await sendProposal(page, app, account, fence({ type: 'image', action: 'generate', target: 'image', prompt: 'Keep this image in General.' }));
    const response = page.waitForResponse('**/api/scratchpad/images/generate');
    await page.locator('.scratchpad-image-card').getByRole('button', { name: 'Generate image', exact: true }).click();
    const accepted = await (await response).json();
    await expect.poll(() => imageProvider.calls.length).toBe(1);
    await page.close();
    await fetch(imageProvider.url.replace(/\/v1$/, '') + '/fixture/release', { method: 'POST', body: '{}' });
    await account.settled(accepted.job.id);
    page = await account.open({ workspace: false });
    await openRail(page, false);
    await expect(page.locator('.scratchpad-generated-image')).toBeVisible();
    expect(imageProvider.calls).toHaveLength(1);
    await page.locator('.scratchpad-close').click();
    await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-image-card')).toHaveCount(0);
});
