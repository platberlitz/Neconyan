/* global window, document */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
// Conversation 'Lorebook Override': the chosen book, or on 'Character default' the speaking card's linked books,
// reach the model request on every reply path.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test, send, MODEL } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires the disposable fixture.');
test.setTimeout(300000);

const CONFIG = '/api/neconyan-conversation';
const BOOK = 'Override Book';
const FOCUS = `Conversation lorebook focus: ${BOOK}.`;
const KEYED = 'ZEPHYR-LORE the zephyr is a warm wind.';
const CONSTANT = 'CONSTANT-LORE the lantern never goes out.';
const NEVER = 'NEVER-LORE this entry has no chance of firing.';
const CARD = 'CARD-LORE linked only to the card.';
const CARD_KEYED = 'CARDKEY-LORE the card knows the zephyr.';
const CARD_NEVER = 'CARDNEVER-LORE the card entry that never fires.';
const EXTRA = 'EXTRA-LORE an extra book linked to the card.';
const EXTRA_KEYED = 'EXTRAKEY-LORE the harbour is quiet.';
const GLOBAL = 'GLOBAL-LORE selected globally.';
const OTHER = 'OTHER-LORE sits in a book nobody chose.';
const CHAT = 'CHATBOOK-LORE bound to a roleplay chat.';
const PERSONA = 'PERSONA-LORE bound to the persona.';
const KIT = 'KIT-LORE belongs to Group Kit.';
const DEFAULT_BOOKS = 'Lorebook entries from Card Book, Extra Card Book:';
const SHOTS = process.env.NECONYAN_LOREBOOK_CAPTURE || '';

const entry = (uid, extra) => ({ uid, key: [], keysecondary: [], comment: 'c' + uid, content: '', constant: false, selective: false, order: 100, position: 0, disable: false, ...extra });

async function linkCard(account, avatar, world) {
    const merged = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar, data: { extensions: { world } } } });
    expect(merged.ok(), await merged.text()).toBe(true);
}

async function linkExtraBooks(account, avatar, extraBooks) {
    const saved = JSON.parse((await account.post('/api/settings/get')).settings);
    saved.world_info_settings ??= {};
    saved.world_info_settings.world_info = { ...(saved.world_info_settings.world_info || {}), charLore: [{ name: path.parse(avatar).name, extraBooks }] };
    await account.post('/api/settings/save', saved);
}

/** Plants every book; `links` decides whether the card links 'Card Book' and 'Extra Card Book'. */
async function plant(account, { links = true, main = 'Card Book' } = {}) {
    const book = (name, entries) => account.post('/api/worldinfo/edit', { name, data: { entries } });
    await book(BOOK, {
        0: entry(0, { key: ['zephyr'], content: KEYED }),
        1: entry(1, { constant: true, content: CONSTANT }),
        2: entry(2, { key: ['zephyr'], content: NEVER, useProbability: true, probability: 0 }),
    });
    await book('Card Book', {
        0: entry(0, { constant: true, content: CARD }),
        1: entry(1, { key: ['zephyr'], content: CARD_KEYED }),
        2: entry(2, { constant: true, content: CARD_NEVER, useProbability: true, probability: 0 }),
    });
    await book('Extra Card Book', { 0: entry(0, { constant: true, content: EXTRA }), 1: entry(1, { key: ['harbour'], content: EXTRA_KEYED }) });
    await book('Global Book', { 0: entry(0, { constant: true, content: GLOBAL }) });
    await book('Other Book', { 0: entry(0, { constant: true, content: OTHER }) });
    await book('Chat Book', { 0: entry(0, { constant: true, content: CHAT }) });
    await book('Persona Book', { 0: entry(0, { constant: true, content: PERSONA }) });
    if (links) {
        await linkCard(account, account.avatar, main);
        await linkExtraBooks(account, account.avatar, main === 'Card Book' ? ['Extra Card Book'] : []);
    }
    // A roleplay chat bound to its own lorebook, so the Conversation scan has a chat book to leave out.
    const fields = { avatar_url: account.avatar, file_name: 'Lore chat' };
    const opened = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(opened.ok(), await opened.text()).toBe(true);
    const vacancy = JSON.parse(opened.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { world_info: 'Chat Book' } },
        { name: 'Durable Nova', is_user: false, mes: 'Hello.' }], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    const last = await account.context.request.post('/api/characters/last-chat', { headers: account.headers, data: { avatar: account.avatar, chat: 'Lore chat' } });
    expect(last.ok(), await last.text()).toBe(true);
}

