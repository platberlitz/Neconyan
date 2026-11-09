/* global document, window */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Viewport-specific geometry checks. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { roleplayHash } from '../src/roleplay-store.js';
import { getConversationReplyPreviewParts } from '../public/scripts/neconyan-conversation/preview-utils.js';
import { test, send } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
const reply = { choices: [{ message: { role: 'assistant', content: 'Hello!' } }] };
const configureSettings = saved => { saved.power_user.neconyan_prompt_media = { version: 1, images: 'display-only' }; };

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`plain text replies with images disabled (${viewport})`, async ({ app }, info) => {
        app.provider.mode.reply = reply;
        const account = await app.account({ phone, configureSettings });
        await account.changeStore(store => { store.characters[account.threadKey].branches.main.messages = []; });
        const page = await account.open();
        const first = await send(page, 'Hey');
        await account.settled(first.job.id);
        await expect.poll(async () => (await account.branch()).messages.filter(message => message.role === 'character').length).toBe(1);
        const firstQuote = (await account.branch()).messages[1].extra.conversation_reply_to;
        expect(firstQuote).toMatchObject({ text: 'Hey', neconyan_image_source: { version: 1, authored_text: 'Hey' } });
        await expect(page.locator('.sb-conversation-message-reply-preview').first()).toContainText('Hey');
        const second = await send(page, 'How are you?');
        await account.settled(second.job.id);
        expect(app.provider.calls).toHaveLength(2);
        expect((await account.branch()).messages.filter(message => message.role === 'character').map(message => message.mes)).toEqual(['Hello!', 'Hello!']);
        await expect(page.getByText('Review needed before replying', { exact: true })).toHaveCount(0);
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(async avatar => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, account.avatar);
        await expect(page.locator('#sb_conversation_input')).toBeVisible();
        const third = await send(page, 'Still here after reloading.');
        await account.settled(third.job.id);
        expect(app.provider.calls).toHaveLength(3);
        expect((await account.branch()).messages.filter(message => message.role === 'character')).toHaveLength(3);
        expect((await account.branch()).messages[1].extra.conversation_reply_to).toEqual(firstQuote);
        await expect(page.locator('.sb-conversation-message-reply-preview').first()).toContainText('Hey');
        await expect(page.getByText('Review needed before replying', { exact: true })).toHaveCount(0);
        const geometry = await page.locator('#sb_conversation_input, #sb_conversation_send').evaluateAll(nodes => nodes.map(node => {
            const bounds = node.getBoundingClientRect();
            return { id: node.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }));
        for (const bounds of geometry) {
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.y).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(phone ? 852 : 900);
            if (phone) expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
        await fs.mkdir('screenshots', { recursive: true });
        const screenshot = `screenshots/quote-review-${viewport}-after.png`;
        await page.screenshot({ path: screenshot });
        await info.attach('after', { path: screenshot, contentType: 'image/png' });
        await info.attach('composer-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    });

    test(`legacy image quote stays private on both prompt hosts (${viewport})`, async ({ app }, info) => {
        const payloads = [];
        app.provider.mode.reply = body => { payloads.push(structuredClone(body)); return reply; };
        const account = await app.account({ phone, configureSettings });
        const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
        const source = { id: 'legacy-image-source', role: 'character', name: 'Durable Nova', mes: 'AUTHORED_QUOTE_PROSE', created_at: 1700000000000,
            extra: { media: [{ type: 'image', url: imageUrl, title: 'PRIVATE_QUOTE_IMAGE_CAPTION' }],
                files: [{ url: '/user/files/quote-fixture.txt', name: 'Quote fixture' }],
                conversation_attachment_context: 'PRIVATE_QUOTE_IMAGE_CAPTION\nFILE_QUOTE_CONTENT' } };
        source.extra.conversation_attachment_context_provenance = { version: 1, file_text: 'FILE_QUOTE_CONTENT', source_hash: roleplayHash([
            source.extra.conversation_attachment_context, source.extra.media, source.extra.files,
        ]) };
        const { text, attachmentSummary } = getConversationReplyPreviewParts(source);
        const legacy = { id: 'legacy-quote', role: 'user', name: 'User', mes: 'Please discuss the quoted message.', created_at: 1700000001000,
            extra: { conversation_reply_to: { messageId: source.id, name: source.name, text, attachmentSummary } } };
        await account.changeStore(store => { store.characters[account.threadKey].branches.main.messages = [source, legacy]; });
        const page = await account.open();
        const before = structuredClone((await account.branch()).messages);
        expect(before).toHaveLength(2);
        const browserPrompt = await page.evaluate(async messages => {
            return (await import('/scripts/neconyan-conversation/prompt.js')).buildConversationPromptMessages(messages, 'Reply', 'Durable Nova');
        }, before);
        const job = await account.post('/api/neconyan-conversation/reply/submit', {
            submissionKey: `legacy-${viewport}`, timeZone: 'UTC',
            target: { avatar: account.avatar, personaId: account.personaId, branchId: 'main' },
        });
        await account.settled(job.job.id);
        expect(payloads).toHaveLength(1);
        for (const prompt of [browserPrompt, payloads[0]]) {
            const wire = JSON.stringify(prompt);
            expect(wire).not.toContain('PRIVATE_QUOTE_IMAGE_CAPTION');
            expect(wire).not.toContain(imageUrl);
            expect(wire).not.toContain('image_url');
            expect(wire).toContain('AUTHORED_QUOTE_PROSE');
            expect(wire).toContain('FILE_QUOTE_CONTENT');
            expect(wire).toContain('Referenced message or attachment: AUTHORED_QUOTE_PROSE');
        }
        expect((await account.branch()).messages.slice(0, 2)).toEqual(before);
        expect(before[1].extra.conversation_reply_to.attachmentSummary).toContain('PRIVATE_QUOTE_IMAGE_CAPTION');
        await expect(page.locator('.sb-conversation-message-reply-preview').first()).toContainText('AUTHORED_QUOTE_PROSE');
        await expect(page.getByText('Review needed before replying', { exact: true })).toHaveCount(0);
        await info.attach('complete-provider-payloads', { body: JSON.stringify(payloads, null, 2), contentType: 'application/json' });
        await info.attach('browser-prompt', { body: JSON.stringify(browserPrompt, null, 2), contentType: 'application/json' });
        await info.attach('preserved-visible-messages', { body: JSON.stringify(before, null, 2), contentType: 'application/json' });
    });
}
