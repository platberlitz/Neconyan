import { expect } from '@playwright/test';
import { send, test } from './neconyan-conversation-durable-fixture.js';

const api = '/api/neconyan-conversation';
const summary = 'The sapphire kite is numbered 523647.';

async function createSecondMember(account) {
    const name = 'Memory Pal';
    const card = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description: 'A test pal.', first_mes: 'Hello.', mes_example: 'Hello.' } });
    expect(card.ok()).toBe(true);
    const avatar = await card.text();
    const { version } = await account.post(api + '/store/get');
    const { threadKey } = await account.post(api + '/thread/save', { avatar, personaId: account.personaId, version,
        messages: [{ id: 'seed-pal', role: 'user', name: 'User', mes: 'Original question.', timestamp: 1700000000000 }] });
    await account.changeStore(store => {
        Object.assign(store.characters[threadKey].settings, { enabled: true, availability: 'online', reply_delay_multiplier: 0,
            connection_profile: 'durable', auto_message: false, proactive_messaging: false, auto_character_chat: false,
            roleplay_reactions: false, multi_char: false, image_gen_enabled: false });
    });
    return { avatar, threadKey };
}

async function enableRelatedMemory(page, avatar) {
    await page.evaluate(async avatar => {
        await window.SillyTavern.getContext().getCharacters();
        const { openConversationWorkspaceForAvatar } = await import('/scripts/neconyan-conversation/chrome.js');
        await openConversationWorkspaceForAvatar(avatar);
    }, avatar);
    await expect(page.locator('#sb_conversation_input')).toBeVisible();
    await page.locator('#sb_conversation_header [data-sb-conversation-action="open-settings"], .sb-conversation-header-settings').first().click();
    await page.locator('[data-sb-conversation-settings-section="memory"]').click();
    await page.locator('#sb_conv_include_related_memory').check();
    await page.locator('[data-sb-conversation-action="close-settings"]:visible').first().click();
    const saved = await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore());
    expect(saved).toBe(true);
}

test('each opted-in solo member receives the shared group summary once', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account();
    app.provider.mode.reply = { choices: [{ message: { content: 'Plain reply.' } }] };
    const second = await createSecondMember(account);
    const { avatar, personaId } = account;
    const { version } = await account.post(api + '/store/get');
    const { group } = await account.post(api + '/group/create', { version, personaId, members: [avatar, second.avatar],
        name: 'Synthetic group', settings: { enabled: true, availability: 'online', connection_profile: 'durable', auto_character_chat: false } });
    const current = await account.post(api + '/store/get');
    await account.post(api + '/message/append', { version: current.version, avatar, personaId, groupId: group.id, text: 'Group seed question' });
    const groupKeys = store => Object.keys(store.characters).filter(key => key.includes('group:' + group.id + ':'));
    const seeded = await account.store();
    const keys = groupKeys(seeded);
    expect(keys).toHaveLength(1);
    expect(keys[0].endsWith(':' + avatar)).toBe(true);
    await account.post(api + '/summary/submit', { submissionKey: 'synthetic-group-summary', summary,
        target: { avatar, personaId, groupId: group.id, branchId: 'main' }, branchCreatedAt: seeded.characters[keys[0]].branches.main.createdAt });

    const page = await account.open();
    const observations = [];
    for (const member of [{ avatar, threadKey: account.threadKey }, second]) {
        await enableRelatedMemory(page, member.avatar);
        expect((await account.store()).characters[member.threadKey].settings.include_related_memory).toBe(true);
        const memories = await page.evaluate(async ({ avatar, personaId }) => {
            const { getConversationGroupMemorySummaries } = await import('/scripts/neconyan-conversation/settings-store.js');
            return getConversationGroupMemorySummaries(avatar, { personaId });
        }, { avatar: member.avatar, personaId });
        const start = app.provider.calls.length;
        const question = 'Check solo prompt for ' + member.avatar;
        const { job } = await send(page, question);
        await account.settled(job.id);
        const calls = app.provider.calls.slice(start).filter(call => JSON.stringify(call.messages).includes(question));
        observations.push({ avatar: member.avatar, browser: memories.filter(item => item.groupId === group.id && item.summary === summary).length,
            provider: calls.map(call => JSON.stringify(call.messages).split(summary).length - 1) });
    }
    const store = await account.store();
    expect(groupKeys(store)).toEqual(keys);
    expect(store.characters[keys[0]].memorySummary).toBe(summary);
    console.info('Related memory observations', JSON.stringify(observations));
    expect(observations).toEqual([{ avatar, browser: 1, provider: [1] }, { avatar: second.avatar, browser: 1, provider: [1] }]);
});
