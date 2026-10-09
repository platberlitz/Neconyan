/* global document, window */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const { phone, textProfile } of [{ phone: false, textProfile: false }, { phone: true, textProfile: false }, { phone: false, textProfile: true }]) {
    test(`${phone ? 'phone' : 'desktop'} creates a reviewed character from ${textProfile ? 'text-completion fallback' : 'a native Scratchpad tool call'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, textProfile });
        const original = await account.post('/api/characters/get', { avatar_url: account.avatar });
        const draft = {
            character: { name: 'Durable Nova', description: 'A new travelling botanist.', first_mes: 'Hello, {{user}}. I am {{char}}.' },
            characterNote: 'Keep the botanical details precise.', alternateGreetings: ['A second meeting.', 'A third meeting.'],
        };
        const args = JSON.stringify(draft);
        app.provider.mode.streamEvents = textProfile
            ? [{ choices: [{ text: '```scratchpad-change\n' + JSON.stringify({ type: 'character', action: 'create', ...draft }) + '\n```' }] }]
            : [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'scratchpad-create', type: 'function',
                function: { name: 'Neconyan_Assistant_CreateCharacter', arguments: args.slice(0, 50) } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(50) } }] }, finish_reason: 'tool_calls' }] }];
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await expect(page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true })).toBeEnabled();
        };
        await open();
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-taro').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('Create a new character card called Durable Nova, a travelling botanist. Use the default picture.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        const call = app.provider.calls.at(-1);
        expect(call.tools?.map(tool => tool.function.name) ?? []).toEqual(textProfile ? [] : ['Neconyan_Assistant_CreateCharacter']);
        const proposal = page.locator('.scratchpad-change');
        await expect(proposal).toContainText('Create character \'Durable Nova\'');
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(async avatar => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, account.avatar);
        await open();
        await expect(proposal).toContainText('Create character \'Durable Nova\'');
        await proposal.getByRole('button', { name: 'Review', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Proposed text', exact: true });
        const proposed = JSON.parse(await editor.inputValue());
        expect(proposed.character).toEqual(draft.character);
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect(await account.post('/api/characters/get', { avatar_url: account.avatar })).toEqual(original);
        expect((await account.post('/api/characters/all')).filter(card => card.name === 'Durable Nova')).toHaveLength(1);
        await proposal.getByRole('button', { name: 'Review', exact: true }).click();
        proposed.character.description = 'A reviewed travelling botanist.';
        await editor.fill(JSON.stringify(proposed, null, 2));
        const bounds = await editor.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        const screenshots = new URL('../screenshots/', import.meta.url);
        await fs.mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: new URL(`scratchpad-character-${phone ? 'phone' : 'desktop'}${textProfile ? '-text' : ''}-after.png`, screenshots).pathname });
        const created = page.waitForResponse('**/api/characters/create');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        const creation = await created;
        expect(creation.ok()).toBe(true);
        const avatar = await creation.text();
        expect(avatar).not.toBe(account.avatar);
        await expect(proposal).toContainText('Saved');
        const card = await account.post('/api/characters/get', { avatar_url: avatar });
        expect(card.data.description).toBe(proposed.character.description);
        expect(card.data.first_mes).toBe(draft.character.first_mes);
        expect(card.data.alternate_greetings).toEqual(draft.alternateGreetings);
        expect(card.data.extensions.depth_prompt.prompt).toBe(draft.characterNote);
        expect(await account.post('/api/characters/get', { avatar_url: account.avatar })).toEqual(original);
        expect(await page.evaluate(avatar => window.SillyTavern.getContext().characters.some(card => card.avatar === avatar), avatar)).toBe(true);
    });
}
