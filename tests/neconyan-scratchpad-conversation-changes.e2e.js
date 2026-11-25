/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewports and the before build share one interaction contract. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { openScratchpadContext } from './neconyan-scratchpad-context-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT || '/srv/projects/Neconyan-worktrees/scratchpad-baseline' } });

const SAVES = /\/api\/(settings\/save|characters\/(edit|merge-attributes)|worldinfo\/edit|chats\/save|neconyan-conversation\/store\/save|presets\/save)/;
const PRESET = 'Scratchpad Garden';
const MAIN = 'Write {{char}}\'s next reply. Keep the scene moving.';
const REVIEWED = 'CONVERSATION-PRESET Write {{char}}\'s next reply in short, warm lines.';
const HIDDEN = 'ROLEPLAY-ONLY-ORDER Nova speaks only in rhyme for this character.';
const HINT = 'Shares the active preset with your account\'s prompt order, not a character\'s own order. Off by default.';
const block = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';
const textOf = call => call.messages.map(message => String(message.content)).join('\n');

const SEEDED = [
    { id: 'seed-user', role: 'user', name: 'User', mes: 'Original question.', timestamp: 1700000000000 },
    { id: 'c1', role: 'character', name: 'Durable Nova', mes: 'First answer.', timestamp: 1700000001000 },
    { id: 'u2', role: 'user', name: 'User', mes: 'Second question.', timestamp: 1700000002000 },
    { id: 'c3', role: 'character', name: 'Durable Nova', mes: 'Second answer.', timestamp: 1700000003000 },
];

async function openPad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeVisible();
}

function readSource(page) {
    return page.evaluate(async () => {
        const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
        return wireSource(currentSource());
    });
}

async function connect(page) {
    await openScratchpadContext(page, 'replies');
    await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
    await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.evaluate(() => window.toastr.remove());
}

// Edits a Conversation message the way the timeline's own edit box does.
function editByHand(page, id, text) {
    return page.evaluate(async ({ id, text }) => {
        const { currentSource } = await import('/scripts/scratchpad/context.js');
        const { updateConversationThreadMessage } = await import('/scripts/neconyan-conversation/thread-store.js');
        const { persistConversationStoreNow } = await import('/scripts/neconyan-conversation/store-sync.js');
        const source = currentSource();
        updateConversationThreadMessage(source.avatar, id, text, null, { branchId: source.branchId, groupId: source.groupId, personaId: source.personaId });
        await persistConversationStoreNow();
    }, { id, text });
}

async function quietSaves(page) {
    // Opening Conversation and the panel can leave debounced saves in flight. Let them land
    // before counting the saves a trial makes.
    let lastSave = Date.now();
    page.on('requestfinished', request => { if (SAVES.test(request.url())) lastSave = Date.now(); });
    await expect.poll(() => Date.now() - lastSave, { timeout: 30000, intervals: [500] }).toBeGreaterThan(3000);
    const saves = [];
    page.on('request', request => { if (request.method() === 'POST' && SAVES.test(request.url())) saves.push(request.url()); });
    return saves;
}

async function rehearse(page, account, app, label, start) {
    app.provider.mode.reply = { choices: [{ message: { content: 'Nova tilts her head and answers softly.' } }] };
    const sending = page.waitForResponse('**/api/scratchpad/send');
    await start();
    const response = await sending;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
    const call = app.provider.calls.at(-1);
    expect(call.messages[0].content).toContain('as a rehearsal');
    expect(call.messages.at(-1).content).toBe(`Rehearse the next story reply using this unsaved change: ${label}.`);
    const reply = page.locator('.scratchpad-message.is-assistant').last();
    await expect(reply.locator('.scratchpad-badge')).toHaveText('Rehearsal · Unsaved change');
    await expect(reply.locator('.scratchpad-trial-note')).toHaveText(`Tried without saving: ${label}`);
    return textOf(call);
}

async function send(page, account, app, text, content) {
    app.provider.mode.reply = { choices: [{ message: { content } }] };
    const sending = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-composer').fill(text);
    await page.locator('.scratchpad-send').click();
    const response = await sending;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
    return app.provider.calls.at(-1);
}

