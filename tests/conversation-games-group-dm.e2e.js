import { expect } from '@playwright/test';
import { send, test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'default' });
test.setTimeout(240000);

const PANEL = '#neconyan-conversation-games';
const GAMES_BUTTON = '.sb-conversation-quick-actions [data-sb-conversation-action="games"]';

/** The pal move request answers a column; ordinary chat replies talk about the game. */
function fixtureReply(body) {
    const text = JSON.stringify(body.messages || body.prompt || '');
    if (text.includes('playing Connect Four')) return '4';
    return 'Midgame chatter about the board.';
}

function gameAwareCalls(app) {
    return app.provider.calls.filter(call =>
        JSON.stringify(call.messages ?? call.prompt ?? '').includes('being played in this DM right now'));
}

async function openPanel(page) {
    const button = page.locator(GAMES_BUTTON);
    if (!(await button.isVisible())) await page.locator('#sb_conversation_toggle_tools').click();
    await button.click();
    await expect(page.locator(PANEL)).toBeVisible();
    return page.locator(PANEL);
}

/**
 * The panel saves onto the group anchor thread, keyed group:<id>:<avatar>.
 * Every member has a thread under the same group, in no fixed order, so the anchor is matched by its avatar.
 */
async function savedGroupRecord(account, groupId) {
    const store = await account.store();
    const key = Object.keys(store.characters || {}).find(value => value.endsWith(`group:${groupId}:${account.avatar}`));
    if (!key) return null;
    return store.characters[key]?.branches?.main?.games || null;
}

test('a group dm shares one game and every character sees it', async ({ app }, info) => {
    const account = await app.account({ phone: false });
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: fixtureReply(body) } }] });
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Durable Kit', description: 'A second group member.', first_mes: 'Hello.' } });
    expect(created.ok()).toBe(true);
    const partner = await created.text();
    const current = await account.post('/api/neconyan-conversation/store/get');
    const { group } = await account.post('/api/neconyan-conversation/group/create', { version: current.version,
        personaId: account.personaId, members: [account.avatar, partner], name: 'Games group',
        settings: { enabled: true, availability: 'online', reply_delay_multiplier: 0 } });

    const page = await account.open();
    await page.evaluate(async ({ avatar, partner, groupId }) => {
        const context = await import('/scripts/neconyan-conversation/context.js');
        for (const member of [avatar, partner]) {
            Object.assign(context.getConversationThreadStore(member, { groupId, create: true }).settings,
                { enabled: true, availability: 'online', connection_profile: 'durable', reply_delay_multiplier: 0 });
        }
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, { groupId });
        if (!await (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore()) {
            throw new Error('Group setup failed');
        }
    }, { avatar: account.avatar, partner, groupId: group.id });

    // The panel names both group members, and the game starts on the shared branch.
    const panel = await openPanel(page);
    await expect(panel.locator('.neco-games-subtitle')).toContainText('Playing with');
    await expect(panel.locator('.neco-games-subtitle')).toContainText('Durable Kit');
    await panel.locator('.neco-games-card[data-game="connect-four"]').click();
    await expect(panel.locator('.neco-games-setup')).toBeVisible();
    await panel.locator('.neco-games-choice', { hasText: 'Your pal' }).click();
    await panel.locator('.neco-games-start').click();

    // The pal side (both characters) drops first through the fixture model.
    await expect(panel.locator('[data-column="3"] .neco-games-cf-cell[data-row="5"][data-seat="y"]'))
        .toHaveCount(1, { timeout: 60000 });
    try {
        await expect.poll(async () => savedGroupRecord(account, group.id), { timeout: 30000 })
            .toMatchObject({ id: 'connect-four' });
    } finally {
        const remote = await account.store();
        const local = await page.evaluate(async () => {
            const context = await import('/scripts/neconyan-conversation/context.js');
            const avatar = context.getCurrentCharAvatar();
            return { avatar, groupId: context.getConversationGroupIdForAvatar(avatar),
                store: context.getConversationStore() };
        });
        await info.attach('group-game-store', { body: JSON.stringify({ group, remote, local }), contentType: 'application/json' });
    }

    // A normal group message makes the characters reply with the game in their system prompt.
    const sent = await send(page, 'How is the game going, both of you?');
    await account.settled(sent.job.id);
    const replies = gameAwareCalls(app);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    for (const call of replies) {
        const text = JSON.stringify(call.messages ?? call.prompt ?? '');
        expect(text).toContain('a game of Connect Four');
        // Each speaker's pal side names both characters, its own name first.
        expect(text).toMatch(/Durable (Nova|Kit) and Durable (Kit|Nova) against/);
        expect(text).toContain('drops the O discs');
        expect(text).toMatch(/Durable (Nova|Kit) and Durable (Kit|Nova) drop the X discs/);
        // The board prompt belongs to the move request only, never to a chat reply.
        expect(text).not.toContain('Answer with one column number');
    }

    await page.close();
});
