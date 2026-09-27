/* global document, window */
import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, openReadyChat } from './chat-scroll-regression-helpers.js';
import { requestJson } from './roleplay-browser-fixture.js';

async function submitChatInput(page) {
    const simpleSendButton = page.locator('#gg_simple_send_button');
    if (await simpleSendButton.isVisible().catch(() => false)) {
        await simpleSendButton.click();
        return;
    }

    await page.locator('#send_textarea').press('Enter');
}

test.describe('chat send scroll', () => {
    test('scrolls to the latest user message immediately after send', async ({ page }, info) => {
        await openReadyChat(page, { chatSaveDelayMs: 1200 });

        await installSyntheticLongChat(page, { messageCount: 12 });

        const messageText = `scroll regression ${Date.now()}`;
        await page.locator('#send_textarea').fill(messageText);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/chats/save')
            && response.status() === 200
            && requestJson(response.request()).chat?.some(message => message.mes === messageText));
        await submitChatInput(page);

        const scrolledToSentMessage = await page.waitForFunction((expectedText) => {
            const chatElement = document.querySelector('#chat');
            const sentMessage = Array.from(chatElement.querySelectorAll('.mes[is_user="true"]'))
                .find(message => message.textContent.includes(expectedText));

            if (!sentMessage) {
                return false;
            }

            const chatRect = chatElement.getBoundingClientRect();
            const messageRect = sentMessage.getBoundingClientRect();
            const bottomDelta = chatElement.scrollHeight - chatElement.clientHeight - chatElement.scrollTop;

            return messageRect.bottom <= chatRect.bottom + 4 && bottomDelta <= 12;
        }, messageText, { timeout: 1000 }).catch(async error => {
            await info.attach('send-scroll-measurements', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(expectedText => {
                const chat = document.querySelector('#chat');
                const message = Array.from(chat.querySelectorAll('.mes[is_user="true"]')).find(row => row.textContent.includes(expectedText));
                return { chat: chat.getBoundingClientRect().toJSON(), message: message?.getBoundingClientRect().toJSON(), bottomDelta: chat.scrollHeight - chat.clientHeight - chat.scrollTop };
            }, messageText)) });
            throw error;
        });

        expect(await scrolledToSentMessage.jsonValue()).toBe(true);
        await saved;
        // The delayed save and resize callbacks must not restore the pre-send reading position.
        const stayedAtBottom = await page.evaluate(async () => {
            const chat = document.querySelector('#chat');
            for (let frame = 0; frame < 8; frame++) {
                await new Promise(resolve => window.requestAnimationFrame(resolve));
                if (chat.scrollHeight - chat.clientHeight - chat.scrollTop > 12) return false;
            }
            return true;
        });
        expect(stayedAtBottom).toBe(true);
    });
});
