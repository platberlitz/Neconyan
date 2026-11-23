/* global window, document */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
// Conversation 'Lorebook Override': the chosen book's entries reach the model request on every reply path.
import fs from 'node:fs';
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
const GLOBAL = 'GLOBAL-LORE selected globally.';
const OTHER = 'OTHER-LORE sits in a book nobody chose.';
const SHOTS = process.env.NECONYAN_LOREBOOK_CAPTURE || '';

const entry = (uid, extra) => ({ uid, key: [], keysecondary: [], comment: 'c' + uid, content: '', constant: false, selective: false, order: 100, position: 0, disable: false, ...extra });

async function plant(account) {
    const book = (name, entries) => account.post('/api/worldinfo/edit', { name, data: { entries } });
    await book(BOOK, {
        0: entry(0, { key: ['zephyr'], content: KEYED }),
        1: entry(1, { constant: true, content: CONSTANT }),
        2: entry(2, { key: ['zephyr'], content: NEVER, useProbability: true, probability: 0 }),
    });
    await book('Card Book', { 0: entry(0, { constant: true, content: CARD }), 1: entry(1, { key: ['zephyr'], content: CARD + ' keyed' }) });
    await book('Global Book', { 0: entry(0, { constant: true, content: GLOBAL }) });
    await book('Other Book', { 0: entry(0, { constant: true, content: OTHER }) });
    const merged = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar: account.avatar, data: { extensions: { world: 'Card Book' } } } });
    expect(merged.ok(), await merged.text()).toBe(true);
}

const globalBook = saved => { saved.world_info = { ...(saved.world_info || {}), globalSelect: ['Global Book'] }; };

