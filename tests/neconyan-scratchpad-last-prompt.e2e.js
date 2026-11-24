/* global window, document */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop, and the baseline capture, share one script. */
import path from 'node:path';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, send as sendConversation, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) {
    if (!process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
    test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });
}
const capture = process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1';
const shots = path.resolve('../screenshots/scratchpad-last-prompt');
const output = '/tmp/opencode/scratchpad-last-prompt';

const STORY = 'Story reply from the fixture.';
const HEADING = '## Last prompt sent';
const HIDDEN = '[hidden lorebook entry omitted]';
const QUICK = 'Inspect the last prompt sent';
const QUICK_TEXT = 'Look at the last prompt sent to the model for this chat. Tell me what reached it, in what order, and anything that looks wrong or missing.';
const SECRET_MARKER = 'QUILL-ORCHID-7731';
const PLANTED_KEY = 'sk-proj-PLANTEDkey9988776655443322abcd';
const PLANTED_BEARER = 'PLANTEDbearer0011223344556677';

// The chat is shared as ordinary context too, so prompt text is checked inside the section alone.
// The prompt has '##' headings of its own, so the section runs to its closing marker.
const sectionOf = text => {
    const at = text.indexOf(HEADING);
    if (at < 0) return '';
    const rest = text.slice(at);
    const end = ['[end of last prompt sent]', '[end of prompt]'].map(marker => rest.indexOf(marker)).filter(index => index > 0);
    return end.length ? rest.slice(0, Math.min(...end) + 26) : rest.split(/\n## (?!#)/)[0];
};

function replyWith(app, scratchpad = 'Scratchpad reply.') {
    app.provider.mode.reply = body => {
        if (!Array.isArray(body.messages)) return { content: STORY };
        const scratch = body.messages.some(message => String(message.content).includes('Scratchpad'));
        return { choices: [{ message: { role: 'assistant', content: scratch ? scratchpad : STORY } }] };
    };
}

async function openAccount(app, phone, options = {}) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true, ...options });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    return account;
}

async function selectCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    await expect(page.locator('#chat .mes').first()).toBeVisible({ timeout: 30000 });
}

async function idle(page) {
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press), { timeout: 60000 }).toBe(false);
}

function storyCalls(app, from, text) {
    return app.provider.calls.slice(from).filter(call => JSON.stringify(call.messages ?? call.prompt ?? '').includes(text)
        && !JSON.stringify(call.messages ?? '').includes('Scratchpad'));
}

async function sendRoleplay(app, page, text) {
    const from = app.provider.calls.length;
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    await expect(page.locator('#chat .mes').last()).toContainText(STORY, { timeout: 60000 });
    await idle(page);
    const calls = storyCalls(app, from, text);
    expect(calls).toHaveLength(1);
    save(`story-${text.split(' ')[0]}.json`, JSON.stringify({ messages: calls[0].messages, prompt: calls[0].prompt }, null, 2));
    return calls[0];
}

async function openScratchpad(page, phone) {
    await page.evaluate(() => window.toastr?.clear());
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    if (phone) await applyIOSOnlyCss(page);
}

async function hideScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
}

async function contextTab(page) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
}

async function useDurableConnection(page) {
    await contextTab(page);
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
}

const lastPromptSwitch = page => page.getByRole('checkbox', { name: /^Last prompt sent/ });

async function preview(page) {
    await contextTab(page);
    await page.evaluate(() => document.querySelector('#neconyan-scratchpad .scratchpad-preview')?.replaceChildren());
    await page.getByRole('button', { name: 'Show preview', exact: true }).click();
    const pre = page.locator('#neconyan-scratchpad .scratchpad-preview pre.scratchpad-preview-text');
    await expect(pre).toBeVisible({ timeout: 30000 });
    return pre.innerText();
}

async function askScratchpad(app, account, page, question) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-composer').fill(question);
    const [response] = await Promise.all([
        page.waitForResponse('**/api/scratchpad/send'),
        page.locator('.scratchpad-send').click(),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
    const call = app.provider.calls.findLast(item => JSON.stringify(item.messages ?? '').includes('Scratchpad'));
    expect(call).toBeTruthy();
    return call.messages.map(message => String(message.content)).join('\n');
}

function save(name, text) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, name), text);
}

