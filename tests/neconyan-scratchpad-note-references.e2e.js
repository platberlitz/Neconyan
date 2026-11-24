/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Same assertions for both viewports and the before-fix fixture. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const avatar = 'Kris.png';
const harbour = { id: 'at-the-harbour-before-the-last-ferry-1795220000000', name: 'Harbour', description: 'Waiting for the ferry.' };
const home = { id: 'at-home-1795220001000', name: 'At home', description: 'A quiet afternoon.' };
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size}: saves two suggested Scenario Note edits without changing personas`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            saved.user_avatar = avatar;
            saved.name1 = 'Kris';
            saved.power_user.default_persona = avatar;
            saved.power_user.personas[avatar] = 'Kris';
            saved.power_user.persona_descriptions[avatar] = { description: 'A traveller.', appendices: [harbour, home],
                activeAppendices: { 'fixture-chat': [harbour.id] }, connections: [] };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await fs.copyFile(path.resolve('../public/img/user-default.png'), path.join(app.dataRoot, 'default-user', 'User Avatars', avatar));
        const page = await account.open({ workspace: true });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        if (phone) await applyIOSOnlyCss(page);

        let shared;
        app.provider.mode.reply = ({ messages }) => {
            const context = messages.find(({ content }) => typeof content === 'string' && content.includes('## Saved Persona Scenario Notes'))?.content;
            const list = context?.match(/## Saved Persona Scenario Notes[^\n]*\n([^\n]+)/)?.[1];
            shared = list ? JSON.parse(list).find(note => note.name === harbour.name) : null;
            // Model stand-in: copies short references, but drops the timestamp from the old slug.
            const target = shared?.ref ? { noteRef: shared.ref } : { noteId: shared?.id?.replace(/-\d+$/, '') ?? 'missing' };
            const change = { type: 'persona-note', persona: 'Kris', ...target };
            return { choices: [{ message: { content: [fence({ ...change, field: 'name', value: 'Last ferry' }),
                fence({ ...change, field: 'description', value: 'The ferry leaves at sunset.' })].join('\n') } }] };
        };
        await page.locator('.scratchpad-composer').fill('Rename my Harbour Scenario Note and update its text.');
        const sending = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await sending;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        const review = page.getByRole('button', { name: 'Review all 2 changes', exact: true });
        await expect(review).toBeVisible();
        if (phone) await page.locator('.scratchpad-overview-toggle').click();
        await page.evaluate(() => window.toastr.remove());
        await review.click();
        const popup = page.locator('dialog.popup[open]');
        await expect(popup).toContainText('Review 2 changes');
        await page.screenshot({ path: `../screenshots/scratchpad-note-references-${size}-${shared?.ref ? 'after' : 'before'}.png` });
        const save = popup.getByRole('button', { name: 'Save ticked changes', exact: true });
        await expect(save, await popup.innerText()).toBeEnabled();
        expect(shared).toMatchObject({ ref: expect.any(String), description: harbour.description });
        expect(shared).not.toHaveProperty('id');
        const items = popup.locator('.scratchpad-batch-item');
        await expect(items.filter({ hasText: 'Kris: Harbour' })).toHaveCount(2);
        const box = await popup.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await save.click();
        await expect(page.locator('.scratchpad-change-state', { hasText: 'Saved' })).toHaveCount(2);
        const stored = JSON.parse((await account.post('/api/settings/get')).settings);
        expect(stored.user_avatar).toBe(avatar);
        expect(stored.power_user.persona_descriptions[avatar]).toMatchObject({
            appendices: [{ ...harbour, name: 'Last ferry', description: 'The ferry leaves at sunset.' }, home],
            activeAppendices: { 'fixture-chat': [harbour.id] },
        });
    });
}
