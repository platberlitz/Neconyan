/* global window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

// Set NECONYAN_SCRATCHPAD_SHORTCUT_BASELINE_ROOT to run the no-shortcut checks against another checkout (the one before the change),
// and NECONYAN_SCRATCHPAD_SHORTCUT_RECORD to a file path to keep what was sent, for comparing two checkouts.
const baseline = process.env.NECONYAN_SCRATCHPAD_SHORTCUT_BASELINE_ROOT;
if (baseline) test.use({ initialServerOptions: { checkoutRoot: baseline } });

const REQUESTS = {
    card: 'Check the shared card for problems and explain how to fix them.',
    preset: 'Check the shared preset for problems and explain how to fix them.',
    lorebook: 'Check the shared lorebook for problems and explain how to fix them.',
    why: 'Check the activation trace and explain why a lorebook entry did not trigger, and offer a fix if needed.',
    app: 'Use the app diagnostics to tell me what went wrong in Neconyan, and what I should try or share next.',
};
const LABELS = { card: 'Check my card', preset: 'Check my preset', lorebook: 'Check my lorebook', why: 'Why didn\'t an entry trigger?', app: 'What went wrong in Neconyan?' };

async function equipPreset(page, name, prompt) {
    await page.evaluate(async ({ name, prompt }) => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('openai');
        const preset = structuredClone(manager.getPresetSettings());
        preset.prompts.find(item => item.identifier === 'main').content = prompt;
        await manager.savePreset(name, preset);
    }, { name, prompt });
}

async function openScratchpad(page, phone) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    if (phone) await applyIOSOnlyCss(page);
}

function pad(page, account, app) {
    const composer = page.locator('.scratchpad-composer');
    const send = page.locator('.scratchpad-send');
    const toasts = page.locator('#toast-container .toast');
    const tab = name => page.getByRole('tab', { name, exact: true });
    const state = {
        page, composer, send, toasts, tab,
        async source() {
            return page.evaluate(async () => {
                const context = await import('/scripts/scratchpad/context.js');
                return context.wireSource(context.currentSource());
            });
        },
        async settings() {
            const bucket = (await account.post('/api/scratchpad/bucket', { source: await state.source() })).bucket;
            return bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings;
        },
        async include() {
            return (await state.settings())?.include ?? null;
        },
        async clearToasts() {
            await page.evaluate(() => window.toastr.clear());
            await expect(toasts).toHaveCount(0);
        },
        async newSession() {
            await page.locator('.scratchpad-new-session').first().click();
            await expect(page.locator('.scratchpad-message')).toHaveCount(0);
        },
        async connect(assistants = ['miso']) {
            await tab('Context').click();
            for (const id of assistants) await page.locator(`#scratchpad-connection-${id}`).selectOption('durable');
            await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
            await tab('Chat').click();
        },
        async submit(text) {
            await composer.fill(text);
            const accepted = page.waitForResponse('**/api/scratchpad/send');
            await send.click();
            const response = await accepted;
            expect(response.ok(), await response.text()).toBe(true);
            const body = await response.json();
            await account.settled(body.job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            return body;
        },
        async refuse(text, expected) {
            const calls = app.provider.calls.length;
            const messages = await page.locator('.scratchpad-message.is-user').count();
            const before = await state.include();
            await composer.fill(text);
            await send.click();
            const toast = toasts.filter({ hasText: 'Nothing was sent' }).last();
            await expect(toast).toContainText(expected);
            await expect(composer).toHaveValue(text);
            await expect(composer).toBeFocused();
            expect(app.provider.calls.length).toBe(calls);
            await expect(page.locator('.scratchpad-message.is-user')).toHaveCount(messages);
            expect(await state.include()).toEqual(before);
            const shown = await toast.innerText();
            await state.clearToasts();
            return shown;
        },
        async chip(key) {
            await page.locator('.scratchpad-quick').getByRole('button', { name: LABELS[key], exact: true }).click();
        },
        async turnedOn() {
            const toast = toasts.filter({ hasText: 'Turned on' }).first();
            await expect(toast).toBeVisible();
            return toast.innerText();
        },
    };
    return state;
}

/**
 * Runs one check twice from the same starting point, once through its quick prompt and once through its shortcut, in the real page,
 * and requires the same sharing to be switched on with the same notice and the same request.
 */
