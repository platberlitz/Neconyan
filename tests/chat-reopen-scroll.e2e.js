/* global document, window, WheelEvent, PageTransitionEvent, getComputedStyle */
import { expect, test } from '@playwright/test';
import { getChatScrollSnapshot, installSyntheticLongChat, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

test.setTimeout(60_000);
test.use({ serviceWorkers: 'block' });

async function scrollUp(page, selector = '#chat') {
    await page.locator(selector).evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
        element.scrollTop = 100;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await waitForAnimationFrames(page, 2);
    await expect.poll(() => bottomGap(page, selector)).toBeGreaterThan(200);
}

async function bottomGap(page, selector = '#chat') {
    return page.locator(selector).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function setPageVisibility(page, hidden) {
    await page.evaluate(value => {
        Object.defineProperty(document, 'hidden', { configurable: true, value });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'hidden' : 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
}

async function activateMode(page, mode) {
    await page.evaluate(value => window.NeconyanShell.activateMode(value), mode);
    await waitForAnimationFrames(page, 4);
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`chat reopening at ${viewport.width}px`, () => {
        test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
        test.beforeEach(async ({ page }) => {
            await page.route('**/api/settings/save', route => route.fulfill({ json: { version: Date.now() } }));
            await page.route('**/api/conversation/save', route => route.fulfill({ json: {} }));
            await openReadyChat(page);
            await installSyntheticLongChat(page, { messageCount: 96, visibleCount: 24 });
        });

        test('reselecting the already-open character shows the latest message and keeps the draft', async ({ page }) => {
            await page.locator('#send_textarea').fill('Keep this unfinished reply.');
            await scrollUp(page);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.selectCharacterById(core.this_chid, { switchMenu: false });
            });
            await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(16);
            expect((await getChatScrollSnapshot(page)).lastVisibleMesId).toBe('95');
            await expect(page.locator('#send_textarea')).toHaveValue('Keep this unfinished reply.');
        });

        for (const resume of ['visible again', 'restored tab']) {
            test(`${resume} keeps the reader's scroll position`, async ({ page }, info) => {
                await page.evaluate(() => {
                    window.SillyTavern.getContext().powerUserSettings.auto_scroll_chat_to_bottom = false;
                });
                await scrollUp(page);
                const before = await getChatScrollSnapshot(page);
                const beforeTop = await page.locator('#chat').evaluate(element => element.scrollTop);
                await setPageVisibility(page, true);
                await waitForAnimationFrames(page, 3);

                if (resume === 'visible again') {
                    await setPageVisibility(page, false);
                } else {
                    await page.evaluate(() => {
                        delete document.hidden;
                        delete document.visibilityState;
                        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
                    });
                }
                await page.evaluate(() => window.dispatchEvent(new Event('focus')));
                await page.waitForTimeout(1800);
                const restored = await getChatScrollSnapshot(page);
                expect(restored.lastVisibleMesId).toBe(before.lastVisibleMesId);
                expect(Math.abs(await page.locator('#chat').evaluate(element => element.scrollTop) - beforeTop)).toBeLessThanOrEqual(2);
                expect(await bottomGap(page)).toBeGreaterThan(200);
                await info.attach('restored-chat-geometry', { body: JSON.stringify(restored), contentType: 'application/json' });
            });
        }

        test('Home and mode switching reveal the current chat at the bottom', async ({ page }) => {
            await scrollUp(page);
            await page.evaluate(() => window.NeconyanShell.showHome());
            await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
            await activateMode(page, 'roleplay');
            await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(16);

            await scrollUp(page);
            await activateMode(page, 'conversation');
            await expect(page.locator('#sb_conversation_stage')).toBeVisible();
            await activateMode(page, 'roleplay');
            await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(16);
        });

        test('returning to older history keeps an unfinished message edit intact', async ({ page }) => {
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const settings = window.SillyTavern.getContext().powerUserSettings;
                settings.aggressive_dom_unload = true;
                settings.auto_save_msg_edits = false;
                await core.showMoreMessages();
                await core.messageEdit(Number(document.querySelector('#chat .mes').getAttribute('mesid')));
            });
            await page.locator('#curEditTextarea').fill('Keep this unsaved message edit.');
            await setPageVisibility(page, true);
            await setPageVisibility(page, false);
            await waitForAnimationFrames(page, 6);
            await expect(page.locator('#curEditTextarea')).toHaveValue('Keep this unsaved message edit.');
            await expect(page.locator('#chat .mes[mesid="95"]')).toHaveCount(0);
        });

        test('a late image load cannot undo manual scrolling after opening', async ({ page }) => {
            let imageRequested;
            const pendingImage = new Promise(resolve => { imageRequested = resolve; });
            await page.route('**/reopen-scroll-media.svg', route => imageRequested(route));
            await page.evaluate(async () => {
                const core = await import('/script.js');
                core.chat.at(-1).mes += '<img src="/reopen-scroll-media.svg" alt="Delayed test image">';
                await core.printMessages();
            });
            const imageRoute = await pendingImage;
            await page.evaluate(async () => {
                const { scrollOnMediaLoad } = await import('/script.js');
                scrollOnMediaLoad({ force: true });
                const chat = document.getElementById('chat');
                chat.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
                chat.scrollTop = 100;
                chat.dispatchEvent(new Event('scroll', { bubbles: true }));
                chat.querySelector('img[src="/reopen-scroll-media.svg"]').dispatchEvent(new Event('load'));
            });
            await waitForAnimationFrames(page, 2);
            await expect.poll(() => bottomGap(page)).toBeGreaterThan(200);
            await imageRoute.fulfill({
                contentType: 'image/svg+xml',
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>',
            });
            await expect.poll(() => page.locator('#chat img[src="/reopen-scroll-media.svg"]').evaluate(image => image.complete)).toBe(true);
            await waitForAnimationFrames(page, 6);
            await expect.poll(() => bottomGap(page)).toBeGreaterThan(200);
        });

        test('reselecting the already-open group shows the latest message', async ({ page }) => {
            await page.route('**/api/chats/group/get', route => route.fulfill({ json: [] }));
            await page.route('**/api/chats/group/save', route => route.fulfill({ json: {} }));
            await page.route('**/api/groups/edit', route => route.fulfill({ json: {} }));
            await page.evaluate(async () => {
                const { groups, openGroupById } = await import('/scripts/group-chats.js');
                groups.push({ id: 'reopen-test', name: 'Reopen test', members: [], chat_id: 'reopen-test', chats: ['reopen-test'] });
                await openGroupById('reopen-test', { switchMenu: false });
            });
            await installSyntheticLongChat(page, { messageCount: 96, visibleCount: 24 });
            await scrollUp(page);
            await page.evaluate(async () => {
                const { openGroupById } = await import('/scripts/group-chats.js');
                await openGroupById('reopen-test', { switchMenu: false });
            });
            await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(16);
        });

        test('same Conversation reopening shows the bottom, app return keeps the position, and the draft survives', async ({ page }) => {
            await activateMode(page, 'conversation');
            await expect(page.locator('#sb_conversation_stage')).toBeVisible();
            await page.evaluate(async () => {
                const { getConversationThread } = await import('/scripts/neconyan-conversation/thread-store.js');
                const { scheduleTimelineRender } = await import('/scripts/neconyan-conversation/render-scheduler.js');
                const messages = getConversationThread();
                messages.splice(0, messages.length, ...Array.from({ length: 48 }, (_, index) => ({
                    id: `reopen-${index}`, role: index % 2 ? 'character' : 'user', name: 'Scroll test',
                    mes: `Reopen message ${index}. ${'Conversation filler. '.repeat(12)}`, created_at: index + 1, extra: {},
                })));
                scheduleTimelineRender();
            });
            const timeline = '#sb_conversation_timeline';
            await expect(page.locator(`${timeline} .sb-conversation-message[data-message-id]`)).toHaveCount(48);
            await page.locator('#sb_conversation_input').fill('Keep this Conversation draft.');
            await scrollUp(page, timeline);
            await page.evaluate(async () => {
                const { getCurrentCharAvatar } = await import('/scripts/neconyan-conversation/context.js');
                const { openConversationWorkspaceForAvatar } = await import('/scripts/neconyan-conversation/chrome.js');
                openConversationWorkspaceForAvatar(getCurrentCharAvatar(), { showToast: false });
            });
            await expect.poll(() => bottomGap(page, timeline)).toBeLessThanOrEqual(16);
            await scrollUp(page, timeline);
            await page.waitForTimeout(350);
            await expect.poll(() => bottomGap(page, timeline)).toBeGreaterThan(200);

            await setPageVisibility(page, true);
            await setPageVisibility(page, false);
            await page.waitForTimeout(800);
            expect(await bottomGap(page, timeline)).toBeGreaterThan(200);
            await page.evaluate(() => window.NeconyanShell.showHome());
            await activateMode(page, 'conversation');
            await expect.poll(() => bottomGap(page, timeline)).toBeLessThanOrEqual(16);
            await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this Conversation draft.');
        });
    });
}