async function shot(page, name) {
    if (!capture) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(shots, `${name}.png`) });
}

function expectMessages(section, messages) {
    expect(section).toContain(`Messages: ${messages.length}`);
    let at = 0;
    messages.forEach((message, index) => {
        const block = `### ${index + 1}. ${message.role}${message.name ? ` (name: ${message.name})` : ''}\n${String(message.content).trim()}`;
        const found = section.indexOf(block, at);
        expect(found, `message ${index + 1} (${message.role}) is shared in order`).toBeGreaterThan(-1);
        at = found + block.length;
    });
}

function layoutWithin(box, phone) {
    expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
}

async function createCharacter(account, name) {
    const response = await account.context.request.post('/api/characters/create', {
        headers: account.headers,
        data: { ch_name: name, description: `${name} keeps quiet.`, first_mes: `${name} waves.` },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.text()).trim();
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';

    test(`${size} before and after captures of the Last prompt sent switch`, async ({ app }) => {
        test.skip(!capture, 'Set NECONYAN_SCRATCHPAD_SCREENSHOTS=1 to capture before and after screenshots.');
        test.setTimeout(240000);
        replyWith(app);
        const account = await openAccount(app, phone);
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        await sendRoleplay(app, page, 'Capture question about the lighthouse.');
        await openScratchpad(page, phone);
        await page.evaluate(() => window.toastr?.clear());
        const label = before ? 'before' : 'after';
        await page.locator('#neconyan-scratchpad .scratchpad-quick button').last().evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'end' }));
        await shot(page, `${size}-quick-prompts-${label}`);
        await contextTab(page);
        const diagnostics = page.getByRole('checkbox', { name: /^App diagnostics/ });
        await diagnostics.scrollIntoViewIfNeeded();
        const row = await diagnostics.locator('..').boundingBox();
        save(`${size}-diagnostics-row-${label}.json`, JSON.stringify(row));
        if (before) {
            await expect(lastPromptSwitch(page)).toHaveCount(0);
            await expect(page.getByRole('button', { name: QUICK, exact: true })).toHaveCount(0);
            await diagnostics.evaluate(element => element.scrollIntoView({ block: 'center' }));
            await shot(page, `${size}-context-before`);
            expect(await preview(page)).not.toContain(HEADING);
            return;
        }
        await lastPromptSwitch(page).check();
        await diagnostics.evaluate(element => element.scrollIntoView({ block: 'center' }));
        await shot(page, `${size}-context-after`);
        const shown = await preview(page);
        expect(shown).toContain(HEADING);
        await page.locator('#neconyan-scratchpad pre.scratchpad-preview-text').evaluate((element, heading) => {
            const at = element.textContent.indexOf(heading);
            const range = document.createRange();
            const text = element.firstChild;
            range.setStart(text, at);
            range.setEnd(text, at);
            const top = range.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
            element.scrollTop = top;
            element.scrollIntoView({ block: 'start' });
        }, HEADING);
        await shot(page, `${size}-preview-after`);
    });

    test(`${size} Roleplay Chat Completion shares the exact last prompt only when asked`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(300000);
        replyWith(app);
        const account = await openAccount(app, phone);
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        const story = await sendRoleplay(app, page, 'CHATA-MARKER what does the lighthouse keeper hide?');
        expect(story.messages.length).toBeGreaterThan(1);

        await openScratchpad(page, phone);
        await useDurableConnection(page);
        const toggle = lastPromptSwitch(page);
        await expect(toggle).not.toBeChecked();
        // Off by default: neither the preview nor the request carries the section or its instructions.
        expect(await preview(page)).not.toContain(HEADING);
        const plain = await askScratchpad(app, account, page, 'Plain question before sharing.');
        expect(plain).not.toContain(HEADING);
        expect(plain).not.toContain('Last prompt sent for this message:');

        await contextTab(page);
        await toggle.check();
        await expect(toggle).toBeChecked();
        await toggle.scrollIntoViewIfNeeded();
        layoutWithin(await toggle.locator('..').boundingBox(), phone);

        const shown = await preview(page);
        save(`${size}-roleplay-preview.txt`, shown);
        const section = sectionOf(shown);
        expect(section).toMatch(/^Sent: \d{4}-\d\d-\d\dT/m);
        expect(section).toContain('Mode: Roleplay, Chat Completion');
        expect(section).toMatch(/Context limit: \d+ tokens/);
        expect(section).toMatch(/Token counts: /);
        expectMessages(section, story.messages);

        const sent = await askScratchpad(app, account, page, 'What reached the model?');
        save(`${size}-roleplay-request.txt`, sent);
        expect(sent).toContain('Last prompt sent for this message:');
        const sentSection = sectionOf(sent);
        expect(sentSection).toContain('Mode: Roleplay, Chat Completion');
        expectMessages(sentSection, story.messages);
        await hideScratchpad(page);

        // A second chat that has sent nothing yet never borrows Chat A's prompt.
        const wren = await createCharacter(account, 'Quiet Wren');
        await selectCharacter(page, wren);
        await openScratchpad(page, phone);
        await useDurableConnection(page);
        await lastPromptSwitch(page).check();
        const empty = await preview(page);
        expect(sectionOf(empty)).toContain('No prompt has been sent in this chat yet');
        expect(empty).not.toContain('CHATA-MARKER');
        const emptySent = await askScratchpad(app, account, page, 'Anything in this chat yet?');
        expect(sectionOf(emptySent)).toContain('No prompt has been sent in this chat yet');
        expect(emptySent).not.toContain('CHATA-MARKER');
        expect(emptySent).not.toContain('Last prompt sent for this message:');
        await hideScratchpad(page);

        // General Scratchpad offers no switch and never attaches a story prompt, even when asked directly.
        await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
        await openScratchpad(page, phone);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        await useDurableConnection(page);
        await expect(lastPromptSwitch(page)).toHaveCount(0);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(page.getByRole('button', { name: QUICK, exact: true })).toHaveCount(0);
        const general = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            const built = await context.buildContext({ source: context.currentSource(), settings: { include: { lastPrompt: true, chat: true } }, pendingText: '', sessionText: '' });
            return { text: built.text, capabilities: built.capabilities };
        });
        expect(general.text).not.toContain(HEADING);
        expect(general.text).not.toContain('CHATA-MARKER');
        expect(general.capabilities.lastPrompt).toBeUndefined();
        const generalSent = await askScratchpad(app, account, page, 'General question.');
        expect(generalSent).not.toContain(HEADING);
        expect(generalSent).not.toContain('CHATA-MARKER');
        await hideScratchpad(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });

    test(`${size} Roleplay Text Completion shares the exact prompt string through /check prompt`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(240000);
        replyWith(app);
        const url = app.provider.url;
        const account = await openAccount(app, phone, {
            configureSettings: saved => {
                saved.main_api = 'textgenerationwebui';
                saved.textgenerationwebui_settings = {
                    ...saved.textgenerationwebui_settings,
                    type: 'llamacpp', api_server: url, streaming: false,
                    server_urls: { ...saved.textgenerationwebui_settings?.server_urls, llamacpp: url },
                    banned_tokens: '', global_banned_tokens: '', logit_bias: [], dry_sequence_breakers: '[]', negative_prompt: '',
                };
                saved.max_context = 8192;
                saved.power_user = { ...saved.power_user, custom_stopping_strings: '[]', auto_label_chat: false };
            },
        });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        const story = await sendRoleplay(app, page, 'TEXTMARKER tell me about the harbour.');
        expect(typeof story.prompt).toBe('string');

        await openScratchpad(page, phone);
        await useDurableConnection(page);
        await expect(lastPromptSwitch(page)).not.toBeChecked();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('/check prompt');
        const [response] = await Promise.all([
            page.waitForResponse('**/api/scratchpad/send'),
            page.locator('.scratchpad-send').click(),
        ]);
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on Last prompt sent for this session.' }).first()).toBeVisible();
        const call = app.provider.calls.findLast(item => JSON.stringify(item.messages ?? '').includes('Scratchpad'));
        expect(call.messages.at(-1).content).toBe(QUICK_TEXT);
        const sent = call.messages.map(message => String(message.content)).join('\n');
        save(`${size}-text-request.txt`, sent);
        const sentSection = sectionOf(sent);
        expect(sentSection).toContain('Mode: Roleplay, Text Completion');
        expect(sentSection).toContain(`Prompt text (exact):\n${story.prompt}\n[end of prompt]`);
        await contextTab(page);
        await expect(lastPromptSwitch(page)).toBeChecked();
        await expect(page.getByRole('checkbox', { name: /^Problem checks/ })).not.toBeChecked();
        const shown = sectionOf(await preview(page));
        save(`${size}-text-preview.txt`, shown);
        expect(shown).toContain(`Prompt text (exact):\n${story.prompt}\n[end of prompt]`);
        await hideScratchpad(page);
    });

    test(`${size} regenerating an earlier reply shares the newly sent prompt`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(240000);
        replyWith(app);
        const account = await openAccount(app, phone);
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        await sendRoleplay(app, page, 'FIRSTASK where is the map?');

        // Impersonate records a later prompt for the next message, then the earlier reply is swiped.
        const from = app.provider.calls.length;
        await page.evaluate(async () => { await (await import('/script.js')).Generate('impersonate'); });
        await idle(page);
        expect(app.provider.calls.length).toBeGreaterThan(from);
        await page.locator('#send_textarea').fill('');
        await page.evaluate(async () => {
            const { oai_settings } = await import('/scripts/openai.js');
            const main = oai_settings.prompts.find(prompt => prompt.identifier === 'main');
            main.content = `${main.content} SWIPEMARKER-42`;
        });
        const swipeFrom = app.provider.calls.length;
        await page.evaluate(async () => { await (await import('/script.js')).swipe_right(null, {}); });
        await idle(page);
        const swipe = storyCalls(app, swipeFrom, 'SWIPEMARKER-42');
        expect(swipe).toHaveLength(1);
        const order = await page.evaluate(async () => (await import('/scripts/itemized-prompts.js')).itemizedPrompts
            .map(entry => ({ mesId: entry.mesId, type: entry.generationType, recordedAt: entry.recordedAt })));
        save(`${size}-regenerate-itemized.json`, JSON.stringify(order, null, 2));
        // The newest prompt sits earlier in the list, so a 'last entry' rule would pick the impersonation.
        expect(order.at(-1).type).toBe('impersonate');
        expect(order.find(entry => entry.type === 'swipe').recordedAt).toBeGreaterThan(order.at(-1).recordedAt);

        await openScratchpad(page, phone);
        await useDurableConnection(page);
        await lastPromptSwitch(page).check();
        const section = sectionOf(await preview(page));
        save(`${size}-regenerate-preview.txt`, section);
        expect(section).toContain('SWIPEMARKER-42');
        expect(section).toContain('swipe request');
        expect(section).not.toContain('Write your next reply from the point of view of');
        expectMessages(section, swipe[0].messages);
        const sent = sectionOf(await askScratchpad(app, account, page, 'Which prompt went last?'));
        expect(sent).toContain('SWIPEMARKER-42');
        expectMessages(sent, swipe[0].messages);
        await hideScratchpad(page);
    });

    test(`${size} Conversation send shares its system prompt and transcript from the quick prompt`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(240000);
        replyWith(app);
        const account = await openAccount(app, phone);
        const page = await account.open();
        const from = app.provider.calls.length;
        const accepted = await sendConversation(page, 'CONVOMARKER are you awake?');
        await account.settled(accepted.job.id);
        const story = storyCalls(app, from, 'CONVOMARKER');
        expect(story.length).toBeGreaterThan(0);
        const call = story.at(-1);
        expect(call.messages[0].role).toBe('system');

        await openScratchpad(page, phone);
        await useDurableConnection(page);
        await expect(lastPromptSwitch(page)).not.toBeChecked();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.getByRole('button', { name: QUICK, exact: true }).click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on Last prompt sent for this session.' }).first()).toBeVisible();
        await expect(page.locator('.scratchpad-composer')).toHaveValue(QUICK_TEXT);
        await contextTab(page);
        await expect(lastPromptSwitch(page)).toBeChecked();
        const section = sectionOf(await preview(page));
        save(`${size}-conversation-preview.txt`, section);
        expect(section).toContain('Mode: Conversation, Chat Completion');
        expect(section).toContain('Speaker: Durable Nova');
        expectMessages(section, call.messages);

        const sent = await askScratchpad(app, account, page, QUICK_TEXT);
        save(`${size}-conversation-request.txt`, sent);
        expect(sent).toContain('Last prompt sent for this message:');
        expectMessages(sectionOf(sent), call.messages);
        await hideScratchpad(page);
    });

    test(`${size} hidden lorebook entries and credentials never reach Scratchpad`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(240000);
        replyWith(app);
        const account = await openAccount(app, phone, {
            configureSettings: saved => {
                saved.world_info_settings = { ...saved.world_info_settings, world_info: { globalSelect: ['Hidden Vault'] } };
            },
        });
        await account.post('/api/worldinfo/edit', {
            name: 'Hidden Vault',
            data: { entries: { 0: {
                uid: 0, key: ['vault'], keysecondary: [], comment: 'Vault cipher', content: 'The Moonvault cipher for {{char}} is quill-orchid-7731, told only to {{user}}.',
                constant: true, selective: false, disable: false, agentBlacklisted: true, order: 100, position: 0, depth: 4, probability: 100, useProbability: true,
            } } },
        });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await page.evaluate(async () => {
            const { oai_settings } = await import('/scripts/openai.js');
            const main = oai_settings.prompts.find(prompt => prompt.identifier === 'main');
            main.content = `${main.content}\nKEYLINE ${'sk-proj-PLANTEDkey9988776655443322abcd'}\nAuthorization: Bearer ${'PLANTEDbearer0011223344556677'}`;
        });
        await selectCharacter(page, account.avatar);
        const story = await sendRoleplay(app, page, 'PRIVACYASK what is in the vault?');
        const storyText = JSON.stringify(story.messages);
        expect(storyText.toUpperCase()).toContain(SECRET_MARKER);
        expect(storyText).toContain(PLANTED_KEY);
        expect(storyText).toContain(PLANTED_BEARER);

        await openScratchpad(page, phone);
        await useDurableConnection(page);
        await lastPromptSwitch(page).check();
        const shown = await preview(page);
        save(`${size}-privacy-preview.txt`, shown);
        const sent = await askScratchpad(app, account, page, 'Did the vault reach the model?');
        save(`${size}-privacy-request.txt`, sent);
        for (const text of [shown, sent]) {
            const lower = text.toLowerCase();
            expect(lower).not.toContain(SECRET_MARKER.toLowerCase());
            expect(lower).not.toContain('moonvault cipher');
            expect(lower).not.toContain(PLANTED_KEY.toLowerCase());
            expect(lower).not.toContain(PLANTED_BEARER.toLowerCase());
            const section = sectionOf(text);
            expect(section).toContain(HIDDEN);
            expect(section).toContain('Hidden lorebook entries were omitted.');
            expect(section).toMatch(/Credentials were redacted \(\d+\)\./);
            expect(section).toContain('KEYLINE');
        }

        // Real loadWorldInfo returns null on HTTP 500 rather than throwing; fail closed so hidden entries never leak.
        await page.evaluate(async () => (await import('/scripts/world-info.js')).invalidateWorldInfoCache('Hidden Vault'));
        const failLore = route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unavailable"}' });
        await page.route('**/api/worldinfo/get', failLore);
        try {
            const blockedPreview = await preview(page);
            const blockedSent = await askScratchpad(app, account, page, 'Try again while lorebook read fails.');
            for (const text of [blockedPreview, blockedSent]) {
                expect(text.toLowerCase()).not.toContain(SECRET_MARKER.toLowerCase());
                expect(text.toLowerCase()).not.toContain('moonvault cipher');
                expect(sectionOf(text)).toContain('left the last prompt out to keep hidden entries private');
            }
            expect(blockedSent).not.toContain('Last prompt sent for this message:');
        } finally {
            await page.unroute('**/api/worldinfo/get', failLore);
        }
        await hideScratchpad(page);
    });
}
