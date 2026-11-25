/* global window, document */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop, and the baseline capture, share one script. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) {
    if (!process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
    test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });
}
const shots = path.resolve('../screenshots/scratchpad-companion-notes');

const ACTIVE = 'ACTIVE-SWIPE-NOTE: Nova reaches the lamp room.';
const UNSELECTED = 'UNSELECTED-SWIPE-NOTE: Nova stays downstairs.';
const KEPT = 'KEPT-SHARD-NOTE: the lamp was first lit in 1890.';
const HIDDEN_ORDINARY = 'HIDDEN-ORDINARY-NOTE: a compass note on a hidden message.';
const HIDDEN_STORY = 'HIDDEN-STORY-TEXT: the keeper is a ghost.';
const SUPPRESSED = 'tracker-none';
const HEADING = '## Companion notes';
const SWITCH = 'input[data-context-control="Companion notes"]';
const fence = request => ['```neconyan-share-request', JSON.stringify(request), '```'].join('\n');
const ASK = [
    'The trackers would tell me where Nova is.',
    '',
    fence({ items: ['companionNotes'], reason: 'I want to read the tracker notes on these messages.' }),
].join('\n');

const textOf = call => call.messages.map(message => String(message.content)).join('\n');
const replyWith = (provider, content) => {
    provider.mode.reply = { choices: [{ message: { content } }] };
};

async function seedChat(page, avatar) {
    await page.evaluate(async ([avatar, notes]) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        const note = (agentName, content, extra = {}) => ({ agentName, status: 'done', content, agentCategory: 'tracker', displayMode: 'card', updatedAt: 1, ...extra });
        const user = mes => ({ name: context.name1, is_user: true, is_system: false, send_date: '', mes, extra: {} });
        context.chat.push(user('I climb the stairs.'));
        context.chat.push({
            name: 'Durable Nova', is_user: false, is_system: false, send_date: '', mes: 'Nova climbs to the lamp room.', extra: {},
            swipe_id: 1,
            swipes: ['Nova stays downstairs.', 'Nova climbs to the lamp room.'],
            swipe_info: [
                { send_date: '', extra: { inChatAgentCompanionResults: { 'plot-compass': note('Plot Compass', notes.unselected) } } },
                { send_date: '', extra: { inChatAgentCompanionResults: {
                    'plot-compass': note('Plot Compass', notes.active),
                    'scene-tracker': note('Scene Tracker', notes.suppressed),
                } } },
            ],
        });
        context.chat.push({
            name: 'Durable Nova', is_user: false, is_system: true, send_date: '', mes: notes.hiddenStory,
            extra: { inChatAgentCompanionResults: {
                'memory-shard': note('Memory Shard', notes.kept, { agentCategory: 'memory', includeInChatHistory: true, keepInChatHistoryWhenHostHidden: true }),
                'plot-compass': note('Plot Compass', notes.hiddenOrdinary),
            } },
        });
        context.chat.push(user('And then?'));
        await context.saveChat({ throwOnError: true });
    }, [avatar, { active: ACTIVE, unselected: UNSELECTED, kept: KEPT, hiddenOrdinary: HIDDEN_ORDINARY, hiddenStory: HIDDEN_STORY, suppressed: SUPPRESSED }]);
}

async function openRoleplay(app, phone, tab = 'context') {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const page = await account.open({ workspace: false });
    await acknowledgeActiveSettings(page);
    await seedChat(page, account.avatar);
    await page.evaluate(async tab => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab }), tab);
    if (phone) await applyIOSOnlyCss(page);
    const source = await page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
    return { account, page, source };
}

async function useDurableConnection(page) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
}

async function alsoShare(page) {
    const section = page.locator('.scratchpad-section').filter({ has: page.getByRole('heading', { name: 'Also share', exact: true }) });
    await expect(async () => { await section.scrollIntoViewIfNeeded(); }).toPass({ timeout: 10000 });
    return section;
}

async function previewText(page) {
    await page.getByRole('button', { name: 'Show preview', exact: true }).click();
    const preview = page.locator('#neconyan-scratchpad pre.scratchpad-preview-text');
    await expect(preview).toBeVisible();
    return preview;
}

async function send(account, page, text) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-composer').fill(text);
    const [response] = await Promise.all([page.waitForResponse('**/api/scratchpad/send'), page.locator('.scratchpad-send').click()]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
}

async function savedSettings(account, source) {
    const bucket = (await account.post('/api/scratchpad/bucket', { source })).bucket;
    return bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings ?? bucket.sessions[0]?.settings;
}

async function capture(page, name) {
    fs.mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.toastr?.remove());
    await page.screenshot({ path: path.join(shots, name) });
}

function expectOnlySharedNotes(text) {
    expect(text).toContain(HEADING);
    expect(text).toContain(`### #2 Durable Nova: Plot Compass [tracker]\n${ACTIVE}`);
    expect(text).toContain(`### Durable Nova: Memory Shard [memory] (on hidden message #3)\n${KEPT}`);
    for (const missing of [UNSELECTED, HIDDEN_ORDINARY, HIDDEN_STORY, 'Scene Tracker', SUPPRESSED]) expect(text).not.toContain(missing);
}

