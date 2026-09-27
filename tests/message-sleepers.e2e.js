/* global document, window, getComputedStyle */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const styles = ['flatchat', 'bubblechat', 'documentstyle', 'echostyle', 'whisperstyle', 'hushstyle', 'ripplestyle', 'tidestyle'];
const hopper = '/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js';
test.use({ serviceWorkers: 'block' });
test.setTimeout(120000);

async function checkAnimals(page, selector) {
    const animals = page.locator(selector);
    expect(await animals.count()).toBeGreaterThanOrEqual(2);
    for (const animal of await animals.all()) {
        await expect(animal).toHaveAttribute('alt', '');
        await expect(animal).toHaveAttribute('role', 'button');
        await expect(animal).toHaveAttribute('aria-label', 'Pet sleeping cat');
        await expect(animal).toHaveAttribute('tabindex', '0');
        await expect(animal).toHaveCSS('pointer-events', 'auto');
        const state = await animal.evaluate(async img => {
            await img.decode();
            const box = img.getBoundingClientRect();
            const tiger = img.src.includes('tiger-right');
            return { width: box.width, height: box.height, left: box.left, right: box.right,
                correctSide: img.classList.contains('is-user') === tiger,
                naturalWidth: img.naturalWidth, radius: getComputedStyle(img).borderRadius };
        });
        expect(state.width).toBeCloseTo(96, 2);
        expect(state.height).toBeCloseTo(77, 2);
        expect(state.naturalWidth).toBe(384);
        expect(state.correctSide).toBe(true);
        expect(state.radius).toBe('0px');
        expect(state.left).toBeGreaterThanOrEqual(0);
        expect(state.right).toBeLessThanOrEqual(page.viewportSize().width);
    }
}

