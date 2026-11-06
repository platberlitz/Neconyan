/* global document, window */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Baseline and viewport variants share the same fixture. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

const baseline = process.env.NECONYAN_SCRATCHPAD_PERSONAS_BASELINE_ROOT;
if (baseline) test.use({ initialServerOptions: { checkoutRoot: baseline } });
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';
const avatarId = 'Scratchpad Persona.png';
const notes = [{ id: 'harbour', name: 'At the harbour', description: 'Waiting for the ferry.' }, { id: 'home', name: 'At home', description: 'A quiet afternoon.' }];
function picture(colour) {
    const image = new PNG({ width: 128, height: 128 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([...colour, 255], i);
    return PNG.sync.write(image);
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size}: creates Personas and Scenario Notes through review`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, configureSettings: saved => {
            saved.user_avatar = avatarId;
            saved.name1 = 'Kris';
            saved.power_user.default_persona = avatarId;
            saved.power_user.personas[avatarId] = 'Kris';
            saved.power_user.persona_descriptions[avatarId] = { description: 'A traveller with a notebook.', title: 'Traveller', appendices: structuredClone(notes), activeAppendices: {}, connections: [] };
        } });
        await fs.writeFile(path.join(app.dataRoot, 'default-user', 'User Avatars', avatarId), picture([190, 130, 95]));
        const page = await account.open({ workspace: true, timeout: 60000 });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const settings = async () => JSON.parse((await account.post('/api/settings/get')).settings);
        const before = await settings();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: [
            'Here are the drafts for your review.',
            fence({ type: 'persona', action: 'create', name: 'Rowan', description: '{{user}} maps distant islands.', title: 'Cartographer' }),
            fence({ type: 'persona-note', action: 'create', persona: 'Kris', name: 'Storm at sea', description: '{{user}} waits below deck.' }),
        ].join('\n') } }] };
        await page.locator('.scratchpad-composer').fill('Create a new Persona and a Scenario Note for Kris.');
        const waiting = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await waiting;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        await page.evaluate(() => window.toastr.remove());
        const reviews = page.getByRole('button', { name: 'Review', exact: true });
        if (baseline) {
            await expect(reviews).toHaveCount(0);
            await page.screenshot({ path: `../screenshots/scratchpad-create-personas-${size}-before.png` });
            return;
        }
        await expect(reviews).toHaveCount(2);
        await reviews.first().click();
        const popup = page.locator('dialog.popup[open]');
        const text = popup.getByRole('textbox', { name: 'Proposed text', exact: true });
        await expect(text).toHaveValue(/Cartographer/);
        await checkImageControlContrast(page, ['dialog.popup[open] .popup-button-ok'], phone);
        const box = await text.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: `../screenshots/scratchpad-create-personas-${size}-after.png` });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await settings()).power_user.personas).toEqual(before.power_user.personas);
        await reviews.first().click();
        await text.fill(JSON.stringify({ name: 'Rowan Vale', description: '{{user}} maps distant islands.', title: 'Cartographer' }, null, 2));
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(page.locator('.scratchpad-change-state', { hasText: 'Saved' })).toHaveCount(1);
        await expect(reviews).toHaveCount(1);
        const afterPersona = await settings();
        const created = Object.keys(afterPersona.power_user.personas).filter(id => !Object.hasOwn(before.power_user.personas, id));
        expect(created).toHaveLength(1);
        expect(afterPersona.power_user.personas[created[0]]).toBe('Rowan Vale');
        expect(afterPersona.power_user.persona_descriptions[created[0]].description).toBe('{{user}} maps distant islands.');
        expect(afterPersona.user_avatar).toBe(avatarId);
        expect(afterPersona.power_user.default_persona).toBe(avatarId);
        expect((await fs.stat(path.join(app.dataRoot, 'default-user', 'User Avatars', created[0]))).size).toBeGreaterThan(0);
        await reviews.first().click();
        await expect(text).toHaveValue(/Storm at sea/);
        await page.screenshot({ path: `../screenshots/scratchpad-create-notes-${size}-after.png` });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await settings()).power_user.persona_descriptions[avatarId].appendices).toEqual(notes);
        await reviews.first().click();
        await text.fill(JSON.stringify({ name: 'After the storm', description: '{{user}} returns to the deck.' }, null, 2));
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(page.locator('.scratchpad-change-state', { hasText: 'Saved' })).toHaveCount(2);
        await expect(reviews).toHaveCount(0);
        const after = await settings();
        const parent = after.power_user.persona_descriptions[avatarId];
        expect(parent.appendices.slice(0, 2)).toEqual(notes);
        expect(parent.appendices[2]).toEqual({ id: expect.stringMatching(/^scratchpad-/), name: 'After the storm', description: '{{user}} returns to the deck.' });
        expect(parent.activeAppendices).toEqual(before.power_user.persona_descriptions[avatarId].activeAppendices);
        expect(parent.connections).toEqual(before.power_user.persona_descriptions[avatarId].connections);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        const savedSource = await page.evaluate(async () => (await import('/scripts/scratchpad/context.js')).currentSource());
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(async avatar => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, savedSource.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-change-state', { hasText: 'Saved' })).toHaveCount(2);
        expect((await settings()).power_user.persona_descriptions[avatarId].appendices).toEqual(parent.appendices);
    });
    test(`${size}: reviews persona fields, Scenario Notes and avatars before saving`, async ({ app }) => {
        test.setTimeout(240000);
        const images = await app.images();
        images.mode.reply = { data: [{ b64_json: picture([120, 160, 210]).toString('base64') }] };
        const account = await app.account({ phone, configureSettings: saved => {
            saved.user_avatar = avatarId;
            saved.name1 = 'Kris';
            saved.power_user.default_persona = avatarId;
            saved.power_user.personas = { ...saved.power_user.personas, [avatarId]: 'Kris' };
            saved.power_user.persona_descriptions = { ...saved.power_user.persona_descriptions,
                [avatarId]: { description: 'A traveller with a notebook.', title: 'Traveller', appendices: structuredClone(notes), connections: [] } };
            saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1',
                gptImageProxyUrl: images.url, width: 1024, height: 1024, style: 'none', appendQuality: false, useSTStyle: false,
                reviewBeforeGenerate: false, setupWizardSeen: true };
        } });
        const avatarPath = path.join(app.dataRoot, 'default-user', 'User Avatars', avatarId);
        const original = picture([190, 130, 95]);
        await fs.writeFile(avatarPath, original);
        const page = await account.open({ workspace: true, timeout: 60000 });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const send = async text => {
            app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: text } }] };
            await page.locator('.scratchpad-composer').fill('Edit my persona, harbour Scenario Note and avatar.');
            const waiting = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await waiting;
            expect(response.ok(), await response.text()).toBe(true);
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        };
        const savedPersona = async () => JSON.parse((await account.post('/api/settings/get')).settings).power_user.persona_descriptions[avatarId];
        await send([
            fence({ type: 'persona', persona: 'Kris', field: 'description', value: 'A curious traveller who records every journey.' }),
            fence({ type: 'persona-note', persona: 'Kris', noteId: 'harbour', field: 'description', value: 'The last ferry leaves at sunset.' }),
            fence({ type: 'image', action: 'generate', target: 'persona-avatar', persona: 'Kris', prompt: 'A friendly traveller with a notebook.' }),
            fence({ type: 'image', action: 'generate', target: 'persona-note-avatar', persona: 'Kris', noteId: 'harbour', prompt: 'A traveller in a blue raincoat at the harbour.' }),
        ].join('\n'));
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        await page.evaluate(() => window.toastr.remove());
        if (baseline) {
            await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
            await page.screenshot({ path: `../screenshots/scratchpad-personas-${size}-before.png` });
            return;
        }
        const reviews = page.getByRole('button', { name: 'Review', exact: true });
        await expect(reviews).toHaveCount(2);
        await reviews.first().click();
        const popup = page.locator('dialog.popup[open]');
        const originalText = () => popup.locator('.ica-transform-diff').evaluate(element => [...element.children]
            .filter(part => !part.classList.contains('ica-transform-diff-part--ins')).map(part => part.textContent).join(''));
        expect(await originalText()).toBe('A traveller with a notebook.');
        await expect(popup.getByRole('textbox', { name: 'Proposed text', exact: true })).toHaveValue('A curious traveller who records every journey.');
        await checkImageControlContrast(page, ['dialog.popup[open] .popup-button-ok'], phone);
        await page.screenshot({ path: `../screenshots/scratchpad-personas-${size}-after.png` });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await savedPersona()).description).toBe('A traveller with a notebook.');
        await reviews.first().click();
        await popup.getByRole('textbox', { name: 'Proposed text', exact: true }).fill('A curious traveller with a well-worn notebook.');
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect.poll(async () => (await savedPersona()).description).toBe('A curious traveller with a well-worn notebook.');
        await reviews.last().click();
        expect(await originalText()).toBe('Waiting for the ferry.');
        await page.screenshot({ path: `../screenshots/scratchpad-notes-${size}-after.png` });
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect.poll(async () => (await savedPersona()).appendices[0].description).toBe('The last ferry leaves at sunset.');
        expect((await savedPersona()).appendices[1]).toEqual(notes[1]);
        expect((await savedPersona()).appendices[0].id).toBe('harbour');
        const card = page.locator('.scratchpad-image-card').first();
        const generating = page.waitForResponse('**/api/scratchpad/images/generate');
        await card.getByRole('button', { name: 'Generate image', exact: true }).click();
        const generated = await generating;
        expect(generated.ok(), await generated.text()).toBe(true);
        await account.settled((await generated.json()).job.id);
        await expect(card.locator('.scratchpad-generated-image')).toBeVisible();
        expect(await fs.readFile(avatarPath)).toEqual(original);
        await card.getByRole('button', { name: 'Review avatar', exact: true }).click();
        await expect(popup).toContainText('Current avatar');
        const previous = await popup.locator('.scratchpad-avatar-review img').first().getAttribute('src');
        await page.screenshot({ path: `../screenshots/scratchpad-persona-avatar-${size}-after.png` });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect(await fs.readFile(avatarPath)).toEqual(original);
        await card.getByRole('button', { name: 'Review avatar', exact: true }).click();
        const saving = page.waitForResponse('**/api/scratchpad/images/persona-avatar');
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        const saved = await saving;
        expect(saved.ok(), await saved.text()).toBe(true);
        await expect(card).toContainText('Avatar saved');
        expect(await fs.readFile(avatarPath)).not.toEqual(original);
        expect(await fs.readFile(path.join(app.dataRoot, 'default-user', previous.slice(1)))).toEqual(original);
        expect(images.calls).toHaveLength(1);
        const noteCard = page.locator('.scratchpad-image-card').last();
        await noteCard.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-note-avatar-${size}-before.png` });
        const noteGenerating = page.waitForResponse('**/api/scratchpad/images/generate');
        await noteCard.getByRole('button', { name: 'Generate image', exact: true }).click();
        const noteGenerated = await noteGenerating;
        expect(noteGenerated.ok(), await noteGenerated.text()).toBe(true);
        await account.settled((await noteGenerated.json()).job.id);
        await expect(noteCard.getByRole('button', { name: 'Review avatar', exact: true })).toBeVisible();
        await noteCard.getByRole('button', { name: 'Review avatar', exact: true }).click();
        await expect(popup).toContainText('Kris: At the harbour');
        const portrait = await popup.locator('.scratchpad-avatar-review img').last().getAttribute('src');
        // Scenario Note portraits are stored as full user images (PR #497), not data URLs.
        expect(portrait).toMatch(/^\/user\/images\/Scratchpad\/scratchpad-[a-f0-9]+\.png$/);
        const portraitImage = popup.locator('.scratchpad-avatar-review img').last();
        await portraitImage.evaluate(image => image.decode());
        expect(await portraitImage.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight })))
            .toEqual({ width: 128, height: 128 });
        const portraitResponse = await account.context.request.get(portrait, { headers: account.headers });
        expect(portraitResponse.status()).toBe(200);
        expect(portraitResponse.headers()['content-type']).toContain('image/png');
        const portraitPng = PNG.sync.read(await portraitResponse.body());
        expect({ width: portraitPng.width, height: portraitPng.height }).toEqual({ width: 128, height: 128 });
        expect([...portraitPng.data.subarray(0, 3)]).toEqual([120, 160, 210]);
        await page.screenshot({ path: `../screenshots/scratchpad-note-avatar-${size}-after.png` });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await savedPersona()).appendices[0]).not.toHaveProperty('avatar');
        await noteCard.getByRole('button', { name: 'Review avatar', exact: true }).click();
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(noteCard).toContainText('Avatar saved');
        expect((await savedPersona()).appendices[0].avatar).toBe(portrait);
        expect((await savedPersona()).appendices[1]).toEqual(notes[1]);
        expect(images.calls).toHaveLength(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        expect((await savedPersona()).description).toBe('A curious traveller with a well-worn notebook.');
        expect((await savedPersona()).appendices[0].description).toBe('The last ferry leaves at sunset.');
        expect((await savedPersona()).appendices[0].avatar).toBe(portrait);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await send(fence({ type: 'persona-note', persona: 'Kris', noteId: 'harbour', field: 'avatar', value: '' }));
        await page.getByRole('button', { name: 'Review', exact: true }).last().click();
        await expect(popup).toContainText('Persona avatar (fallback)');
        await popup.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect.poll(async () => (await savedPersona()).appendices[0].avatar).toBeUndefined();
    });
}