async function expectNoOverflow(page, width) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    const width = phone ? 393 : 1280;

    test(`${size} Roleplay Scratchpad reads Companion notes only when Companion notes is on`, async ({ app }) => {
        test.setTimeout(300000);
        const { account, page, source } = await openRoleplay(app, phone);
        const section = await alsoShare(page);
        const box = section.locator(SWITCH);

        if (before) {
            await expect(box).toHaveCount(0);
            const preview = await previewText(page);
            await expect(preview).toContainText('#2 Durable Nova');
            await expect(preview).not.toContainText(HEADING);
            await expect(preview).not.toContainText(ACTIVE);
            await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
            await preview.scrollIntoViewIfNeeded();
            await capture(page, `${size}-preview-before.png`);
            await section.locator('input[data-context-control="Agents"]').scrollIntoViewIfNeeded();
            await capture(page, `${size}-context-before.png`);
            return;
        }

        // Off by default: no notes in the preview or the sent prompt.
        await expect(box).toHaveCount(1);
        await expect(box).not.toBeChecked();
        await expect(box.locator('xpath=ancestor::label[1]')).toContainText('Shares the finished notes Companion agents wrote on the shared messages');
        let preview = await previewText(page);
        await expect(preview).toContainText('#2 Durable Nova');
        for (const missing of [HEADING, ACTIVE, KEPT, UNSELECTED]) await expect(preview).not.toContainText(missing);

        await useDurableConnection(page);
        replyWith(app.provider, 'Noted.');
        let start = app.provider.calls.length;
        await send(account, page, `Where is Nova? (${size}, off)`);
        let sent = textOf(app.provider.calls.slice(start)[0]);
        expect((await savedSettings(account, source)).include.companionNotes).toBe(false);
        for (const missing of [HEADING, ACTIVE, KEPT, 'Companion notes for this chat:']) expect(sent).not.toContain(missing);
        expect(sent).toContain('- companionNotes: Companion notes (Completed Companion notes on shared messages (trackers, Plot Compass, Memory Shards))');

        // On: the active swipe's note and the kept Memory Shard note, nothing else.
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await (await alsoShare(page)).locator(SWITCH).check();
        expect((await updated).ok()).toBe(true);
        expect((await savedSettings(account, source)).include.companionNotes).toBe(true);
        const row = box.locator('xpath=ancestor::label[1]');
        await row.scrollIntoViewIfNeeded();
        const bounds = await row.boundingBox();
        expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await capture(page, `${size}-context-after.png`);
        preview = await previewText(page);
        await expect(preview).toContainText(ACTIVE);
        expectOnlySharedNotes(await preview.textContent());
        await preview.evaluate(element => {
            const at = element.textContent.indexOf('## Companion notes');
            element.scrollTop = element.scrollHeight * (at / element.textContent.length);
        });
        await preview.scrollIntoViewIfNeeded();
        await capture(page, `${size}-preview-after.png`);
        await expectNoOverflow(page, width);

        start = app.provider.calls.length;
        await send(account, page, `Where is Nova? (${size}, on)`);
        sent = textOf(app.provider.calls.slice(start)[0]);
        expectOnlySharedNotes(sent);
        expect(sent).toContain('Companion notes for this chat:');
        expect(sent).not.toContain('- companionNotes:');
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await expectNoOverflow(page, width);
    });

    test(`${size} share card turns on Companion notes and sends them next turn`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(300000);
        const { account, page, source } = await openRoleplay(app, phone);
        await useDurableConnection(page);
        replyWith(app.provider, ASK);
        await send(account, page, `Where is Nova now? (${size})`);
        const card = page.locator('.scratchpad-message.is-assistant').last().locator('.scratchpad-share-request');
        await expect(card).toBeVisible();
        const boxes = card.locator('input[data-share-item]');
        expect(await boxes.evaluateAll(nodes => nodes.map(node => [node.dataset.shareItem, node.checked]))).toEqual([['companionNotes', true]]);
        await expect(card.locator('label.scratchpad-share-item')).toContainText('Companion notes');
        expect((await savedSettings(account, source)).include.companionNotes).toBe(false);
        const geometry = await card.evaluate(node => ({ right: node.getBoundingClientRect().right, scroll: node.scrollWidth, client: node.clientWidth }));
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
        await card.scrollIntoViewIfNeeded();
        await capture(page, `${size}-share-card-after.png`);

        replyWith(app.provider, 'Nova is in the lamp room.');
        const start = app.provider.calls.length;
        const [response] = await Promise.all([page.waitForResponse('**/api/scratchpad/send'), card.locator('.scratchpad-share-accept').click()]);
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        const followUp = app.provider.calls.slice(start)[0];
        expect(followUp.messages.at(-1).content).toBe('I shared Companion notes. Please continue.');
        expectOnlySharedNotes(textOf(followUp));
        expect((await savedSettings(account, source)).include.companionNotes).toBe(true);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect((await alsoShare(page)).locator(SWITCH)).toBeChecked();
        await expectNoOverflow(page, width);
    });

    test(`${size} Conversation and General Scratchpads have no Companion notes switch`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(300000);
        const { page } = await openRoleplay(app, phone);
        await expect((await alsoShare(page)).locator(SWITCH)).toHaveCount(1);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());

        await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            const avatar = context.characters[context.characterId]?.avatar;
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await expect(page.locator('.scratchpad-source')).not.toContainText('Roleplay');
        expect(await page.evaluate(async () => (await import('/scripts/scratchpad/context.js')).currentSource().kind)).toBe('conversation');
        await alsoShare(page);
        await expect(page.locator(SWITCH)).toHaveCount(0);
        await expect(page.locator('#neconyan-scratchpad')).not.toContainText(ACTIVE);
        await expectNoOverflow(page, width);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());

        await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        await alsoShare(page);
        await expect(page.locator(SWITCH)).toHaveCount(0);
        await expectNoOverflow(page, width);
    });
}
