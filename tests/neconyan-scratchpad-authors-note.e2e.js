/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const OLD_NOTE = 'Keep {{char}} calm.';
const NEW_NOTE = 'Keep {{char}} calm and brief.';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad saves a reviewed Author's Note change only while the note is shared and unchanged`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        const selectStory = () => page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const note = () => page.evaluate(async () => (await import('/script.js')).chat_metadata.note_prompt ?? null);
        const setNote = text => page.evaluate(async value => {
            const { chat_metadata, saveChatConditional } = await import('/script.js');
            chat_metadata.note_prompt = value;
            await saveChatConditional();
        }, text);
        await selectStory();
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes ?? null)).toBe('Hello.');
        await setNote(OLD_NOTE);

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('roleplay');
        const changes = [NEW_NOTE, 'A stale note.', 'An unshared note.'].map(value => ({ type: 'authors-note', action: 'replace', value }));
        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Note edits',
                messages: [{ role: 'assistant', text: 'Three edits.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }],
            },
        });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-authors-note', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });
        const save = () => dialog.getByRole('button', { name: 'Save change', exact: true });

        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('Change the Author\'s Note');

        await review(0).click();
        await expect(dialog).toContainText('Author\'s Note');
        await expect(dialog).toContainText('This chat\'s note');
        await expect(dialog).toContainText('{{char}}');
        await expect(dialog.locator('.ica-transform-diff-part--ins').first()).toContainText('brief');
        const box = await dialog.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: shots('review') });
        await save().click();
        await expect(cards.nth(0)).toContainText('Saved');
        expect(await note()).toBe(NEW_NOTE);
        expect(await page.evaluate(() => document.getElementById('extension_floating_prompt')?.value ?? null)).toBe(NEW_NOTE);
        await page.screenshot({ path: shots('saved') });

        await review(1).click();
        await expect(save()).toBeVisible();
        await setNote('Changed elsewhere.');
        await save().click();
        await expect(toasts).toContainText('changed while the review was open');
        expect(await note()).toBe('Changed elsewhere.');
        await expect(cards.nth(1)).not.toContainText('Saved');

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const share = page.getByRole('checkbox', { name: 'Author\'s Note', exact: true });
        let updated = page.waitForResponse('**/api/scratchpad/session/update');
        await share.uncheck();
        expect((await updated).ok()).toBe(true);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await review(2).click();
        await expect(toasts).toContainText('Share the Author\'s Note under Context before saving a change to it.');
        await expect(dialog).toHaveCount(0);
        expect(await note()).toBe('Changed elsewhere.');

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        updated = page.waitForResponse('**/api/scratchpad/session/update');
        await share.check();
        expect((await updated).ok()).toBe(true);
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();

        const question = 'Tighten the note.';
        app.provider.mode.reply = { choices: [{ message: { content: 'Here is a tighter one.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        const sent = calls[0].messages.map(message => String(message.content)).join('\n');
        expect(sent).toContain('"type":"authors-note"');
        expect(sent).toContain('## Author\'s Note\nChanged elsewhere.');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        await setNote(NEW_NOTE);
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await selectStory();
        await expect.poll(note).toBe(NEW_NOTE);
    });
}
