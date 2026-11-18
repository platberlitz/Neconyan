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
const OPUS_MODEL = 'claude-code/claude-opus-5-5';

function visionConnection(saved, url) {
    saved.oai_settings.media_inlining = false;
    Object.assign(saved.extension_settings.connectionManager.profiles[0], { api: 'openai', model: 'gpt-4o', proxy: 'Scratchpad vision fixture' });
    saved.proxies = [{ name: 'Scratchpad vision fixture', url, password: 'fixture-chat-key', source: 'openai' }];
}

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
            saved.oai_settings.media_inlining = false;
            saved.extension_settings.connectionManager.profiles[0].model = OPUS_MODEL;
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
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await open();
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
        const feedback = app.provider.calls.at(-1);
        expect(feedback.model).toBe(OPUS_MODEL);
        expect(feedback.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url'))
            .toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${originalBytes.toString('base64')}`, detail: 'auto' } }]);
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

    test(`${phone ? 'phone' : 'desktop'} reviews edited character, persona and Scenario Note avatars before replacing them`, async ({ app }) => {
        test.setTimeout(240000);
        const images = await app.images();
        const original = picture();
        const replacement = picture(true);
        images.mode.reply = { data: [{ b64_json: original.toString('base64') }] };
        const personaId = 'Scratchpad Portrait.png';
        const oldNoteUrl = '/user/images/Scratchpad/previous-note.png';
        const notes = [{ id: 'harbour', name: 'At the harbour', description: 'Waiting for the ferry.', avatar: oldNoteUrl },
            { id: 'home', name: 'At home', description: 'A quiet afternoon.' }];
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            visionConnection(saved, app.provider.url);
            saved.user_avatar = personaId;
            saved.name1 = 'Kris';
            saved.power_user.default_persona = personaId;
            saved.power_user.personas[personaId] = 'Kris';
            saved.power_user.persona_descriptions[personaId] = { description: 'A traveller with a notebook.', appendices: notes,
                activeAppendices: {}, connections: [] };
            saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key',
                gptImageModel: 'gpt-image-2.6-flare', gptImageProxyUrl: `${images.url}/responses`, width: 1024, height: 1024,
                style: 'none', appendQuality: false, useSTStyle: false, reviewBeforeGenerate: false, setupWizardSeen: true };
        } });
        const root = path.join(app.dataRoot, 'default-user');
        const personaFile = path.join(root, 'User Avatars', personaId);
        const characterFile = path.join(root, 'characters', account.avatar);
        await fs.writeFile(personaFile, original);
        await fs.mkdir(path.dirname(path.join(root, oldNoteUrl)), { recursive: true });
        await fs.writeFile(path.join(root, oldNoteUrl), original);
        const savedPersona = async () => JSON.parse((await account.post('/api/settings/get')).settings).power_user.persona_descriptions[personaId];
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.context.addInitScript(() => window.addEventListener('neconyan:ready', () => { window.scratchpadEditReady = true; }, { once: true }));
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => window.scratchpadEditReady);
        await expect(page.locator('body')).not.toHaveClass(/neconyan-home-booting/);
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/scratchpad/context.js')).currentSource().avatar)).toBe(account.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        if (phone) await applyIOSOnlyCss(page);
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/scratchpad/context.js')).currentSource().avatar)).toBe(account.avatar);
        await send(page, app, account, fence({ type: 'image', action: 'generate', target: 'image', prompt: 'An observatory portrait with a red roof.' }), 'Draw an observatory.');
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        const first = page.locator('.scratchpad-image-card').first();
        await generate(page, first, account, 'Generate image');
        const messageId = await first.locator('xpath=ancestor::*[@data-message-id]').getAttribute('data-message-id');
        const originalUrl = await first.locator('.scratchpad-generated-image').getAttribute('src');
        images.mode.reply = { data: [{ b64_json: replacement.toString('base64') }] };
        let savedNoteUrl;
        for (const destination of [{ target: 'avatar', character: 'Durable Nova' }, { target: 'persona-avatar', persona: 'Kris' },
            { target: 'persona-note-avatar', persona: 'Kris', noteId: 'harbour' }]) {
            const beforePersona = await savedPersona();
            const file = destination.target === 'avatar' ? characterFile : destination.target === 'persona-avatar' ? personaFile : path.join(root, oldNoteUrl);
            const before = await fs.readFile(file);
            await send(page, app, account, fence({ type: 'image', action: 'edit', ...destination,
                source: { messageId, kind: 'generated', index: 0 }, prompt: 'Make the roof blue; keep the rest unchanged.' }),
            `Edit that picture and use it for ${destination.target}.`);
            const outgoing = app.provider.calls.at(-1).messages;
            expect(outgoing.flatMap(message => Array.isArray(message.content) ? message.content : [])
                .some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${original.toString('base64')}`)).toBe(true);
            const card = page.locator('.scratchpad-image-card').last();
            await generate(page, card, account, 'Edit image');
            expect(images.calls.at(-1).tools[0].action).toBe('edit');
            expect(images.calls.at(-1).input[0].content.find(part => part.type === 'input_image').image_url).toBe(`data:image/png;base64,${original.toString('base64')}`);
            expect(await fs.readFile(file)).toEqual(before);
            expect(await savedPersona()).toEqual(beforePersona);
            await card.getByRole('button', { name: 'Review avatar', exact: true }).click();
            const popup = page.locator('dialog.popup[open]');
            await expect(popup.getByText('Proposed avatar', { exact: true })).toBeVisible();
            const previous = await popup.locator('.scratchpad-avatar-review img').first().getAttribute('src');
            const proposed = await popup.locator('.scratchpad-avatar-review img').last().getAttribute('src');
            expect(await fs.readFile(path.join(root, previous))).toEqual(before);
            await page.evaluate(() => window.toastr.remove());
            await page.screenshot({ path: `../screenshots/scratchpad-edit-${destination.target}-${phone ? 'phone' : 'desktop'}.png` });
            await popup.getByRole('button', { name: 'Not now', exact: true }).click();
            expect(await fs.readFile(file)).toEqual(before);
            expect(await savedPersona()).toEqual(beforePersona);
            await card.getByRole('button', { name: 'Review avatar', exact: true }).click();
            await popup.getByRole('button', { name: 'Save change', exact: true }).click();
            await expect(card).toContainText('Avatar saved');
            if (destination.target === 'persona-note-avatar') {
                savedNoteUrl = proposed;
                await expect.poll(async () => (await savedPersona()).appendices[0].avatar).toBe(proposed);
                expect(await savedPersona()).toEqual({ ...beforePersona, appendices: [{ ...notes[0], avatar: proposed }, notes[1]] });
            } else {
                expect(PNG.sync.read(await fs.readFile(file)).data).toEqual(PNG.sync.read(replacement).data);
            }
            expect(await fs.readFile(path.join(root, previous))).toEqual(before);
            expect(await fs.readFile(path.join(root, originalUrl))).toEqual(original);
        }
        expect(images.calls).toHaveLength(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        expect((await savedPersona()).appendices[0].avatar).toBe(savedNoteUrl);
        expect(PNG.sync.read(await fs.readFile(personaFile)).data).toEqual(PNG.sync.read(replacement).data);
        expect(PNG.sync.read(await fs.readFile(characterFile)).data).toEqual(PNG.sync.read(replacement).data);
        expect(app.navigationErrors).toEqual([]);
    });
}