async function compareWithButton(page, account, app, pad_, key, shortcut, { prepare = async () => {}, expectOn, untouched, shared = {} }) {
    await pad_.newSession();
    await prepare();
    await restoreSwitches(pad_, page, { ...untouched, ...shared });
    const start = await pad_.include();
    await pad_.chip(key);
    const buttonNotice = await pad_.turnedOn();
    await expect(pad_.composer).toHaveValue(REQUESTS[key]);
    await expect.poll(() => pad_.include()).not.toEqual(start);
    const byButton = await pad_.include();
    await pad_.clearToasts();
    await pad_.composer.fill('');

    await pad_.newSession();
    await prepare();
    await restoreSwitches(pad_, page, start);
    expect(await pad_.include()).toEqual(start);
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: `Checked ${key}.` } }] };
    await pad_.submit(shortcut);
    const shortcutNotice = await pad_.turnedOn();
    const byShortcut = await pad_.include();
    const shown = await page.locator('.scratchpad-message.is-user').last().innerText();
    const sentToModel = app.provider.calls.at(-1).messages.at(-1).content;
    await pad_.clearToasts();

    expect(byShortcut).toEqual(byButton);
    expect(shortcutNotice).toBe(buttonNotice);
    expect(sentToModel).toBe(REQUESTS[key]);
    expect(shown).toContain(REQUESTS[key]);
    expect(shown).not.toContain('/check');
    await expect(pad_.composer).toHaveValue('');
    const changed = Object.keys(byShortcut).filter(name => byShortcut[name] !== start[name]).sort();
    expect(changed).toEqual([...expectOn].sort());
    return { key, shortcut, notice: shortcutNotice, switchedOn: changed, request: sentToModel, shown, byShortcut };
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    const shots = name => path.resolve('../screenshots/scratchpad-check-shortcuts', `${size}-${name}.png`);
    const capture = process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1';
    if (capture) fs.mkdirSync(path.resolve('../screenshots/scratchpad-check-shortcuts'), { recursive: true });

    test(`${phone ? 'iPhone stand-in' : 'desktop'} General Scratchpad runs checks from typed shortcuts and explains what is missing`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/worldinfo/edit', { name: 'Harbour Checks', data: { entries: {
            0: { uid: 0, comment: 'Harbourmaster', key: ['harbourmaster'], constant: false, content: 'The harbourmaster lives by the quay.' },
        } } });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        await equipPreset(page, 'Harbour', 'Harbour prompt.');
        await openScratchpad(page, phone);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const pad_ = pad(page, account, app);
        await pad_.connect();
        const { composer, send, toasts } = pad_;
        const untouched = await pad_.include();

        // The list shows the shortcuts under their own heading, apart from the tools that work out a value.
        await composer.fill('/tools');
        await send.click();
        await expect(toasts.filter({ hasText: 'Typed tools' })).toContainText('Tools that work out a value');
        await expect(toasts.filter({ hasText: 'Typed tools' })).toContainText('Shortcuts that run a check');
        await expect(toasts.filter({ hasText: 'Typed tools' })).toContainText('/check card, /check preset, /check lorebook, /check app, /check prompt, or /why');
        await expect(composer).toHaveValue('/tools');
        if (capture) await page.screenshot({ path: shots('tools-list') });
        await pad_.clearToasts();
        await composer.fill('');

        // A bare /check lists what can be checked now and why the rest cannot. Nothing is sent or switched on.
        await composer.fill('/check');
        await send.click();
        const list = toasts.filter({ hasText: 'Ready to check' });
        await expect(list).toContainText('/check app');
        await expect(list).toContainText('Not available right now');
        await expect(list).toContainText('/check card');
        await expect(list).toContainText('General Scratchpad has no character card to share here.');
        await expect(list).toContainText('/check preset');
        await expect(list).toContainText('No preset is shared. Turn on Current preset under Also share in the Context tab, then try again.');
        await expect(list).toContainText('/check lorebook, /why <entry>');
        await expect(list).toContainText('No lorebook is picked. Pick one under Share a lorebook in the Context tab, then try again.');
        await expect(composer).toHaveValue('/check');
        expect(await pad_.include()).toEqual(untouched);
        expect(app.provider.calls.length).toBe(0);
        if (capture) await page.screenshot({ path: shots('check-list') });
        await pad_.clearToasts();
        await composer.fill('');

        // Anything that cannot be checked is refused, with the text left in the box.
        const refusals = [];
        refusals.push(await pad_.refuse('/check card', 'General Scratchpad has no character card to share here.'));
        refusals.push(await pad_.refuse('/check preset', 'No preset is shared. Turn on Current preset under Also share in the Context tab, then try again.'));
        refusals.push(await pad_.refuse('/check lorebook', 'No lorebook is picked. Pick one under Share a lorebook in the Context tab, then try again.'));
        refusals.push(await pad_.refuse('/why Harbourmaster', 'No lorebook is picked.'));
        refusals.push(await pad_.refuse('/check carrd', 'Scratchpad can\'t check \'carrd\'. Use /check card, /check preset, /check lorebook, /check app or /check prompt'));
        refusals.push(await pad_.refuse('/check app\n/check card', 'Use one /check or /why shortcut per message'));
        refusals.push(await pad_.refuse('Look at this\n/check', 'Say what to check after /check: card, preset, lorebook, app or prompt.'));
        if (capture) {
            await composer.fill('/check preset');
            await send.click();
            await toasts.filter({ hasText: 'Nothing was sent' }).waitFor();
            await page.screenshot({ path: shots('refused') });
            await pad_.clearToasts();
            await composer.fill('');
        }

        // Text that only looks like a shortcut is sent exactly as typed, with no sharing switched on.
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Plain.' } }] };
        const ordinary = ['Please /check card for me\n```\n/check app\n```\nThanks', 'Does /why matter?', '/checkcard\n/check-app'];
        const sentAsTyped = [];
        for (const text of ordinary) {
            await pad_.submit(text);
            expect(app.provider.calls.at(-1).messages.at(-1).content).toBe(text);
            sentAsTyped.push(text);
        }
        expect(await pad_.include()).toEqual(untouched);

        // Each shortcut switches on exactly what its quick prompt does, with the same notice, and sends the readable request.
        const pairs = [];
        pairs.push(await compareWithButton(page, account, app, pad_, 'app', '/check app', { expectOn: ['appEvidence'], untouched }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'preset', '/check preset', {
            prepare: () => tabPrepare(pad_, page, 'preset', 'Harbour'),
            expectOn: ['problems'],
            untouched,
            shared: { preset: true },
        }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'lorebook', '/check lorebook', {
            prepare: () => tabPrepare(pad_, page, 'lorebook', 'Harbour Checks'),
            expectOn: ['problems'],
            untouched,
        }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'why', '/why', {
            prepare: () => tabPrepare(pad_, page, 'lorebook', 'Harbour Checks'),
            expectOn: ['problems'],
            untouched,
        }));

        expect(refusals).toHaveLength(7);
        expect(sentAsTyped).toHaveLength(3);
        expect(pairs.map(pair => pair.key)).toEqual(['app', 'preset', 'lorebook', 'why']);
    });
}