/** Sends one message and returns the model request that carried it. */
async function ask(app, page, text, label) {
    const start = app.provider.calls.length;
    await send(page, text);
    const carried = () => app.provider.calls.slice(start).filter(call => JSON.stringify(call.body).includes(text) && JSON.stringify(call.body).includes('Available commands'));
    await expect.poll(() => carried().length, { timeout: 60000 }).toBeGreaterThan(0);
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
const hasNoPlantedText = text => { for (const planted of [KEYED, CONSTANT, NEVER, CARD, GLOBAL, OTHER]) expect(text).not.toContain(planted.split(' ')[0]); };

for (const phone of [true, false]) {
    const device = phone ? 'phone' : 'desktop';

    test(`${device}: the chosen book reaches the model by its own rules and no other book does`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK }, configureSettings: globalBook });
        await plant(account);
        const page = await account.open();

        const quiet = await ask(app, page, 'Just saying hello today.', `${device}-override-without-key`);
        const quietText = JSON.stringify(quiet);
        expect(quietText).toContain('CONSTANT-LORE');
        expect(quietText).not.toContain('ZEPHYR-LORE');
        expect(quietText).not.toContain('NEVER-LORE');

        const keyed = await ask(app, page, 'Tell me about the zephyr.', `${device}-override-with-key`);
        const text = JSON.stringify(keyed);
        expect(text).toContain('ZEPHYR-LORE');
        expect(text).toContain('CONSTANT-LORE');
        expect(text).not.toContain('NEVER-LORE');
        for (const body of [quiet, keyed]) {
            const bodyText = JSON.stringify(body);
            expect(bodyText).not.toContain('CARD-LORE');
            expect(bodyText).not.toContain('GLOBAL-LORE');
            expect(bodyText).not.toContain('OTHER-LORE');
        }

        const system = systemOf(keyed);
        expect(system.indexOf(FOCUS)).toBeGreaterThan(-1);
        expect(system.indexOf(`Lorebook entries from ${BOOK}:`)).toBe(system.indexOf(FOCUS) + FOCUS.length + ' Prefer this lore/context over roleplay scene continuity.'.length + 2);
        expect(system.indexOf('CONSTANT-LORE')).toBeLessThan(system.indexOf('User presence:'));
        expect(keyed.messages.filter(message => message.role !== 'system').some(message => String(message.content).includes('ZEPHYR-LORE'))).toBe(false);
    });

    test(`${device}: no override leaves the request without lorebook text or the focus sentence`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: globalBook });
        await plant(account);
        const page = await account.open();
        const body = await ask(app, page, 'Tell me about the zephyr.', `${device}-unset`);
        hasNoPlantedText(JSON.stringify(body));
        expect(systemOf(body)).not.toContain('Conversation lorebook focus');
        expect(systemOf(body)).not.toContain('Lorebook entries from');
    });

    test(`${device}: an override naming a missing book loads nothing and the reply still arrives`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: 'Vanished Book' }, configureSettings: globalBook });
        await plant(account);
        const page = await account.open();
        const body = await ask(app, page, 'Tell me about the zephyr.', `${device}-missing`);
        hasNoPlantedText(JSON.stringify(body));
        expect(systemOf(body)).not.toContain('Conversation lorebook focus');
        await expect(page.locator('.sb-conversation-message').filter({ hasText: 'Durable first reply.' }).first()).toBeVisible({ timeout: 30000 });
    });

    test(`${device}: a group DM loads the chosen book for the replying member`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK } });
        await plant(account);
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: { ch_name: 'Group Kit', description: 'Group Kit is a test pal.', first_mes: 'Hello.' } });
        expect(created.ok()).toBe(true);
        const kit = await created.text();
        const current = await account.post(`${CONFIG}/store/get`);
        const { group } = await account.post(`${CONFIG}/group/create`, { version: current.version, personaId: account.personaId, members: [account.avatar, kit], name: 'Lore group',
            settings: { enabled: true, availability: 'online', reply_delay_multiplier: 0 } });
        const latest = await account.post(`${CONFIG}/store/get`);
        await account.post(`${CONFIG}/message/append`, { avatar: account.avatar, groupId: group.id, personaId: account.personaId, version: latest.version, text: 'Hello Lore group.' });
        await account.changeStore(store => {
            store.groups.find(item => item.id === group.id).disabled_members = [kit];
            for (const [key, thread] of Object.entries(store.characters)) {
                if (key.includes(`group:${group.id}:`)) Object.assign(thread.settings, { lorebook_override: BOOK, connection_profile: 'durable', auto_message: false, proactive_messaging: false, enabled: true, availability: 'online', reply_delay_multiplier: 0 });
            }
        });
        const page = await account.context.newPage();
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
        await page.evaluate(async ({ avatar, groupId }) => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, { groupId });
        }, { avatar: account.avatar, groupId: group.id });
        await expect(page.locator('#sb_conversation_input')).toBeVisible();
        const body = await ask(app, page, 'Tell me about the zephyr.', `${device}-group`);
        const text = JSON.stringify(body);
        expect(text).toContain('ZEPHYR-LORE');
        expect(text).toContain('CONSTANT-LORE');
        expect(text).not.toContain('OTHER-LORE');
        expect(text).not.toContain('CARD-LORE');
    });

    test(`${device}: Regenerate and the direct send route load the chosen book`, async ({ app }) => {
        const account = await app.account({ phone, settings: { lorebook_override: BOOK } });
        await plant(account);
        await account.changeStore(store => store.characters[account.threadKey].branches.main.messages.push(
            { id: 'zephyr-user', role: 'user', name: 'User', mes: 'Remind me about the zephyr.', timestamp: 1700000000001 },
            { id: 'old-reply', role: 'character', name: 'Durable Nova', mes: 'Original reply.', timestamp: 1700000000002 },
            { id: 'later-user', role: 'user', name: 'User', mes: 'Unrelated later message.', timestamp: 1700000000003 },
        ));
        const page = await account.open();
        const start = app.provider.calls.length;
        const reply = page.locator('.sb-conversation-message[data-message-id="old-reply"]');
        await reply.locator('.sb-conversation-more-actions').click();
        const accepted = page.waitForResponse(response => response.url().endsWith('/rewrite/submit') && response.status() === 202);
        await page.locator('[data-sb-conversation-action="regenerate-message"][data-message-id="old-reply"]').click();
        const job = (await (await accepted).json()).job;
        await account.settled(job.id);
        const regenerated = app.provider.calls.slice(start).filter(call => JSON.stringify(call.body).includes('Regenerate the selected Conversation reply'));
        expect(regenerated.length).toBeGreaterThan(0);
        const regenText = JSON.stringify(keep(regenerated.at(-1).body, `${device}-regenerate`));
        expect(regenText).toContain('ZEPHYR-LORE');
        expect(regenText).toContain('CONSTANT-LORE');
        expect(regenText).not.toContain('OTHER-LORE');
        expect(regenText).not.toContain('CARD-LORE');

        const direct = app.provider.calls.length;
        const current = await account.post(`${CONFIG}/store/get`);
        const sent = await account.post(`${CONFIG}/message/send`, { avatar: account.avatar, personaId: account.personaId, text: 'Direct route and the zephyr.', version: current.version,
            generation: { backend: 'chat', payload: { chat_completion_source: 'custom', custom_url: app.provider.url, model: MODEL, max_tokens: 64 } } });
        expect(sent).toBeTruthy();
        const directCalls = app.provider.calls.slice(direct).filter(call => JSON.stringify(call.body).includes('Direct route and the zephyr.'));
        expect(directCalls.length).toBeGreaterThan(0);
        const directText = JSON.stringify(keep(directCalls.at(-1).body, `${device}-direct-route`));
        expect(directText).toContain('ZEPHYR-LORE');
        expect(directText).toContain('CONSTANT-LORE');
        expect(directText).not.toContain('OTHER-LORE');
        expect(directText).not.toContain('CARD-LORE');
    });

    test(`${device}: Regenerate sizes the lorebook budget from the speaker's context window`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, settings: { lorebook_override: BOOK, reply_max_tokens: 300 },
            configureSettings: saved => { saved.oai_settings.openai_max_context = 20000; } });
        await plant(account);
        await account.changeStore(store => store.characters[account.threadKey].branches.main.messages.push(
            { id: 'zephyr-user', role: 'user', name: 'User', mes: 'Remind me about the zephyr.', timestamp: 1700000000001 },
            { id: 'old-reply', role: 'character', name: 'Durable Nova', mes: 'Original reply.', timestamp: 1700000000002 },
        ));
        const page = await account.open();
        await page.locator('.sb-conversation-message[data-message-id="old-reply"] .sb-conversation-more-actions').click();
        const accepted = page.waitForResponse(response => response.url().endsWith('/rewrite/submit') && response.status() === 202);
        const scan = page.waitForRequest(request => request.url().endsWith('/lorebook/scan'));
        await page.locator('[data-sb-conversation-action="regenerate-message"][data-message-id="old-reply"]').click();
        expect((await scan).postDataJSON().maxContext).toBe(20000 - 300);
        await account.settled((await (await accepted).json()).job.id);
    });
}
