/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const records = [
    { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
    { name: 'User', is_user: true, mes: 'Imported question.', extra: {} },
    { name: 'Durable Nova', is_user: false, mes: 'Imported answer.',
        swipes: ['Imported answer.', 'Alternative answer.'], swipe_id: 0, extra: {} },
];
const buffer = Buffer.from(records.map(JSON.stringify).join('\n'));

async function openImport(page, mainImport) {
    if (mainImport) {
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'import'));
    } else {
        await page.locator('#option_select_chat').evaluate(element => element.click());
    }
}

for (const phone of [false, true]) {
    for (const mainImport of [false, true]) {
        test(`${mainImport ? 'character import' : 'chat history'} uses an unrestricted picker and validates JSONL on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
            test.setTimeout(180000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false });
            await page.evaluate(async avatar => {
                const context = window.SillyTavern.getContext();
                const core = await import('/script.js');
                await core.getOneCharacter(avatar, { allowInsert: true });
                await core.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
            }, account.avatar);

            await openImport(page, mainImport);
            const input = page.locator(mainImport ? '#sb_character_chat_import_file' : '#chat_import_file');
            const chooserEvent = page.waitForEvent('filechooser');
            await page.locator(mainImport ? '#sb_character_chat_import_action' : '#chat_import_button').click();
            const chooser = await chooserEvent;
            expect(chooser.isMultiple()).toBe(true);
            // Native Android selection cannot be exercised by setFiles. Check the actual
            // chooser has no type filter, then verify our own validation after selection.
            expect(await chooser.element().evaluate(element => element.accept)).toBe('');

            const requests = [];
            page.on('request', request => {
                if (request.url().endsWith('/api/chats/import')) requests.push(request);
            });
            await chooser.setFiles({ name: 'Not a chat.zip', mimeType: 'application/zip', buffer });
            await expect(input).toHaveValue('');
            await expect(page.locator('#toast-container')).toContainText('Only JSON and JSONL files are supported');
            expect(requests).toHaveLength(0);

            const refused = page.waitForResponse(response => response.url().endsWith('/api/chats/import'));
            await input.setInputFiles({ name: 'Invalid.jsonl', mimeType: 'application/octet-stream', buffer: Buffer.from('Not JSON') });
            expect((await refused).status()).toBe(400);
            await expect(input).toHaveValue('');

            for (const [index, mimeType] of ['application/octet-stream', 'text/plain', 'application/json'].entries()) {
                const accepted = page.waitForResponse(response => response.url().endsWith('/api/chats/import'));
                await input.setInputFiles({ name: `Imported chat ${index}.jsonl`, mimeType, buffer });
                const response = await accepted;
                expect(response.status(), await response.text()).toBe(200);
                const result = await response.json();
                expect(result.fileNames).toHaveLength(1);
                await expect(input).toHaveValue('');
                const file = path.join(app.directory, 'data', 'default-user', 'chats', path.parse(account.avatar).name, `${result.fileNames[0]}.jsonl`);
                const saved = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
                expect(saved.slice(1)).toEqual(records.slice(1));
            }
            expect(app.provider.calls).toHaveLength(0);
            await page.close();
        });
    }
}
