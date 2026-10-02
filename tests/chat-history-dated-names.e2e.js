/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} labels both date formats and branches, leaving custom titles alone`, async ({ app }) => {
        let labelNumber = 0;
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: {
            role: 'assistant', content: JSON.stringify({ title: `Moonlit Chapter ${++labelNumber}` }),
        } }] });
        const account = await app.account({ phone, activeConnection: true });
        const datedNames = [
            'Durable Nova - 2026-10-02@09h08m07s006ms',
            'Durable Nova - 2026-10-02 09-08-07',
            'Durable Nova - 2026-10-02@09h08m07s006ms - Branch #1',
            'Durable Nova - 2026-10-02 09-08-07 - Branch #12',
            'Branch #2 - Durable Nova - 2026-10-02 09-08-07',
            'Durable Nova - 2026-10-02 09-08-07 imported - Branch #3',
        ];
        const customNames = ['Moonlit Escape - Branch #1', 'Moonlit Escape'];
        for (const name of [...datedNames, ...customNames]) {
            const fields = { avatar_url: account.avatar, file_name: name };
            const source = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
            expect(source.ok(), await source.text()).toBe(true);
            const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
            await account.post('/api/chats/save', { ...fields, chat: [
                { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { datedLabelTest: name } },
                { name: 'User', is_user: true, mes: `Explore the moonlit garden in ${name}.`, extra: {} },
                { name: 'Durable Nova', is_user: false, mes: 'The silver roses bloom under the stars.', extra: {} },
            ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        }

        const directory = path.join(app.directory, 'data/default-user/chats', path.parse(account.avatar).name);
        const originals = await Promise.all(datedNames.map(name => fs.readFile(path.join(directory, `${name}.jsonl`), 'utf8')));
        const customBranch = await fs.readFile(path.join(directory, `${customNames[0]}.jsonl`), 'utf8');
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await page.locator('#option_select_chat').evaluate(button => button.click());
        await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();

        const labelDated = page.locator('#chat_auto_label_dated');
        await expect(labelDated).toBeVisible();
        const geometry = await labelDated.evaluate(button => ({
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
            display: getComputedStyle(button).display,
        }));
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.display).not.toBe('none');
        const renamed = [];
        page.on('response', response => {
            if (response.url().endsWith('/api/chats/rename') && response.ok()) renamed.push(response.request().postDataJSON());
        });
        await labelDated.click();
        const confirmation = page.locator('dialog[open]').filter({ hasText: 'Auto-label timestamp-named chats?' });
        await expect(confirmation).toContainText('6 chat(s)');
        await confirmation.locator('.popup-button-ok').click();
        await expect.poll(() => renamed.length, { timeout: 60000 }).toBe(datedNames.length);
        await expect(page.locator('#chat_cleanup_status')).toContainText('Auto-labeled 6/6 chat(s).');

        expect(renamed.map(request => request.original_file.replace(/\.jsonl$/, '')).sort()).toEqual([...datedNames].sort());
        expect(app.provider.calls).toHaveLength(6);
        for (const request of renamed) {
            const index = datedNames.indexOf(request.original_file.replace(/\.jsonl$/, ''));
            const original = originals[index].trim().split('\n').map(line => JSON.parse(line));
            const relabelled = (await fs.readFile(path.join(directory, request.renamed_file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
            expect(relabelled[0].chat_metadata.neconyan_roleplay.instanceId).toBe(original[0].chat_metadata.neconyan_roleplay.instanceId);
            expect(relabelled[0].chat_metadata.neconyan_roleplay.revision).toBeGreaterThanOrEqual(original[0].chat_metadata.neconyan_roleplay.revision);
            // Opening the last renamed chat can refresh its managed save identifiers.
            for (const header of [original[0], relabelled[0]]) {
                delete header.chat_metadata.chat_id_hash;
                delete header.chat_metadata.neconyan_roleplay;
                delete header.chat_metadata.integrity;
            }
            expect(relabelled).toEqual(original);
        }
        const files = await fs.readdir(directory);
        for (const name of datedNames) expect(files).not.toContain(`${name}.jsonl`);
        for (const name of customNames) expect(files).toContain(`${name}.jsonl`);
        expect(await fs.readFile(path.join(directory, `${customNames[0]}.jsonl`), 'utf8')).toBe(customBranch);
    });
}