const outsideBooks = saved => {
    saved.world_info_settings ??= {};
    saved.world_info_settings.world_info = { ...(saved.world_info_settings.world_info || {}), globalSelect: ['Global Book'] };
    const persona = saved.user_avatar;
    if (persona) {
        saved.power_user.persona_descriptions = { ...(saved.power_user.persona_descriptions || {}) };
        saved.power_user.persona_descriptions[persona] = { description: '', position: 0, ...(saved.power_user.persona_descriptions[persona] || {}), lorebook: 'Persona Book' };
    }
};

/** Sends one message and returns the model request that carried it. */
async function ask(app, page, text, label, account = null) {
    const start = app.provider.calls.length;
    const accepted = await send(page, text);
    const carried = () => app.provider.calls.slice(start).filter(call => JSON.stringify(call.body).includes(text) && JSON.stringify(call.body).includes('Available commands'));
    await expect.poll(() => carried().length, { timeout: 60000 }).toBeGreaterThan(0);
    // Let the reply finish before the next send from the same page.
    if (account) await account.settled(accepted.job.id);
    return keep(carried().at(-1).body, label);
}

function keep(body, label) {
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(`${SHOTS}/${label}.json`, JSON.stringify(body, null, 2));
    }
    return body;
}

const systemOf = body => body.messages.find(message => message.role === 'system').content;
const tag = text => text.split(' ')[0];
const lacks = (text, planted) => { for (const item of planted) expect(text).not.toContain(tag(item)); };
const hasNoPlantedText = text => lacks(text, [KEYED, CONSTANT, NEVER, CARD, CARD_KEYED, CARD_NEVER, EXTRA, EXTRA_KEYED, GLOBAL, OTHER, CHAT, PERSONA, KIT]);
const outside = [KEYED, CONSTANT, NEVER, CARD_NEVER, GLOBAL, OTHER, CHAT, PERSONA, KIT];

/** The Character default request carries both linked books, by their own rules, and nothing else. */
function expectCardBooks(body, { keyed = true, presence = true } = {}) {
    const text = JSON.stringify(body);
    expect(text).toContain(tag(CARD));
    expect(text).toContain(tag(EXTRA));
    if (keyed) {
        expect(text).toContain(tag(CARD_KEYED));
        expect(text).toContain(tag(EXTRA_KEYED));
    }
    lacks(text, outside);
    const system = systemOf(body);
    expect(system).not.toContain('Conversation lorebook focus');
    expect(system).toContain(DEFAULT_BOOKS);
    expect(system.indexOf(DEFAULT_BOOKS)).toBeLessThan(system.indexOf(tag(CARD)));
    // The direct send route carries no availability, so it has no User presence line to sit before.
    if (presence) expect(system.indexOf(tag(EXTRA))).toBeLessThan(system.indexOf('User presence:'));
    else expect(system).not.toContain('User presence:');
    expect(body.messages.filter(message => message.role !== 'system').some(message => String(message.content).includes(tag(CARD)))).toBe(false);
}

async function regenerate(app, account, page) {
    const start = app.provider.calls.length;
    const reply = page.locator('.sb-conversation-message[data-message-id="old-reply"]');
    await reply.locator('.sb-conversation-more-actions').click();
    const accepted = page.waitForResponse(response => response.url().endsWith('/rewrite/submit') && response.status() === 202);
    await page.locator('[data-sb-conversation-action="regenerate-message"][data-message-id="old-reply"]').click();
    const job = (await (await accepted).json()).job;
    await account.settled(job.id);
    const regenerated = app.provider.calls.slice(start).filter(call => JSON.stringify(call.body).includes('Regenerate the selected Conversation reply'));
    expect(regenerated.length).toBeGreaterThan(0);
    return regenerated.at(-1).body;
}