async function noSideways(page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} Conversation Scratchpad rewrites, adds and deletes messages with Undo`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.changeStore(store => {
            const slot = store.characters[account.threadKey];
            slot.branches[slot.activeBranchId].messages = structuredClone(SEEDED);
        });
        let page = await account.open();
        const timeline = id => page.locator(`.sb-conversation-message[data-message-id="${id}"] .sb-conversation-message-text`);
        await expect(timeline('c1')).toHaveText('First answer.');
        await openPad(page);
        const source = await readSource(page);
        expect(source.kind).toBe('conversation');
        const changes = [
            { type: 'chat', action: 'edit', message: 1, text: 'EDITED first answer.', reason: 'Warmer.' },
            { type: 'chat', action: 'insert', after: 1, speaker: 'character', text: 'INSERTED aside.', reason: 'A pause.' },
            { type: 'chat', action: 'delete', message: 3, reason: 'Repeats itself.' },
            { type: 'chat', action: 'hide', message: 0, reason: 'Out of character.' },
            { type: 'chat', action: 'edit', message: 2, text: 'EDITED second question.', reason: 'Clearer.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Conversation fixes',
            messages: [{ role: 'assistant', text: 'Five ideas.\n' + changes.map(block).join('\n') }] } });
        await openPad(page);
        if (phone) await applyIOSOnlyCss(page);
        await connect(page);
        const cards = page.locator('.scratchpad-message.is-assistant').first().locator('.scratchpad-change');
        await expect(cards).toHaveCount(5);
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container .toast');
        const shot = name => page.screenshot({ path: `../screenshots/scratchpad-conversation-changes/${viewport}-${name}${before ? '-before' : ''}.png` });
        const review = async index => {
            await cards.nth(index).scrollIntoViewIfNeeded();
            await cards.nth(index).getByRole('button', { name: 'Review', exact: true }).click();
        };
        const branchTexts = async () => (await account.branch()).messages.map(message => message.mes);
        await cards.first().scrollIntoViewIfNeeded();

        if (before) {
            await expect(cards.first().locator('.scratchpad-change-try')).toHaveCount(0);
            await shot('cards');
            await review(0);
            await expect(toasts.last()).toContainText('Scratchpad can only change messages in Roleplay chats.');
            await expect(dialog).toHaveCount(0);
            await shot('review-refused');
            expect(await branchTexts()).toEqual(SEEDED.map(message => message.mes));
            return;
        }

        await expect(cards.first().locator('.scratchpad-change-actions button')).toHaveText(['Review', 'Try first', 'Dismiss']);
        await expect(cards.nth(1).locator('.scratchpad-change-try')).toHaveCount(1);
        await expect(cards.nth(2).locator('.scratchpad-change-try')).toHaveCount(1);
        // Conversation messages have no hidden state, so hiding is never offered for a trial.
        await expect(cards.nth(3).locator('.scratchpad-change-try')).toHaveCount(0);
        await shot('cards');

        // Try first shows the rewrite to a rehearsal without touching the branch.
        const saves = await quietSaves(page);
        const label = (await cards.first().locator('.scratchpad-change-title span').textContent()).trim();
        expect(label).toBe('Rewrite message #1');
        const sent = await rehearse(page, account, app, label, () => cards.first().locator('.scratchpad-change-try').click());
        expect(sent).toContain('## Unsaved change under rehearsal');
        expect(sent).toContain('EDITED first answer.');
        expect(saves).toEqual([]);
        expect(await branchTexts()).toEqual(SEEDED.map(message => message.mes));
        await expect(timeline('c1')).toHaveText('First answer.');

        // Saving the rewrite updates the open timeline and the stored branch.
        await review(0);
        await expect(dialog.locator('.scratchpad-review-editor')).toHaveValue('EDITED first answer.');
        await expect(dialog.locator('.scratchpad-review-try')).toHaveText('Try before saving');
        await shot('review');
        await dialog.getByText('Save change', { exact: true }).click();
        await expect(cards.first()).toContainText('Saved');
        await expect(timeline('c1')).toHaveText('EDITED first answer.');
        await expect.poll(branchTexts).toEqual(['Original question.', 'EDITED first answer.', 'Second question.', 'Second answer.']);
        expect(saves.some(url => url.includes('/api/neconyan-conversation/store/save'))).toBe(true);

        // Hiding is refused with a plain reason.
        await page.evaluate(() => window.toastr.remove());
        await review(3);
        await expect(toasts.filter({ hasText: 'Conversation messages cannot be hidden.' })).toHaveCount(1);
        await expect(dialog).toHaveCount(0);
        await expect(cards.nth(3)).not.toContainText('Saved');
        await shot('hide-refused');

        // A message edited by hand while the review is open is never overwritten.
        await page.evaluate(() => window.toastr.remove());
        await review(4);
        await expect(dialog.locator('.scratchpad-review-editor')).toHaveValue('EDITED second question.');
        await editByHand(page, 'u2', 'Second question, typed by hand.');
        await dialog.getByText('Save change', { exact: true }).click();
        await expect(toasts.filter({ hasText: 'This changed while the review was open' })).toHaveCount(1);
        await expect(cards.nth(4)).not.toContainText('Saved');
        await expect.poll(branchTexts).toEqual(['Original question.', 'EDITED first answer.', 'Second question, typed by hand.', 'Second answer.']);

        // Delete, then add.
        await review(2);
        await expect(dialog).toContainText('Whole message');
        await dialog.getByText('Save change', { exact: true }).click();
        await expect(cards.nth(2)).toContainText('Saved');
        await expect(timeline('c3')).toHaveCount(0);
        await expect.poll(branchTexts).toEqual(['Original question.', 'EDITED first answer.', 'Second question, typed by hand.']);
        await review(1);
        await expect(dialog).toContainText('New message from Durable Nova');
        await dialog.getByText('Save change', { exact: true }).click();
        await expect(cards.nth(1)).toContainText('Saved');
        await expect.poll(branchTexts).toEqual(['Original question.', 'EDITED first answer.', 'INSERTED aside.', 'Second question, typed by hand.']);
        const inserted = (await account.branch()).messages[2];
        expect(inserted).toMatchObject({ role: 'character', name: 'Durable Nova' });
        await expect(timeline(inserted.id)).toHaveText('INSERTED aside.');
        await noSideways(page);
        await shot('saved');

        // The changes survive a reload.
        await page.close();
        page = await account.open();
        await expect(timeline('c1')).toHaveText('EDITED first answer.');
        await expect(timeline(inserted.id)).toHaveText('INSERTED aside.');
        await expect(timeline('c3')).toHaveCount(0);
        await openPad(page);
        if (phone) await applyIOSOnlyCss(page);
        const reopened = page.locator('.scratchpad-message.is-assistant').first().locator('.scratchpad-change');
        await expect(reopened.nth(1)).toContainText('Saved');

        // Undo removes the addition and puts the deleted message back in place.
        await reopened.nth(1).scrollIntoViewIfNeeded();
        await reopened.nth(1).getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(reopened.nth(1)).toContainText('Undone');
        await expect.poll(branchTexts).toEqual(['Original question.', 'EDITED first answer.', 'Second question, typed by hand.']);
        await expect(timeline(inserted.id)).toHaveCount(0);
        await reopened.nth(2).scrollIntoViewIfNeeded();
        await reopened.nth(2).getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(reopened.nth(2)).toContainText('Undone');
        await expect.poll(async () => (await account.branch()).messages.map(message => message.id)).toEqual(['seed-user', 'c1', 'u2', 'c3']);
        await expect(timeline('c3')).toHaveText('Second answer.');

        // Undo stops when the message was edited by hand after the save.
        const reopenedToasts = page.locator('#toast-container .toast');
        await page.evaluate(() => window.toastr.remove());
        await editByHand(page, 'c1', 'First answer, fixed by hand.');
        await reopened.first().scrollIntoViewIfNeeded();
        await reopened.first().getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(reopenedToasts.first()).toContainText('automatic undo was stopped to avoid overwriting your later changes');
        await expect(reopened.first().locator('.scratchpad-change-conflict')).toContainText('This message was changed after Scratchpad saved it');
        await expect(reopened.first()).toContainText('Saved');
        await expect.poll(branchTexts).toEqual(['Original question.', 'First answer, fixed by hand.', 'Second question, typed by hand.', 'Second answer.']);
        await expect(timeline('c1')).toHaveText('First answer, fixed by hand.');
        await noSideways(page);
        await page.screenshot({ path: `../screenshots/scratchpad-conversation-changes/${viewport}-undo-conflict.png` });
    });

    test(`${viewport} Conversation Scratchpad shares and edits the account preset`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        await page.evaluate(async ({ name, main }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const manager = getPresetManager('openai');
            const preset = structuredClone(manager.getPresetSettings());
            preset.prompts.find(item => item.identifier === 'main').content = main;
            await manager.savePreset(name, preset);
        }, { name: PRESET, main: MAIN });
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/scratchpad/preset.js')).currentPresetName())).toBe(PRESET);
        const readPreset = () => page.evaluate(async name => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            return structuredClone(getPresetManager('openai').getCompletionPresetByName(name));
        }, PRESET);
        const original = await readPreset();
        await openPad(page);
        if (phone) await applyIOSOnlyCss(page);
        expect((await readSource(page)).kind).toBe('conversation');
        const shot = name => page.screenshot({ path: `../screenshots/scratchpad-conversation-changes/${viewport}-${name}${before ? '-before' : ''}.png` });
        const toasts = page.locator('#toast-container .toast');
        const presetBox = page.getByRole('checkbox', { name: /^Current preset/ });

        if (before) {
            await openScratchpadContext(page, 'sharing');
            await expect(page.getByRole('checkbox', { name: /^Character cards/ })).toBeVisible();
            await page.getByRole('checkbox', { name: /^Character cards/ }).scrollIntoViewIfNeeded();
            await expect(presetBox).toHaveCount(0);
            await shot('context');
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            await page.evaluate(() => window.toastr.remove());
            await page.locator('.scratchpad-composer').fill('/check preset');
            await page.locator('.scratchpad-send').click();
            await expect(toasts.filter({ hasText: 'Nothing was sent' }).last()).toContainText('Conversation chats can\'t share a preset.');
            await shot('check-preset-refused');
            return;
        }

        // A Roleplay character's own prompt order, left behind by the last story chat, stays out of Conversation.
        await page.evaluate(async text => {
            const { promptManager } = await import('/scripts/openai.js');
            promptManager.serviceSettings.prompts.push({ identifier: 'roleplayOnly', name: 'Roleplay only', role: 'system', content: text, system_prompt: false, marker: false });
            const own = { id: 'durable-nova-own' };
            promptManager.addPromptOrderForCharacter(own, [{ identifier: 'main', enabled: true }, { identifier: 'roleplayOnly', enabled: true }]);
            promptManager.activeCharacter = own;
        }, HIDDEN);
        const orders = await page.evaluate(async () => {
            const { readCurrentPreset } = await import('/scripts/scratchpad/preset.js');
            return { own: JSON.stringify(readCurrentPreset({ globalOnly: false })), account: JSON.stringify(readCurrentPreset({ globalOnly: true })) };
        });
        expect(orders.own).toContain('ROLEPLAY-ONLY-ORDER');
        expect(orders.account).not.toContain('ROLEPLAY-ONLY-ORDER');

        await connect(page);
        // The assistant asks for the preset; turning it on ticks Current preset.
        const ask = ['```neconyan-share-request', JSON.stringify({ items: ['preset'], reason: 'I need your preset to check the main prompt.' }), '```'].join('\n');
        const first = await send(page, account, app, 'Can you look at my preset?', 'I can look.\n' + ask);
        expect(first.messages[0].content).toContain('- preset: Current preset');
        const share = page.locator('.scratchpad-share-request').last();
        await expect(share.locator('.scratchpad-share-title')).toHaveText('Share with the assistant');
        await expect(share).toContainText('Current preset');
        await share.scrollIntoViewIfNeeded();
        await shot('share-request');
        await share.locator('.scratchpad-share-only').click();
        await openScratchpadContext(page, 'sharing');
        await expect(presetBox).toBeChecked();
        await expect(page.getByText(HINT, { exact: true })).toBeVisible();
        await presetBox.scrollIntoViewIfNeeded();
        await noSideways(page);
        await shot('context');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();

        const proposal = { type: 'preset', action: 'replace', api: 'openai', preset: PRESET, module: 'main', field: 'content', value: REVIEWED, reason: 'Shorter lines.' };
        const second = await send(page, account, app, 'Tighten the main prompt.', 'One idea.\n' + block(proposal));
        const system = second.messages[0].content;
        expect(system).toContain('"type":"preset"');
        expect(system).toContain('Conversation messages (use the #numbers from the context):');
        expect(system).not.toContain('"action":"hide"');
        const shared = textOf(second);
        expect(shared).toContain('Module ID: main');
        expect(shared).toContain('Keep the scene moving.');
        expect(shared).not.toContain('ROLEPLAY-ONLY-ORDER');
        expect(shared).not.toContain('roleplayOnly');

        const card = page.locator('.scratchpad-message.is-assistant').last().locator('.scratchpad-change');
        await expect(card).toHaveCount(1);
        await expect(card.locator('.scratchpad-change-actions button')).toHaveText(['Review', 'Try first', 'Dismiss']);
        await card.scrollIntoViewIfNeeded();
        await shot('preset-card');
        const saves = await quietSaves(page);
        const label = (await card.locator('.scratchpad-change-title span').textContent()).trim();
        const trial = await rehearse(page, account, app, label, () => card.locator('.scratchpad-change-try').click());
        expect(trial).toContain('## Unsaved change under rehearsal');
        expect(trial).toContain('CONVERSATION-PRESET');
        expect(trial).not.toContain('ROLEPLAY-ONLY-ORDER');
        expect(saves).toEqual([]);
        expect(await readPreset()).toEqual(original);

        // Saving writes the live preset, so put the stray order back before saving.
        await page.evaluate(async () => {
            const { promptManager } = await import('/scripts/openai.js');
            promptManager.removePromptOrderForCharacter({ id: 'durable-nova-own' });
            promptManager.serviceSettings.prompts = promptManager.serviceSettings.prompts.filter(item => item.identifier !== 'roleplayOnly');
            promptManager.activeCharacter = { id: promptManager.configuration.promptOrder.dummyId };
        });
        const dialog = page.locator('dialog[open]');
        const saveCard = page.locator('.scratchpad-message.is-assistant').filter({ has: page.locator('.scratchpad-change') }).last().locator('.scratchpad-change');
        await saveCard.scrollIntoViewIfNeeded();
        await saveCard.getByRole('button', { name: 'Review', exact: true }).click();
        await expect(dialog.locator('.scratchpad-review-editor')).toHaveValue(REVIEWED);
        const saving = page.waitForResponse('**/api/presets/save');
        await dialog.getByText('Save change', { exact: true }).click();
        expect((await saving).ok()).toBe(true);
        await expect(saveCard).toContainText('Saved');
        const saved = await readPreset();
        expect(saved.prompts.find(item => item.identifier === 'main').content).toBe(REVIEWED);
        expect(saved.prompt_order).toEqual(original.prompt_order);
        await noSideways(page);
        await shot('preset-saved');

        // The saved preset survives a reload, and Undo restores the original text.
        await page.close();
        page = await account.open();
        await expect.poll(async () => (await readPreset()).prompts.find(item => item.identifier === 'main').content).toBe(REVIEWED);
        await openPad(page);
        const again = page.locator('.scratchpad-message.is-assistant').filter({ has: page.locator('.scratchpad-change') }).last().locator('.scratchpad-change');
        await expect(again).toContainText('Saved');
        await again.scrollIntoViewIfNeeded();
        await again.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(again).toContainText('Undone');
        await expect.poll(async () => (await readPreset()).prompts.find(item => item.identifier === 'main').content).toBe(MAIN);
        expect((await readPreset()).prompt_order).toEqual(original.prompt_order);
    });
}
