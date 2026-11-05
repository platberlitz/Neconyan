/* global document, window, MutationObserver, requestAnimationFrame */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
// A cold full-app load can consume two minutes on a shared runner. The
// assertions below still have their normal, short action deadlines.
test.setTimeout(240000);

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} workspace redraws`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone });

        test('Mewmory coalesces notifications, pauses when hidden and refreshes on reopening', async ({ page }) => {
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            const root = page.locator('#mewmory-workspace');
            await expect(root.locator('.mewmory-heading')).toBeVisible();
            await page.evaluate(async () => {
                const { mountMewmory } = await import('/scripts/mewmory/ui.js');
                await mountMewmory(document.querySelector('#mewmory-workspace'));
                await new Promise(requestAnimationFrame);
            });
            const countRenders = () => root.evaluate(async root => {
                let renders = 0;
                const observer = new MutationObserver(records => {
                    renders += records.filter(record => [...record.addedNodes].some(node => node.classList?.contains('mewmory-heading'))).length;
                });
                observer.observe(root, { childList: true });
                for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('mewmory:updated'));
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                observer.disconnect();
                return renders;
            });
            expect(await countRenders()).toBe(1);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await expect(root).toBeHidden();
            expect(await countRenders()).toBe(0);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            await expect(root.locator('.mewmory-heading')).toBeVisible();
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await expect(page.locator('#left-nav-panel')).toBeHidden();
            expect(await countRenders()).toBe(0);
            await root.evaluate(root => { root.dataset.testOldHeading = root.querySelector('.mewmory-heading').textContent; root.querySelector('.mewmory-heading').remove(); });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            await expect(root.locator('.mewmory-heading')).toBeVisible();
            await expect(root.locator('.mewmory-heading')).toHaveText(await root.getAttribute('data-test-old-heading'));
            const bounds = await root.boundingBox();
            expect(bounds.width).toBeGreaterThan(100);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
        });

        test('Conversation retains saved messages and live controls through streamed updates', async ({ page }) => {
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            const miso = page.locator('[data-assistant-personality="miso"]');
            await expect(miso).toBeVisible({ timeout: 60000 });
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            await miso.locator('input[value="miso-male"]').check();
            await miso.locator('[data-assistant-open]').click();
            await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
            if (phone) await page.locator('#sb-hamburger').click();
            await page.locator('#neconyan-workspace-rail [data-neconyan-chat-mode="conversation"]').click();
            await expect(page.locator('#sb_conversation_stage')).toBeVisible();
            await page.locator('#sb_conversation_header').getByRole('button', { name: 'New branch', exact: true }).click();
            await expect(page.locator('.sb-conversation-thread-empty')).toBeVisible();
            const result = await page.evaluate(async () => {
                const { getCurrentCharAvatar } = await import('/scripts/neconyan-conversation/context.js');
                const { appendConversationThreadMessage } = await import('/scripts/neconyan-conversation/thread-store.js');
                const { getSettings, saveSettings } = await import('/scripts/neconyan-conversation/settings-store.js');
                const { getTypingParticipantMap } = await import('/scripts/neconyan-conversation/typing.js');
                const { conversationState } = await import('/scripts/neconyan-conversation/state.js');
                const { renderConversationTimeline } = await import('/scripts/neconyan-conversation/timeline-render.js');
                const avatar = getCurrentCharAvatar();
                const settings = getSettings(avatar);
                saveSettings(avatar, { ...settings, streaming: true });
                appendConversationThreadMessage(avatar, { role: 'user', name: 'You', mes: 'A saved message.' });
                const participants = getTypingParticipantMap(avatar, { create: true });
                const participant = { avatar, name: 'Miso', text: 'Reply 0', token_count: 0 };
                participants.set(avatar, participant);
                conversationState.imageGenerationActive = true;
                renderConversationTimeline();
                const timeline = document.querySelector('#sb_conversation_timeline');
                const saved = timeline.querySelector('[data-message-id]');
                const live = timeline.querySelector('.sb-conversation-typing-indicator');
                const stop = timeline.querySelector('.sb-conversation-stop-image');
                stop.focus();
                for (let i = 1; i <= 50; i++) {
                    participant.text = `Reply ${i}`;
                    participant.token_count = i;
                    renderConversationTimeline();
                }
                const retained = {
                    saved: Boolean(saved && saved === timeline.querySelector('[data-message-id]')),
                    live: live === timeline.querySelector('.sb-conversation-typing-indicator'),
                    stop: stop === timeline.querySelector('.sb-conversation-stop-image') && document.activeElement === stop,
                    text: live.querySelector('.sb-conversation-live-text').textContent,
                };
                participants.delete(avatar);
                conversationState.imageGenerationActive = false;
                saveSettings(avatar, settings);
                renderConversationTimeline();
                return { ...retained, remaining: timeline.querySelectorAll('.sb-conversation-typing-indicator, .sb-conversation-image-pending').length };
            });
            expect(result).toEqual({ saved: true, live: true, stop: true, text: 'Reply 50', remaining: 0 });
            const bounds = await page.locator('#sb_conversation_timeline').boundingBox();
            expect(bounds.width).toBeGreaterThan(100);
            expect(bounds.height).toBeGreaterThan(100);
        });
    });
}
