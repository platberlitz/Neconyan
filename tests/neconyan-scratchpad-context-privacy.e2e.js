/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test('Conversation Scratchpad leaves story macros literal instead of reading the hidden Roleplay chat', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account({ settings: { lorebook_override: 'Scratchpad privacy' } });
    await account.post('/api/worldinfo/edit', { name: 'Scratchpad privacy', data: { entries: {
        0: { uid: 0, comment: 'Library privacy', key: ['library'], content: 'Library notes for {{char}}: {{lastMessage}}', constant: true },
    } } });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(card => card.avatar === avatar), { switchMenu: false });
        context.chat.push({ name: 'Durable Nova', mes: 'PRIVATE-ROLEPLAY-MESSAGE', is_user: false, extra: {} });
        await context.saveChat({ throwOnError: true });
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
    }, account.avatar);
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
    const result = await page.evaluate(async () => {
        const { buildContext, currentSource } = await import('/scripts/scratchpad/context.js');
        const source = currentSource();
        const context = await buildContext({ source, settings: { depth: 15, include: { lore: true, card: true, persona: true } }, pendingText: 'library' });
        return { kind: source.kind, text: context.text, hidden: window.SillyTavern.getContext().chat.at(-1)?.mes };
    });
    expect(result.kind).toBe('conversation');
    expect(result.hidden).toBe('PRIVATE-ROLEPLAY-MESSAGE');
    expect(result.text).toContain('Library notes for Durable Nova: {{lastMessage}}');
    expect(result.text).not.toContain('PRIVATE-ROLEPLAY-MESSAGE');
});