async function createCharacter(account, name, world) {
    const created = await account.context.request.post('/api/characters/create', {
        headers: account.headers,
        data: { ch_name: name, description: 'Keeps the harbour light.', first_mes: 'The lighthouse stands above the calm harbour.', ...(world ? { world } : {}) },
    });
    expect(created.ok(), await created.text()).toBe(true);
    return created.text();
}

async function selectCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
    }, avatar);
    await expect(page.locator('#chat .mes_text').first()).toContainText('The lighthouse stands above the calm harbour.');
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Roleplay chat and round table run checks from typed shortcuts`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const book = `Harbour Chat Book ${phone ? 'phone' : 'desktop'}`;
        await account.post('/api/worldinfo/edit', { name: book, data: { entries: {
            0: { uid: 0, comment: 'Harbourmaster', key: ['harbourmaster'], constant: false, content: 'The harbourmaster lives by the quay.' },
        } } });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        await equipPreset(page, 'Harbour', 'Harbour prompt.');
        await selectCharacter(page, await createCharacter(account, `Trace Keeper ${phone ? 'phone' : 'desktop'}`, book));
        await openScratchpad(page, phone);
        const pad_ = pad(page, account, app);
        expect((await pad_.source()).kind).toBe('roleplay');
        await pad_.connect(['miso', 'taro', 'nori']);
        const { composer, toasts } = pad_;
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Checked.' } }] };

        // Start with everything the checks can switch on turned off, so every notice has something to name.
        await pad_.tab('Context').click();
        for (const key of ['card', 'lore', 'problems', 'appEvidence', 'preset']) await page.getByRole('checkbox', { name: SWITCHES[key] }).setChecked(false);
        await pad_.tab('Chat').click();
        const untouched = await pad_.include();
        expect(untouched).toMatchObject({ card: false, lore: false, problems: false, appEvidence: false, preset: false });

        const pairs = [];
        pairs.push(await compareWithButton(page, account, app, pad_, 'card', '/check card', { expectOn: ['card', 'problems'], untouched }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'preset', '/check preset', { expectOn: ['preset', 'problems'], untouched }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'lorebook', '/check lorebook', { expectOn: ['lore', 'problems'], untouched }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'why', '/why', { expectOn: ['lore', 'problems'], untouched }));
        pairs.push(await compareWithButton(page, account, app, pad_, 'app', '/check app', { expectOn: ['appEvidence'], untouched }));
        expect(pairs.find(pair => pair.key === 'preset').notice).toContain('Current preset');
        expect(pairs.find(pair => pair.key === 'card').notice).toContain('Character cards');
        expect(pairs.find(pair => pair.key === 'lorebook').notice).toContain('Lorebook entries');

        // The typed name goes into the request, and text after the command is added to it.
        await pad_.newSession();
        await restoreSwitches(pad_, page, untouched);
        await pad_.submit('/why Harbourmaster');
        const named = app.provider.calls.at(-1).messages.at(-1).content;
        expect(named).toBe('Check the activation trace and explain why the lorebook entry \'Harbourmaster\' (its title or one of its keys) did not trigger, and offer a fix if needed.');
        await expect(page.locator('.scratchpad-message.is-user').last()).toContainText('Harbourmaster');
        await expect(page.locator('.scratchpad-message.is-user').last()).not.toContainText('/why');
        await pad_.clearToasts();
        await pad_.submit('/check card focus on the greeting');
        const extra = app.provider.calls.at(-1).messages.at(-1).content;
        expect(extra).toBe(`${REQUESTS.card}\n\nfocus on the greeting`);
        await expect(page.locator('.scratchpad-message.is-user').last()).not.toContainText('/check');
        await pad_.clearToasts();

        // A tool line in the same message is worked out as before, and the shortcut still runs.
        await pad_.submit('/calc 2+3\n/check app');
        const mixed = app.provider.calls.at(-1).messages.at(-1).content;
        expect(mixed).toContain(REQUESTS.app);
        expect(mixed).not.toContain('/calc');
        expect(mixed).not.toContain('/check');
        expect(mixed).toMatch(/\b5\b/);
        await pad_.clearToasts();

        // A character with no lorebook cannot run the lorebook checks, and nothing is sent.
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await selectCharacter(page, await createCharacter(account, `No Book ${phone ? 'phone' : 'desktop'}`));
        await openScratchpad(page, phone);
        await pad_.refuse('/check lorebook', 'No lorebook is linked to this chat.');
        await pad_.refuse('/why Harbourmaster', 'No lorebook is linked to this chat.');
        await expect(pad_.composer).toHaveValue('/why Harbourmaster');
        await composer.fill('');

        // One assistant or a round table: the same one request goes to each assistant that answers.
        await pad_.newSession();
        const before = app.provider.calls.length;
        await pad_.submit('/check app');
        expect(app.provider.calls.length - before).toBe(1);
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 3');
        const roundBefore = app.provider.calls.length;
        await pad_.submit('/check card with every voice');
        const round = app.provider.calls.slice(roundBefore);
        expect(round).toHaveLength(3);
        for (const call of round) expect(call.messages.at(-1).content).toBe(`${REQUESTS.card}\n\nwith every voice`);
        await expect(toasts.filter({ hasText: 'Nothing was sent' })).toHaveCount(0);
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Conversation chats explain what a shortcut cannot check`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await openScratchpad(page, phone);
        const pad_ = pad(page, account, app);
        expect((await pad_.source()).kind).toBe('conversation');
        await pad_.connect();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Checked.' } }] };
        const untouched = await pad_.include();
        await pad_.refuse('/check preset', 'Conversation chats can\'t share a preset.');
        await pad_.refuse('/check lorebook', 'No lorebook is linked to this Conversation.');
        await pad_.refuse('/why Harbourmaster', 'No lorebook is linked to this Conversation.');
        const pair = await compareWithButton(page, account, app, pad_, 'app', '/check app', { expectOn: ['appEvidence'], untouched });
        expect(pair.request).toBe(REQUESTS.app);
    });
}

