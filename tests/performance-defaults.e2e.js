/* global window, document, MutationObserver */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} background library loads on first use and reuses the result`, async ({ app }) => {
        const account = await app.account({ phone });
        const requests = [];
        account.context.on('request', request => {
            if (request.url().endsWith('/api/backgrounds/all')) requests.push(request.url());
        });
        await account.context.addInitScript(() => {
            window.addEventListener('neconyan:ready', () => { window.performanceTestReady = true; });
        });
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.waitForFunction(() => window.performanceTestReady);
        expect(requests).toHaveLength(0);
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
        const images = page.locator('#bg_menu_content .bg_example');
        await expect(images.first()).toBeVisible({ timeout: 30000 });
        expect(requests).toHaveLength(1);
        const chosen = images.first();
        await chosen.click();
        const background = await page.locator('#bg1').evaluate(element => element.style.backgroundImage);
        expect(background).not.toBe('');
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'user'));
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
        await expect(chosen).toBeVisible();
        expect(requests).toHaveLength(1);
        expect(await page.locator('#bg1').evaluate(element => element.style.backgroundImage)).toBe(background);
    });

    test(`${viewport} idle page leaves body attributes alone`, async ({ app }) => {
        const account = await app.account({ phone });
        await account.context.addInitScript(() => {
            window.addEventListener('neconyan:ready', () => { window.performanceTestReady = true; });
        });
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.waitForFunction(() => window.performanceTestReady);
        // Preset Tools checks its panels every second, so this spans several checks.
        // Rewriting a body attribute with its current value wakes every body observer.
        const unchangedWrites = await page.evaluate(() => new Promise(resolve => {
            const writes = [];
            const observer = new MutationObserver(records => {
                for (const record of records) {
                    if (record.oldValue === document.body.getAttribute(record.attributeName)) writes.push(record.attributeName);
                }
            });
            observer.observe(document.body, { attributes: true, attributeOldValue: true });
            window.setTimeout(() => { observer.disconnect(); resolve(writes); }, 3500);
        }));
        expect(unchangedWrites).toEqual([]);
    });

    test(`${viewport} long-history first token streams before completion`, async ({ app }, info) => {
        app.provider.mode.streamReply = { first: 'First words', rest: ' and the finished reply.' };
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            Object.assign(saved.oai_settings, { stream_openai: true, openai_max_context: 128000, openai_max_tokens: 256 });
        } });
        await account.context.addInitScript(() => {
            window.addEventListener('neconyan:ready', () => { window.performanceTestReady = true; });
        });
        const chatName = `Performance ${viewport}`;
        const fields = { avatar_url: account.avatar, file_name: chatName };
        const source = await account.context.request.post('/api/chats/get', {
            headers: account.headers, data: { ...fields, allow_create: true },
        });
        expect(source.ok()).toBe(true);
        const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...fields, chat: [
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            ...Array.from({ length: 120 }, (_, index) => ({
                name: index % 2 ? 'User' : 'Durable Nova', is_user: Boolean(index % 2), extra: {},
                mes: `Message ${index}. ` + 'The archivist checks the station timetable and records the details of the journey. '.repeat(8),
            })),
        ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.waitForFunction(() => window.performanceTestReady, null, { timeout: 120000 });
        await page.evaluate(async ({ avatar, chatName }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            if (core.getCurrentChatId() !== chatName) await core.openCharacterChat(chatName);
        }, { avatar: account.avatar, chatName });
        await expect(page.locator('#send_textarea')).toBeVisible();
        await page.locator('#send_textarea').fill('Continue the journey.', { timeout: 60000 });
        await page.evaluate(() => {
            document.getElementById('send_textarea').addEventListener('keydown', event => {
                if (event.key === 'Enter') window.performanceSendAt = Date.now();
            }, { once: true });
            const observer = new MutationObserver(() => {
                if (document.getElementById('neconyan-roleplay-preview')?.textContent.includes('First words')) {
                    window.performanceFirstTextAt = Date.now();
                    observer.disconnect();
                }
            });
            observer.observe(document.getElementById('chat').parentElement, { childList: true, subtree: true, characterData: true });
        });
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409, { timeout: 90000 });
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const { jobId } = await response.json();
        try {
            const preview = page.locator('#neconyan-roleplay-preview');
            await expect(preview).toContainText('First words', { timeout: 90000 });
            await page.waitForFunction(() => window.performanceFirstTextAt > 0);
            expect(app.provider.calls).toHaveLength(1);
            const call = app.provider.calls[0];
            expect(call.completedAt).toBeNull();
            expect(call.messages.length).toBeGreaterThan(100);
            const times = await page.evaluate(() => ({ sentAt: window.performanceSendAt, visibleAt: window.performanceFirstTextAt }));
            const metrics = { viewport, history: 120, messages: call.messages.length,
                firstTokenMs: times.visibleAt - times.sentAt,
                preparationMs: call.startedAt - times.sentAt,
                deliveryMs: times.visibleAt - call.firstTokenAt };
            console.log('First-token measurement:', JSON.stringify(metrics));
            await info.attach('first-token', { body: JSON.stringify(metrics), contentType: 'application/json' });
            const box = await preview.boundingBox();
            expect(box.width).toBeGreaterThan(0);
            expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            await page.screenshot({ path: info.outputPath('first-token.png') });
        } finally {
            app.provider.mode.finishStream?.();
        }
        await account.settled(jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('First words and the finished reply.', { timeout: 30000 });
    });
}
