/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const mode of ['safari', 'standalone', 'desktop']) {
    test(`Companion note actions stay in one row in ${mode}`, async ({ app }, info) => {
        test.setTimeout(180000);
        const phone = mode !== 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: mode === 'standalone' });
        await account.post('/api/in-chat-agents/save', {
            id: 'row-companion', name: 'Parallel Off-Screen (Extended)', enabled: true,
            execution: 'companion', category: 'companion', prompt: 'Keep a separate scene note.',
            companion: { displayMode: 'card', trigger: 'manual' },
        });
        const page = await account.open({ workspace: false });
        await expect(page.getByRole('button', { name: 'Open the Companion panel', exact: true })).toBeVisible({ timeout: 30000 });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            const { getAgentById } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            // The first-load migration defaults existing notes to the separate panel.
            getAgentById('row-companion').companion.displayMode = 'card';
            core.chat.splice(0, core.chat.length, {
                name: 'Durable Nova', is_user: false, is_system: false, mes: 'The scene continues.',
                send_date: new Date().toISOString(), extra: { inChatAgentCompanionResults: {
                    'row-companion': { agentName: 'Parallel Off-Screen (Extended)', status: 'done',
                        model: 'fixture/companion', content: 'Off-Screen: Multiple locations, regularities.' },
                } },
            });
            await core.printMessages();
            await window.SillyTavern.getContext().eventSource.emit('in_chat_agent_companion_results_updated', { messageIndex: 0 });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page, { inPlace: true });
        expect(await page.locator('body').evaluate(body => body.classList.contains('PWA'))).toBe(mode === 'standalone');
        const card = page.locator('#chat .ica--companion-card');
        await expect(card).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.toastr?.remove());
        for (const width of phone ? [393, 387, 375, 320] : [1280]) {
            await page.setViewportSize({ width, height: phone ? 852 : 900 });
            await page.screenshot({ path: `../screenshots/companion-actions-${mode}-${width}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            const geometry = await card.evaluate((element, phone) => ({
                card: element.getBoundingClientRect().toJSON(),
                buttons: [...element.querySelectorAll('.ica--companion-action')].map(button => {
                    const rect = button.getBoundingClientRect();
                    const inset = phone ? parseFloat(getComputedStyle(button, '::before').left) : 0;
                    return {
                        ...rect.toJSON(),
                        targetSize: rect.width - 2 * inset,
                        reachable: [rect.left + inset + 1, rect.right - inset - 1].every(x =>
                            document.elementFromPoint(x, rect.top + rect.height / 2)?.closest('.ica--companion-action') === button),
                    };
                }),
            }), phone);
            await info.attach(`action-geometry-${width}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
            expect(geometry.buttons).toHaveLength(5);
            expect.soft(new Set(geometry.buttons.map(button => button.top)).size, `${mode} at ${width}px`).toBe(width < 375 ? 2 : 1);
            for (const button of geometry.buttons) {
                expect(button.left).toBeGreaterThanOrEqual(geometry.card.left + 4);
                expect(button.right).toBeLessThanOrEqual(geometry.card.right - 4);
                expect(button.targetSize).toBe(phone ? 44 : 30);
                expect(button.reachable).toBe(true);
            }
        }
    });
}
