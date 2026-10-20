/* global document, window */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const cases = [
    { phone: false, textProfile: false }, { phone: true, textProfile: false }, { phone: false, textProfile: true },
    ...[false, true].flatMap(phone => [false, true].map(textProfile => ({ phone, textProfile, recovered: true }))),
];

function streamDraft(provider, draft, textProfile) {
    const args = JSON.stringify(draft);
    provider.mode.streamEvents = textProfile
        ? [{ choices: [{ text: '```scratchpad-change\n' + JSON.stringify({ type: 'character', action: 'create', ...draft }) + '\n```' }] }]
        : [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'scratchpad-create', type: 'function',
            function: { name: 'Neconyan_Assistant_CreateCharacter', arguments: args.slice(0, 50) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(50) } }] }, finish_reason: 'tool_calls' }] }];
}

function creationWireDraft(draft, recovered, textProfile) {
    return recovered ? { character: { ...draft.character, characterNote: draft.characterNote,
        [textProfile ? 'alternate_greetings' : 'alternateGreetings']: draft.alternateGreetings } } : draft;
}

async function checkConflictingDraft({ page, account, app, draft, textProfile, open, original, proposal, imageRequests }) {
    await page.evaluate(async avatar => {
        await window.SillyTavern.getContext().getCharacters();
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
    }, account.avatar);
    await open();
    await expect(proposal).toContainText('Saved');
    streamDraft(app.provider, { ...draft, character: { ...draft.character, characterNote: 'A conflicting note.' } }, textProfile);
    await page.locator('.scratchpad-composer').fill('Show the conflicting draft for review.');
    const rejectedReply = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const rejected = await rejectedReply;
    expect(rejected.ok(), await rejected.text()).toBe(true);
    await account.settled((await rejected.json()).job.id);
    expect(app.provider.calls).toHaveLength(2);
    const lastReply = page.locator('.scratchpad-message.is-assistant').last();
    await expect(lastReply).toContainText('Conflicting values for characterNote');
    await expect(lastReply.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save change', exact: true })).toHaveCount(0);
    expect((await account.post('/api/characters/all')).filter(card => card.name === 'Durable Nova')).toHaveLength(2);
    expect(await account.post('/api/characters/get', { avatar_url: account.avatar })).toEqual(original);
    expect(imageRequests).toEqual([]);
}

for (const { phone, textProfile, recovered = false } of cases) {
    const verifyConflict = recovered ? checkConflictingDraft : async () => {};
    test(`${phone ? 'phone' : 'desktop'} creates a reviewed ${recovered ? 'recovered ' : ''}character from ${textProfile ? 'text-completion fallback' : 'a native Scratchpad tool call'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, textProfile, configureSettings: saved => { saved.oai_settings.function_calling = true; } });
        const original = await account.post('/api/characters/get', { avatar_url: account.avatar });
        const draft = {
            character: { name: 'Durable Nova', description: 'A new travelling botanist.', first_mes: 'Hello, {{user}}. I am {{char}}.' },
            characterNote: 'Keep the botanical details precise.', alternateGreetings: ['A second meeting.', 'A third meeting.'],
        };
        streamDraft(app.provider, creationWireDraft(draft, recovered, textProfile), textProfile);
        const page = await account.open();
        const imageRequests = [];
        page.on('request', request => {
            if (request.method() === 'POST' && /\/images\/(?:generations|edits)|\/api\/(?:sd\/generate|plugins\/quick-image-gen-relay\/)/.test(request.url())) imageRequests.push(request.url());
        });
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
        expect(app.provider.calls).toHaveLength(1);
        const call = app.provider.calls.at(-1);
        expect(call.tools?.map(tool => tool.function.name) ?? []).toEqual(textProfile ? [] : ['Neconyan_Assistant_CreateCharacter']);
        const proposal = page.locator('.scratchpad-change');
        await expect(proposal).toContainText('Create character \'Durable Nova\'');
        expect((await account.post('/api/characters/all')).filter(card => card.name === 'Durable Nova')).toHaveLength(1);
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
        expect(proposed.characterNote).toBe(draft.characterNote);
        expect(proposed.alternateGreetings).toEqual(draft.alternateGreetings);
        expect(proposed.avatarPrompt).toBe('');
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect(await account.post('/api/characters/get', { avatar_url: account.avatar })).toEqual(original);
        expect((await account.post('/api/characters/all')).filter(card => card.name === 'Durable Nova')).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(1);
        await proposal.getByRole('button', { name: 'Review', exact: true }).click();
        proposed.character.description = 'A reviewed travelling botanist.';
        await editor.fill(JSON.stringify(proposed, null, 2));
        const bounds = await editor.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        const screenshots = new URL('../screenshots/', import.meta.url);
        await fs.mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: fileURLToPath(new URL(`scratchpad-character-${phone ? 'phone' : 'desktop'}${textProfile ? '-text' : ''}${recovered ? '-recovered' : ''}-after.png`, screenshots)) });
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
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        expect(await account.post('/api/characters/get', { avatar_url: avatar })).toEqual(card);
        expect(app.provider.calls).toHaveLength(1);
        expect(imageRequests).toEqual([]);
        await verifyConflict({ page, account, app, draft, textProfile, open, original, proposal, imageRequests });
    });
}