async function checkPet(page, animal, touch) {
    const original = await animal.getAttribute('src');
    // The twitch frame lasts 240ms, so record src changes instead of racing them.
    await animal.evaluate(img => {
        img.__petLog = [];
        new window.MutationObserver(() => img.__petLog.push(img.getAttribute('src'))).observe(img, { attributes: true, attributeFilter: ['src'] });
    });
    const twitched = () => animal.evaluate(img => img.__petLog.splice(0).some(src => /-twitch\.webp$/.test(src)));
    if (touch) await animal.tap({ position: { x: 48, y: 25 } });
    else await animal.click({ position: { x: 48, y: 25 } });
    await expect.poll(twitched).toBe(true);
    await expect(animal).toHaveAttribute('src', original);
    await animal.focus();
    for (const key of ['Enter', 'Space']) {
        await animal.press(key);
        await expect.poll(twitched).toBe(true);
        await expect(animal).toHaveAttribute('src', original);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await animal.press('Enter');
    await page.waitForTimeout(300);
    expect(await twitched()).toBe(false);
    await expect(animal).toHaveAttribute('src', original);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
}

for (const width of [393, 1280]) {
    test.describe(`sleeping animals at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393 });
        test('survive all styles, edits, history, Story and terminal', async ({ page }, info) => {
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await openQuietChatForSmoke(page);
            await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                context.chat.splice(0);
                document.querySelector('#chat').replaceChildren();
                for (const is_user of [false, true]) context.chat.push({ name: is_user ? 'You' : 'Miso', is_user,
                    is_system: false, send_date: Date.now(), mes: 'A quiet moment together.\n\nA longer message to check the tail beside the border.', extra: {} });
                await context.printMessages();
            });
            for (const style of styles) {
                await page.evaluate(({ style, styles }) => {
                    document.body.classList.remove(...styles);
                    document.body.classList.add(style);
                }, { style, styles });
                await page.waitForTimeout(800);
                await page.evaluate(() => { document.querySelector('#chat').scrollTop = 0; window.toastr.remove(); });
                await expect(page.locator('#chat > .mes > .neconyan-message-sleeper')).toHaveCount(2);
                await checkAnimals(page, '#chat > .mes > .neconyan-message-sleeper');
                const geometry = await page.locator('#chat > .mes').evaluateAll(rows => rows.map(row => {
                    const img = row.querySelector('.neconyan-message-sleeper').getBoundingClientRect();
                    const chat = row.parentElement;
                    return { clearance: Number.parseFloat(getComputedStyle(row).marginTop), bottomMargin: getComputedStyle(row).marginBottom,
                        gap: row.nextElementSibling ? row.nextElementSibling.getBoundingClientRect().top - row.getBoundingClientRect().bottom : null,
                        width: row.getBoundingClientRect().width, contain: getComputedStyle(row).contain,
                        top: img.top, viewportTop: chat.getBoundingClientRect().top, overflow: chat.scrollWidth - chat.clientWidth };
                }));
                expect(geometry[0].top, style).toBeGreaterThanOrEqual(geometry[0].viewportTop);
                for (const row of geometry) {
                    expect(row.contain, style).not.toContain('paint');
                    expect(row.clearance, style).toBe(44);
                    expect(row.bottomMargin, style).toBe('0px');
                    expect(row.overflow, style).toBeLessThanOrEqual(1);
                }
                if (style === 'bubblechat') {
                    expect(geometry[0].gap).toBeCloseTo(44, 1);
                    if (width === 393) expect(geometry[0].width).toBeCloseTo(357, 1);
                    for (const animal of await page.locator('#chat > .mes > .neconyan-message-sleeper').all()) {
                        await checkPet(page, animal, width === 393);
                    }
                }
                await page.screenshot({ path: info.outputPath(`${style}.png`) });
            }
            await page.evaluate(async () => {
                const { updateMessageElement } = await import('/script.js');
                const context = window.SillyTavern.getContext();
                context.chat[0].is_system = true; // Prompt-excluded authored messages still get their cat.
                context.chat[0].mes = 'Edited message';
                updateMessageElement(context.chat[0], { messageId: 0, messageElement: window.$('#chat > .mes').first() });
                await context.printMessages();
            });
            await expect(page.locator('#chat > .mes[is_user="false"] > img.neconyan-message-sleeper')).toHaveAttribute('src', /calico-left/);
            await expect(page.locator('#chat > .mes[is_user="true"] > img.neconyan-message-sleeper')).toHaveAttribute('src', /tiger-right/);
            for (const mode of ['Story-Mode', 'Terminal-UI']) {
                await page.addStyleTag({ content: readFileSync(new URL(`../public/scripts/extensions/third-party/Neconyan-${mode}/style.css`, import.meta.url), 'utf8') });
                await page.evaluate(mode => {
                    document.body.classList.remove('tidestyle', 'sbstory', 'sbterm');
                    document.body.classList.add('flatchat', mode === 'Story-Mode' ? 'sbstory' : 'sbterm');
                    document.querySelector('#chat').scrollTop = 0;
                }, mode);
                await checkAnimals(page, '#chat > .mes > .neconyan-message-sleeper');
                await expect(page.locator('#chat > .mes').first()).toHaveCSS('margin-top', '44px');
                await page.screenshot({ path: info.outputPath(`${mode}.png`) });
            }
            await page.evaluate(() => document.body.classList.remove('sbterm'));
            await page.locator('#chat > .mes .mes_screenshot').first().dispatchEvent('click');
            await page.locator('#message_screenshot_start_id').fill('0');
            await page.locator('#message_screenshot_end_id').fill('1');
            const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
            await page.locator('.popup-button-ok').last().dispatchEvent('click');
            const download = await downloadPromise;
            await download.saveAs(info.outputPath('exported-messages.png'));
            expect(readFileSync(info.outputPath('exported-messages.png')).subarray(1, 4).toString()).toBe('PNG');
        });

        test('Conversation and nested Meower authors use their own animals', async ({ page }, info) => {
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            // Exercise the real private renderers without creating a saved social timeline.
            await page.route(`**${hopper}`, async route => {
                const response = await route.fetch();
                await route.fulfill({ response, body: `${await response.text()}\nexport { postNode, replyNode, repostedReplyNode };` });
            });
            await openQuietChatForSmoke(page);
            if (width < 769) await page.locator('#sb-hamburger').click();
            await page.locator('#neconyan-workspace-rail [data-neconyan-chat-mode="conversation"]').click();
            await page.evaluate(async () => {
                const { getCurrentCharAvatar } = await import('/scripts/neconyan-conversation/context.js');
                const { appendConversationThreadMessage } = await import('/scripts/neconyan-conversation/thread-store.js');
                const { scheduleInterfaceRefresh } = await import('/scripts/neconyan-conversation/render-scheduler.js');
                for (const role of ['user', 'character']) appendConversationThreadMessage(getCurrentCharAvatar(), { role, name: role, mes: 'A quiet moment together.' });
                scheduleInterfaceRefresh({ syncControls: false });
            });
            const conversation = '#sb_conversation_stage .sb-conversation-message-bubble > .neconyan-message-sleeper';
            await expect(page.locator(conversation).last()).toBeVisible();
            await checkAnimals(page, conversation);
            await checkPet(page, page.locator(conversation).last(), width === 393);
            await page.locator('.sb-conversation-more-actions').last().click();
            await checkAnimals(page, conversation);
            await page.screenshot({ path: info.outputPath('conversation.png') });
            await page.evaluate(async hopper => {
                window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
                const { postNode, replyNode, repostedReplyNode } = await import(hopper);
                const persona = { kind: 'persona', name: 'You', handle: 'you' };
                const character = { kind: 'character', name: 'Miso', handle: 'miso' };
                const post = { id: 'sleep-post', authorKey: 'sleep-cat', authorSnapshot: character, createdAt: Date.now(), body: 'A sleepy original post.' };
                const reply = { id: 'sleep-reply', postId: post.id, actorKey: 'sleep-you', actorSnapshot: persona, createdAt: Date.now(), type: 'reply', content: 'A sleepy reply.' };
                const repost = { ...reply, id: 'sleep-quote', type: 'repost', content: 'A sleepy quotation.' };
                const shell = document.createElement('div');
                shell.className = 'sbtw-shell';
                const list = document.createElement('div');
                list.className = 'sbtw-list';
                list.append(postNode(post), replyNode(reply), postNode(post, repost), repostedReplyNode({ post, reply, repost }));
                shell.append(list);
                document.querySelector('#sheld').dataset.sbtwMode = 'on';
                document.querySelector('#sheld').append(shell);
                window.toastr.remove();
            }, hopper);
            const meower = '.sbtw-shell .neconyan-message-sleeper';
            await expect(page.locator(meower)).toHaveCount(7);
            await checkAnimals(page, meower);
            await checkPet(page, page.locator(meower).first(), width === 393);
            await expect(page.locator('.sbtw-quote > .neconyan-message-sleeper')).toHaveAttribute('src', /tiger-right/);
            await expect(page.locator('.sbtw-quote .sbtw-post-compact > .neconyan-message-sleeper')).toHaveAttribute('src', /calico-left/);
            await page.screenshot({ path: info.outputPath('meower.png') });
        });
    });
}