async function directSend(app, account, text) {
    const direct = app.provider.calls.length;
    const current = await account.post(`${CONFIG}/store/get`);
    const sent = await account.post(`${CONFIG}/message/send`, { avatar: account.avatar, personaId: account.personaId, text, version: current.version,
        generation: { backend: 'chat', payload: { chat_completion_source: 'custom', custom_url: app.provider.url, model: MODEL, max_tokens: 64 } } });
    expect(sent).toBeTruthy();
    const calls = app.provider.calls.slice(direct).filter(call => JSON.stringify(call.body).includes(text));
    expect(calls.length).toBeGreaterThan(0);
    return calls.at(-1).body;
}

const seedReplies = (account, text) => account.changeStore(store => store.characters[account.threadKey].branches.main.messages.push(
    { id: 'zephyr-user', role: 'user', name: 'User', mes: text, timestamp: 1700000000001 },
    { id: 'old-reply', role: 'character', name: 'Durable Nova', mes: 'Original reply.', timestamp: 1700000000002 },
));

async function openGroup(app, account, { override = '', kitWorld = '' } = {}) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: { ch_name: 'Group Kit', description: 'Group Kit is a test pal.', first_mes: 'Hello.' } });
    expect(created.ok()).toBe(true);
    const kit = await created.text();
    if (kitWorld) await linkCard(account, kit, kitWorld);
    const current = await account.post(`${CONFIG}/store/get`);
    const { group } = await account.post(`${CONFIG}/group/create`, { version: current.version, personaId: account.personaId, members: [account.avatar, kit], name: 'Lore group',
        settings: { enabled: true, availability: 'online', reply_delay_multiplier: 0 } });
    const latest = await account.post(`${CONFIG}/store/get`);
    await account.post(`${CONFIG}/message/append`, { avatar: account.avatar, groupId: group.id, personaId: account.personaId, version: latest.version, text: 'Hello Lore group.' });
    const only = async speaker => account.changeStore(store => {
        store.groups.find(item => item.id === group.id).disabled_members = [speaker === kit ? account.avatar : kit];
        for (const [key, thread] of Object.entries(store.characters)) {
            if (key.includes(`group:${group.id}:`)) Object.assign(thread.settings, { lorebook_override: override, connection_profile: 'durable', auto_message: false, proactive_messaging: false, enabled: true, availability: 'online', reply_delay_multiplier: 0 });
        }
    });
    await only(account.avatar);
    const open = async (avatar = account.avatar) => {
        const page = await account.context.newPage();
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
        await page.evaluate(async ({ avatar, groupId }) => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, { groupId });
        }, { avatar, groupId: group.id });
        await expect(page.locator('#sb_conversation_input')).toBeVisible();
        return page;
    };
    return { page: await open(), kit, only, open };
}

