/* global document, window, localStorage */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(180000);

const paragraphs = label => Array.from({ length: 24 }, (_, index) =>
    `${label} paragraph ${index}. Nova describes the fountain and the flowers beside the garden path in the afternoon light.`,
).join('\n\n');
const OLD_REPLY = paragraphs('Existing reply');

async function geometry(page) {
    return page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const bounds = chat.getBoundingClientRect();
        const reply = chat.querySelector('.mes.last_mes').getBoundingClientRect();
        return { scrollTop: chat.scrollTop, gap: chat.scrollHeight - chat.clientHeight - chat.scrollTop, top: reply.top - bounds.top };
    });
}

function setFailure(provider, streaming, kind) {
    provider.mode.reply = null;
    provider.mode.streamEvents = null;
    provider.mode.fail = kind === 'request';
    if (kind === 'request') return;
    const finishReason = kind === 'empty' ? 'stop' : 'error';
    if (streaming) {
        provider.mode.streamEvents = [{ choices: [{ delta: { content: '' }, finish_reason: finishReason }] }];
    } else {
        provider.mode.reply = { choices: [{ message: { content: '' }, finish_reason: finishReason }] };
    }
}

async function expectRestored(page) {
    await expect(page.locator('#chat .mes.last_mes .mes_text')).toHaveText(OLD_REPLY);
    expect(await page.evaluate(async () => {
        const { mes, swipes, swipe_id } = (await import('/script.js')).chat.at(-1);
        return { mes, swipes, swipe_id };
    })).toEqual({ mes: OLD_REPLY, swipes: [OLD_REPLY], swipe_id: 0 });
}

async function expectSavedReply(account, fields) {
    const saved = await account.post('/api/chats/get', fields);
    expect(saved.at(-1)).toMatchObject({ mes: OLD_REPLY, swipes: [OLD_REPLY], swipe_id: 0 });
}

for (const phone of [true, false]) {
    for (const streaming of [false, true]) {
        test(`${phone ? 'phone' : 'desktop'} failed ${streaming ? 'streaming' : 'non-streaming'} swipe keeps the existing reply in view`, async ({ app }, info) => {
            const account = await app.account({
                phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
                configureSettings(saved) {
                    saved.oai_settings.stream_openai = streaming;
                    saved.power_user.auto_swipe = false;
                    saved.power_user.auto_continue = { enabled: false };
                },
            });
            if (phone) await installIPhoneSafari(account.context);
            const name = 'Failed swipe viewport';
            const fields = { avatar_url: account.avatar, file_name: name };
            const source = await account.context.request.post('/api/chats/get', {
                headers: account.headers, data: { ...fields, allow_create: true },
            });
            const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
            await account.post('/api/chats/save', { ...fields,
                chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                    { name: 'User', is_user: true, mes: paragraphs('Earlier question'), extra: {} },
                    { name: 'Durable Nova', is_user: false, mes: OLD_REPLY, extra: {}, swipes: [OLD_REPLY], swipe_id: 0 }],
                roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
            });
            const page = await account.open({ workspace: false });
            if (phone) await applyIOSOnlyCss(page);
            await page.evaluate(async ({ avatar, name }) => {
                const core = await import('/script.js');
                await core.getCharacters();
                await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
                if (core.getCurrentChatId() !== name) await core.openCharacterChat(name);
            }, { avatar: account.avatar, name });
            // Let the initial chat-load pins finish before exercising swipe restoration.
            await page.waitForTimeout(2800);

            for (const scenario of [
                { name: 'request error', kind: 'request' },
                { name: 'empty reply', kind: 'empty' },
                { name: 'provider error before text', kind: 'provider' },
                { name: 'legacy request error', kind: 'request', legacy: true },
                { name: 'server request error', kind: 'request', server: true },
            ]) {
                await test.step(scenario.name, async () => {
                    setFailure(app.provider, streaming, scenario.kind);
                    await page.evaluate(legacy => {
                        localStorage.setItem('neconyan.chatRenderLifecycle.enabled', String(!legacy));
                        document.querySelector('#chat').scrollTop = document.querySelector('#chat').scrollHeight;
                        document.querySelector('#toast-container')?.replaceChildren();
                    }, Boolean(scenario.legacy));
                    const before = await geometry(page);
                    await page.evaluate(async server => {
                        await (await import('/script.js')).swipe_right(null, server ? { generationOptions: { skipNativeRoleplay: false } } : {});
                    }, Boolean(scenario.server));
                    await expectRestored(page);
                    // Catch delayed media/load scrolls as well as the immediate restoration.
                    await page.waitForTimeout(3000);
                    const after = await geometry(page);
                    expect(Math.abs(after.gap - before.gap)).toBeLessThanOrEqual(1);
                    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
                    await expectSavedReply(account, fields);
                    if (scenario.name === 'request error') {
                        await info.attach('restored-reply', { body: await page.screenshot(), contentType: 'image/png' });
                    }
                });
            }

            await test.step('reading older messages during the request is respected', async () => {
                setFailure(app.provider, streaming, 'request');
                app.provider.mode.hold = MODEL;
                const calls = app.provider.calls.length;
                await page.evaluate(() => {
                    window.failedSwipe = import('/script.js').then(core => core.swipe_right(null, {}));
                });
                await expect.poll(() => app.provider.calls.length).toBe(calls + 1);
                await page.evaluate(() => { document.querySelector('#chat').scrollTop = 400; });
                await page.locator('#chat').hover();
                await page.mouse.wheel(0, -100);
                await page.waitForTimeout(300);
                const before = await geometry(page);
                await app.release();
                await page.evaluate(() => window.failedSwipe);
                await expectRestored(page);
                await page.waitForTimeout(3000);
                expect(Math.abs((await geometry(page)).scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
                await expectSavedReply(account, fields);
            });

            await page.evaluate(async () => { await (await import('/script.js')).reloadCurrentChat(); });
            await expectRestored(page);
        });
    }
}
