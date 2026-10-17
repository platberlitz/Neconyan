/* global document, WheelEvent */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    const viewport = phone ? 'iPhone Safari emulation' : 'desktop';

    test(`two-speaker group saving keeps the final preview position on ${viewport}`, async ({ app }) => {
        test.setTimeout(240000);
        app.provider.mode.hold = ['conversation-fixture', 'unused-named-model'];
        // Each release clears the hold, so every provider response rearms it.
        app.provider.mode.reply = () => {
            app.provider.mode.hold = ['conversation-fixture', 'unused-named-model'];
            return { choices: [{ finish_reason: 'stop', message: { role: 'assistant',
                content: 'A group reply.\n\n' + 'A paragraph of the group reply.\n\n'.repeat(35) } }] };
        };
        await fs.writeFile(path.join(app.directory, 'data/default-user/InChatAgents/group-note.json'), JSON.stringify({
            id: 'group-note', name: 'Group note', enabled: true, category: 'companion', execution: 'companion',
            prompt: 'Write a short note.', companion: { trigger: 'auto', includeWorldInfo: false },
        }));
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings(saved) {
                saved.oai_settings.openai_max_context = 8192;
                saved.oai_settings.openai_max_tokens = 1024;
                saved.power_user.auto_swipe = false;
                saved.power_user.auto_continue = { enabled: false };
                saved.extension_settings.inChatAgents = { ...saved.extension_settings.inChatAgents,
                    globalSettings: { ...saved.extension_settings.inChatAgents?.globalSettings,
                        enabled: true, hiddenCompanionAgentIds: [], separateRecentChats: true,
                        scopedEnabledAgentIdsInitialized: true,
                        enabledAgentIdsByChatType: { group: ['group-note'], individual: [] } } };
            } });
        if (phone) await installIPhoneSafari(account.context);

        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers,
            data: { ch_name: 'Durable Kit', description: 'A second speaker.', first_mes: 'Hello from Kit.' },
        });
        expect(created.ok()).toBe(true);
        const second = await created.text();
        const probe = await account.context.request.post('/api/chats/get', {
            headers: account.headers,
            data: { avatar_url: account.avatar, file_name: 'Group viewport probe', allow_create: true },
        });
        const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
        const group = await account.post('/api/groups/create', { name: 'Two speakers', members: [account.avatar, second],
            activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });

        const page = await account.open({ workspace: false, readyTimeout: 60000 });
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
        await acknowledgeActiveSettings(page);

        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && response.status() === 202);
        await page.locator('#send_textarea').fill('Everyone, please reply in turn.');
        await page.locator('#send_textarea').press('Enter');
        const { jobId } = await (await submitted).json();

        for (let call = 1; call <= 3; call++) {
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(call);
            await app.release();
        }
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(4);

        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview.getByRole('status')).toHaveText('Running Companions…');
        await page.locator('#chat').evaluate(chat => {
            chat.scrollTop = chat.scrollHeight - chat.clientHeight - 200;
            chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
            chat.dispatchEvent(new Event('scroll'));
        });
        // Let the final speaker's preview and any notes settle before reading it.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(1000);
        const before = await preview.locator('.mes_text').evaluate(element => element.getBoundingClientRect().top);
        await app.release();
        await account.settled(jobId);
        await expect(preview).toHaveCount(0);
        // Outlast every chat-load settle pin after the saved readback.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2800);

        const rows = await page.evaluate(() => [...document.querySelectorAll('#chat > .mes')].map(element => ({
            id: element.getAttribute('mesid'),
            name: element.querySelector('.name_text')?.textContent?.trim(),
            top: element.querySelector('.mes_text')?.getBoundingClientRect().top ?? null,
        })));
        expect(rows).toHaveLength(4);
        expect(rows.at(-1)?.name).toBe('Durable Kit');
        expect(rows.at(-1)?.top).not.toBeNull();
        expect(Math.abs(rows.at(-1).top - before)).toBeLessThanOrEqual(4);
    });
}