for (const phone of [true, false]) {
    const device = phone ? 'phone' : 'desktop';

    test(`${device}: the chosen book reaches the model by its own rules and no other book does`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK }, configureSettings: outsideBooks });
        await plant(account);
        const page = await account.open();

        const quiet = await ask(app, page, 'Just saying hello today.', `${device}-override-without-key`);
        const quietText = JSON.stringify(quiet);
        expect(quietText).toContain('CONSTANT-LORE');
        expect(quietText).not.toContain('ZEPHYR-LORE');
        expect(quietText).not.toContain('NEVER-LORE');

        const keyed = await ask(app, page, 'Tell me about the zephyr and the harbour.', `${device}-override-with-key`);
        const text = JSON.stringify(keyed);
        expect(text).toContain('ZEPHYR-LORE');
        expect(text).toContain('CONSTANT-LORE');
        expect(text).not.toContain('NEVER-LORE');
        for (const body of [quiet, keyed]) lacks(JSON.stringify(body), [CARD, CARD_KEYED, EXTRA, EXTRA_KEYED, GLOBAL, OTHER, CHAT, PERSONA]);

        const system = systemOf(keyed);
        expect(system.indexOf(FOCUS)).toBeGreaterThan(-1);
        expect(system.indexOf(`Lorebook entries from ${BOOK}:`)).toBe(system.indexOf(FOCUS) + FOCUS.length + ' Prefer this lore/context over roleplay scene continuity.'.length + 2);
        expect(system.indexOf('CONSTANT-LORE')).toBeLessThan(system.indexOf('User presence:'));
        expect(keyed.messages.filter(message => message.role !== 'system').some(message => String(message.content).includes('ZEPHYR-LORE'))).toBe(false);
    });

    test(`${device}: Character default loads the card's linked lorebooks and no other book`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account);
        const page = await account.open();
        const quiet = await ask(app, page, 'Just saying hello today.', `${device}-default-without-key`);
        expectCardBooks(quiet, { keyed: false });
        lacks(JSON.stringify(quiet), [CARD_KEYED, EXTRA_KEYED]);
        const keyed = await ask(app, page, 'Tell me about the zephyr and the harbour.', `${device}-default-with-key`);
        expectCardBooks(keyed);
        expect(systemOf(keyed).split(DEFAULT_BOOKS)).toHaveLength(2);
    });

    test(`${device}: a card with no linked lorebook sends the request it always did`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account, { links: false });
        const page = await account.open();
        const body = await ask(app, page, 'Tell me about the zephyr and the harbour.', `${device}-no-link`);
        hasNoPlantedText(JSON.stringify(body));
        expect(systemOf(body)).not.toContain('Conversation lorebook focus');
        expect(systemOf(body)).not.toContain('Lorebook entries from');
    });

    test(`${device}: an override naming a missing book loads nothing and the reply still arrives`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: 'Vanished Book' }, configureSettings: outsideBooks });
        await plant(account);
        const page = await account.open();
        const body = await ask(app, page, 'Tell me about the zephyr and the harbour.', `${device}-missing`);
        hasNoPlantedText(JSON.stringify(body));
        expect(systemOf(body)).not.toContain('Conversation lorebook focus');
        expect(systemOf(body)).not.toContain('Lorebook entries from');
        await expect(page.locator('.sb-conversation-message').filter({ hasText: 'Durable first reply.' }).first()).toBeVisible({ timeout: 30000 });
    });

    test(`${device}: a missing card-linked book loads nothing and the reply still arrives`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account, { main: 'Vanished Card Book' });
        const page = await account.open();
        const body = await ask(app, page, 'Tell me about the zephyr and the harbour.', `${device}-missing-card-book`);
        hasNoPlantedText(JSON.stringify(body));
        expect(systemOf(body)).not.toContain('Lorebook entries from');
        await expect(page.locator('.sb-conversation-message').filter({ hasText: 'Durable first reply.' }).first()).toBeVisible({ timeout: 30000 });
    });

    test(`${device}: a group DM loads the chosen book for the replying member`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK } });
        await plant(account);
        const { page } = await openGroup(app, account, { override: BOOK, kitWorld: 'Kit Book' });
        const body = await ask(app, page, 'Tell me about the zephyr.', `${device}-group`);
        const text = JSON.stringify(body);
        expect(text).toContain('ZEPHYR-LORE');
        expect(text).toContain('CONSTANT-LORE');
        lacks(text, [OTHER, CARD, EXTRA, KIT]);
    });

    test(`${device}: on Character default each group DM member loads only its own lorebooks`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account);
        await account.post('/api/worldinfo/edit', { name: 'Kit Book', data: { entries: { 0: entry(0, { constant: true, content: KIT }) } } });
        const { page, kit, only, open } = await openGroup(app, account, { kitWorld: 'Kit Book' });
        const nova = await ask(app, page, 'Nova, tell me about the zephyr and the harbour.', `${device}-group-default-nova`, account);
        expectCardBooks(nova);
        expect(systemOf(nova)).toContain('Durable Nova');
        await only(kit);
        // A fresh page reads the changed member list instead of racing the open one.
        await page.close();
        const kitBody = await ask(app, await open(kit), 'Kit, tell me about the zephyr and the harbour.', `${device}-group-default-kit`);
        const kitText = JSON.stringify(kitBody);
        expect(kitText).toContain(tag(KIT));
        lacks(kitText, [CARD, CARD_KEYED, EXTRA, EXTRA_KEYED, KEYED, CONSTANT, GLOBAL, OTHER, CHAT, PERSONA]);
        expect(systemOf(kitBody)).toContain('Lorebook entries from Kit Book:');
        expect(systemOf(kitBody)).not.toContain('Conversation lorebook focus');
    });

    test(`${device}: Regenerate and the direct send route load the chosen book`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK } });
        await plant(account);
        await seedReplies(account, 'Remind me about the zephyr.');
        await account.changeStore(store => store.characters[account.threadKey].branches.main.messages.push(
            { id: 'later-user', role: 'user', name: 'User', mes: 'Unrelated later message.', timestamp: 1700000000003 }));
        const page = await account.open();
        const regenText = JSON.stringify(keep(await regenerate(app, account, page), `${device}-regenerate`));
        expect(regenText).toContain('ZEPHYR-LORE');
        expect(regenText).toContain('CONSTANT-LORE');
        lacks(regenText, [OTHER, CARD, EXTRA]);

        const directText = JSON.stringify(keep(await directSend(app, account, 'Direct route and the zephyr.'), `${device}-direct-route`));
        expect(directText).toContain('ZEPHYR-LORE');
        expect(directText).toContain('CONSTANT-LORE');
        lacks(directText, [OTHER, CARD, EXTRA]);
    });

    test(`${device}: on Character default Regenerate and the direct send route load the card's books`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account);
        await seedReplies(account, 'Remind me about the zephyr and the harbour.');
        const page = await account.open();
        const regenerated = keep(await regenerate(app, account, page), `${device}-default-regenerate`);
        expectCardBooks(regenerated);
        const direct = keep(await directSend(app, account, 'Direct route, the zephyr and the harbour.'), `${device}-default-direct-route`);
        expectCardBooks(direct, { presence: false });
        expect(JSON.stringify(direct)).toContain('Direct route, the zephyr and the harbour.');
    });

    for (const override of [BOOK, '']) {
        const mode = override ? 'the chosen book' : 'Character default';
        test(`${device}: Regenerate sizes the lorebook budget from the speaker's context window for ${mode}`, async ({ app }) => {
            const account = await app.account({ phone, activeConnection: true, settings: { lorebook_override: override, reply_max_tokens: 300 },
                configureSettings: saved => { saved.oai_settings.openai_max_context = 20000; } });
            await plant(account);
            await seedReplies(account, 'Remind me about the zephyr.');
            const page = await account.open();
            await page.locator('.sb-conversation-message[data-message-id="old-reply"] .sb-conversation-more-actions').click();
            const accepted = page.waitForResponse(response => response.url().endsWith('/rewrite/submit') && response.status() === 202);
            const scan = page.waitForRequest(request => request.url().endsWith('/lorebook/scan'));
            const answer = page.waitForResponse(response => response.url().endsWith('/lorebook/scan'));
            await page.locator('[data-sb-conversation-action="regenerate-message"][data-message-id="old-reply"]').click();
            const sent = (await scan).postDataJSON();
            expect(sent.maxContext).toBe(20000 - 300);
            expect(sent.name).toBe(override);
            expect(sent.avatar).toBe(account.avatar);
            const { lorebook } = await (await answer).json();
            expect(lorebook.text).toContain(override ? 'ZEPHYR-LORE' : 'CARDKEY-LORE');
            await account.settled((await (await accepted).json()).job.id);
        });
    }

    test(`${device}: Regenerate skips the lorebook scan for a card with no linked lorebook`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: outsideBooks });
        await plant(account, { links: false });
        await seedReplies(account, 'Remind me about the zephyr.');
        const page = await account.open();
        const scans = [];
        page.on('request', request => { if (request.url().endsWith('/lorebook/scan')) scans.push(request.url()); });
        const body = await regenerate(app, account, page);
        hasNoPlantedText(JSON.stringify(body));
        expect(scans).toEqual([]);
    });
}
