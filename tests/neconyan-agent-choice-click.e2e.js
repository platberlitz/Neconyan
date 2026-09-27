/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    for (const variant of ['CYOA', 'skill-check', 'themed CYOA', 'themed skill-check']) {
        const skillChecks = variant.includes('skill-check');
        const themed = variant.startsWith('themed');
        test(`${phone ? 'phone' : 'desktop'} ${variant} choices insert once without sending`, async ({ app }, info) => {
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false, readyTimeout: 60000 });
            await page.evaluate(async ({ avatar, skillChecks, themed }) => {
                const core = await import('/script.js');
                const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                const regex = await import('/scripts/extensions/in-chat-agents/regex-scripts.js');
                const { eventSource, event_types } = await import('/scripts/events.js');
                let scripts = skillChecks
                    ? (await (await fetch('/scripts/extensions/in-chat-agents/templates/cyoa-choices-skill-checks.json')).json()).regexScripts
                    : (await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json())['tpl-cyoa-choices'];
                if (themed) {
                    const { buildAgentScripts } = await import('/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/build.js');
                    const { THEMES } = await import('/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/themes/index.js');
                    scripts = buildAgentScripts(skillChecks ? 'tpl-cyoa-choices-skill-checks' : 'tpl-cyoa-choices', scripts, THEMES[0]).scripts;
                }
                await window.SillyTavern.getContext().getCharacters();
                await core.selectCharacterById(window.SillyTavern.getContext().characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
                await window.NeconyanShell.activateMode('roleplay');
                const context = window.SillyTavern.getContext();
                const message = context.chat[0];
                const content = '[CHOICES]\n1. Open the door.\n2. Wait here.\n[/CHOICES]';
                message.mes = content;
                message.extra = { ...message.extra, inChatAgents: { regexScripts: scripts } };
                core.syncMesToSwipe(message);
                const html = regex.applyRegexScriptList(content, scripts, regex.AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
                runner.setCompanionResult(message, { id: 'choice-history', name: 'Saved choices', execution: 'companion', companion: { format: 'html', displayMode: 'card' } },
                    { content: html, format: 'html', displayMode: 'card', status: 'done' });
                await context.printMessages();
                // The host emits this after printMessages when opening a saved chat.
                await eventSource.emit(event_types.CHAT_CHANGED, core.getCurrentChatId());
            }, { avatar: account.avatar, skillChecks, themed });

            const choices = page.locator('#chat .mes_text .ica--choice-line');
            const noteChoices = page.locator('#chat .ica--companion-body .ica--choice-line');
            await expect(page.locator('#chat .mes_text .custom-pura-choice')).toHaveCount(2);
            await expect(choices).toHaveCount(2);
            await expect(noteChoices).toHaveCount(2);
            expect((await choices.first().boundingBox()).height).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: info.outputPath('choices.png') });
            const input = page.locator('#send_textarea');
            await input.fill('My existing draft');
            await page.evaluate(() => {
                window.choiceInputs = { native: 0, jquery: 0 };
                const input = document.getElementById('send_textarea');
                input.addEventListener('input', () => window.choiceInputs.native++);
                window.$(input).on('input.choiceRegression', () => window.choiceInputs.jquery++);
            });
            if (phone) await choices.first().tap();
            else await choices.first().click();
            await expect(input).toHaveValue('My existing draft\nOpen the door.');
            expect(await page.evaluate(() => window.choiceInputs)).toEqual({ native: 1, jquery: 1 });
            await expect(input).toBeFocused();

            await input.fill('');
            await noteChoices.last().focus();
            await page.keyboard.press('Enter');
            await expect(input).toHaveValue('Wait here.');
            await expect(input).toBeFocused();
            await page.evaluate(async () => {
                const { eventSource, event_types } = await import('/scripts/events.js');
                await window.SillyTavern.getContext().printMessages();
                await eventSource.emit(event_types.MESSAGE_UPDATED, 0);
            });
            await expect(choices).toHaveCount(2);
            await expect(noteChoices).toHaveCount(2);
            await expect(page.locator('#chat .mes')).toHaveCount(1);
            expect(app.provider.calls).toHaveLength(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
        });
    }
}
