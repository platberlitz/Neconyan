/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [true, false]) {
    test(`Chatroom reply keeps its hint without a duplicate label on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        await account.post('/api/in-chat-agents/save', {
            id: 'chatroom-reply', name: 'Chatroom', sourceTemplateId: 'tpl-chatroom-companion', enabled: true,
            execution: 'companion', category: 'companion', prompt: 'React to the scene.',
            companion: { displayMode: 'card', trigger: 'manual' },
        });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).not.toHaveClass(/neconyan-home-booting/);
        await expect(page.getByRole('button', { name: 'Open the Companion panel', exact: true })).toBeVisible({ timeout: 30000 });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            const { getAgentById } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
            getAgentById('chatroom-reply').companion.displayMode = 'card';
            core.chat.splice(0, core.chat.length, {
                name: 'Durable Nova', is_user: false, is_system: false, mes: 'The room falls quiet as the door opens.',
                send_date: new Date().toISOString(), extra: { inChatAgentCompanionResults: {
                    'chatroom-reply': { agentName: 'Chatroom', status: 'done', content: 'NightWatch: Did anyone hear the latch?' },
                } },
            });
            await core.printMessages();
            await window.SillyTavern.getContext().eventSource.emit('in_chat_agent_companion_results_updated', { messageIndex: 0 });
        }, account.avatar);
        for (const surface of ['card', 'panel']) {
            if (surface === 'panel') {
                await page.evaluate(async () => {
                    const { getAgentById } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    getAgentById('chatroom-reply').companion.displayMode = 'panel';
                    (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
                });
            }
            if (phone) await applyIOSOnlyCss(page, { inPlace: true });
            const composer = page.locator(surface === 'card' ? '#chat .ica--companion-chatroom-reply' : '#ica--tracker-panel .ica--tpanel-chatroom-reply');
            await expect(composer).toBeVisible();
            await composer.scrollIntoViewIfNeeded();
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: `../screenshots/chatroom-reply-${surface}-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            const input = composer.getByRole('textbox', { name: 'Respond to the chatroom', exact: true });
            await expect(input).toHaveAttribute('placeholder', 'Respond to the chatroom...');
            await expect.soft(composer.locator('label')).toHaveText('');
            await expect.soft(composer.locator('.ica--chatonly-live')).toHaveCount(0);
            await expect(composer.getByRole('button', { name: 'Send reply', exact: true })).toBeVisible();
            const geometry = await input.evaluate(element => ({
                input: element.getBoundingClientRect().toJSON(),
                label: element.parentElement.getBoundingClientRect().toJSON(),
            }));
            await info.attach(`${surface}-geometry`, { body: JSON.stringify(geometry), contentType: 'application/json' });
            expect.soft(geometry.input.width).toBeGreaterThanOrEqual(geometry.label.width - 1);
            await input.fill('Check the south roof!');
            await expect(input).toHaveValue('Check the south roof!');
        }
    });
}