const PLAIN = [
    { text: 'hello', expected: 'hello' },
    { text: '  spaced   text  ', expected: 'spaced   text' },
    { text: 'Please /check card for me', expected: 'Please /check card for me' },
    { text: 'Does /why matter?', expected: 'Does /why matter?' },
    { text: '/checkcard\n/check-app', expected: '/checkcard\n/check-app' },
    { text: 'Look:\n```\n/check app\n/why x\n```\ndone', expected: 'Look:\n```\n/check app\n/why x\n```\ndone' },
    { text: '/foo bar', expected: '/foo bar' },
    { text: 'Line one\n\n\nLine four with 🌸 and こんにちは', expected: 'Line one\n\n\nLine four with 🌸 and こんにちは' },
    { text: '/calc 12*(3+4)' },
    { text: 'Total:\n/calc 2+3\nthanks' },
    { text: '/pick same | same' },
    { text: '/roll 0d6\nand some words', sends: false },
    { text: '/tools', sends: false },
    { text: '/calc 1/0', sends: false },
];

/** Messages with no shortcut in them. Set NECONYAN_SCRATCHPAD_SHORTCUT_RECORD to a file to keep everything that went out, for comparing two checkouts. */
async function sendPlain(pad_, app, entry) {
    const calls = app.provider.calls.length;
    const includeBefore = await pad_.include();
    await pad_.clearToasts();
    let shown = null;
    if (entry.sends === false) {
        await pad_.composer.fill(entry.text);
        await pad_.send.click();
        await expect(pad_.toasts.first()).toBeVisible();
    } else {
        await pad_.submit(entry.text);
        shown = await pad_.page.locator('.scratchpad-message.is-user').last().innerText();
    }
    const sent = app.provider.calls.slice(calls).map(call => ({ model: call.model, messages: call.messages })).sort((a, b) => String(a.model).localeCompare(String(b.model)));
    if (entry.sends === false) expect(sent).toHaveLength(0);
    else {
        expect(sent.length).toBeGreaterThan(0);
        const last = sent[0].messages.at(-1).content;
        if (entry.expected !== undefined) expect(last).toBe(entry.expected);
        else expect(last).not.toMatch(/^\/(?:calc|pick|roll)\b/m);
    }
    return {
        text: entry.text,
        shown,
        sent,
        toasts: await pad_.toasts.allInnerTexts(),
        composerAfter: await pad_.composer.inputValue(),
        includeBefore,
        includeAfter: await pad_.include(),
    };
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} messages with no shortcut are sent exactly as before`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        await openScratchpad(page, phone);
        const pad_ = pad(page, account, app);
        await pad_.connect(['miso', 'taro', 'nori']);
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Noted.' } }] };
        const recorded = { general: [], roleplay: [], roundTable: [] };
        for (const entry of PLAIN) recorded.general.push(await sendPlain(pad_, app, entry));

        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await selectCharacter(page, await createCharacter(account, `Plain Keeper ${phone ? 'phone' : 'desktop'}`));
        await openScratchpad(page, phone);
        expect((await pad_.source()).kind).toBe('roleplay');
        for (const entry of PLAIN) recorded.roleplay.push(await sendPlain(pad_, app, entry));

        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 3');
        recorded.roundTable.push(await sendPlain(pad_, app, PLAIN[2]));
        expect(recorded.roundTable[0].sent).toHaveLength(3);

        if (process.env.NECONYAN_SCRATCHPAD_SHORTCUT_RECORD) {
            fs.writeFileSync(`${process.env.NECONYAN_SCRATCHPAD_SHORTCUT_RECORD}-${phone ? 'phone' : 'desktop'}.json`, JSON.stringify(recorded, null, 2));
        }
    });
}

const SWITCHES = { problems: /^Problem checks/, appEvidence: /^App diagnostics/, preset: /^Current preset/, lore: /^Lorebook entries/, card: /^Character cards/ };

/** A new session starts from the last session's sharing, so put the switches back to where the first run started. */
async function restoreSwitches(pad_, page, wanted) {
    const now = await pad_.include();
    const different = Object.keys(SWITCHES).filter(key => now[key] !== wanted[key]);
    if (!different.length) return;
    await pad_.tab('Context').click();
    for (const key of different) {
        await page.getByRole('checkbox', { name: SWITCHES[key] }).setChecked(wanted[key]);
    }
    await expect.poll(() => pad_.include()).toEqual(wanted);
    await pad_.tab('Chat').click();
}

async function tabPrepare(pad_, page, what, value) {
    await pad_.tab('Context').click();
    if (what === 'preset') await page.getByRole('checkbox', { name: /^Current preset:/ }).check();
    else await page.locator('#scratchpad-lorebook').selectOption(value);
    await expect.poll(async () => what === 'preset' ? (await pad_.include())?.preset : (await pad_.settings())?.lorebook).toBe(what === 'preset' ? true : value);
    await pad_.tab('Chat').click();
}
