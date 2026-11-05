/* global document, window, MutationObserver */
import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function lifecycle(page, state) {
    await page.evaluate(state => window.dispatchEvent(new CustomEvent('neconyan:memory-lifecycle', { detail: { state } })), state);
}

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'} background saver frees history and restores the reading position without losing edits`, async ({ app, browserName }, info) => {
    test.setTimeout(180000);
    const ios = phone && browserName === 'webkit';
    const account = await app.account({ phone, contextOptions: ios ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
        saved.power_user.chat_truncation = 100;
        saved.power_user.aggressive_dom_unload = false;
        saved.power_user.auto_label_chat = false;
    } });
    const fields = { avatar_url: account.avatar, file_name: 'Memory saver test' };
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
    const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        ...Array.from({ length: 100 }, (_, index) => ({ name: 'Durable Nova', is_user: false, extra: {},
            mes: `Message ${index}.\n\n` + '**Memory test.** A paragraph to render.\n\n'.repeat(12) }))];
    await account.post('/api/chats/save', { ...fields, chat: records,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
    const otherFields = { ...fields, file_name: 'Another memory test' };
    const otherResponse = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...otherFields, allow_create: true } });
    const otherVacancy = JSON.parse(otherResponse.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...otherFields, chat: [records[0], { ...records[1], mes: 'Different saved chat.' }],
        roleplay: { account: otherVacancy.account, vacancy: otherVacancy.vacancy, operationKey: crypto.randomUUID() } });
    const savedBefore = await account.post('/api/chats/get', fields);
    if (ios) await installIPhoneSafari(account.context);
    const page = await account.open({ workspace: false });
    if (ios) await applyIOSOnlyCss(page, { inPlace: true });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.getByRole('button', { name: 'System & Device', exact: true }).click();
    await page.locator('#sb-aggressive-dom-unload-drawer > .inline-drawer-header').click();
    const toggle = page.locator('#background_memory_saver');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await page.evaluate(async ({ avatar, name }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(name);
    }, { avatar: account.avatar, name: fields.file_name });
    const rows = page.locator('#chat .mes[mesid]');
    await expect(rows).toHaveCount(100);
    await page.locator('#send_textarea').fill('Keep this unsent draft.');
    await page.locator('#send_textarea').blur();
    await page.evaluate(() => { const chat = document.querySelector('#chat'); chat.scrollTop = chat.scrollHeight; });
    await expect(page.locator('#chat .mes[mesid="99"]')).toBeInViewport();
    // Exercise the real generation-busy gate without sending anything to a provider.
    await page.evaluate(async () => (await import('/script.js')).setSendButtonState(true));
    await lifecycle(page, 'background');
    await expect(rows).toHaveCount(100);
    await lifecycle(page, 'foreground');
    await page.evaluate(async () => (await import('/script.js')).setSendButtonState(false));
    const nodesBefore = await page.locator('#chat *').count();
    // Explicit collection is measurement-only; the app never forces garbage collection.
    const cdp = browserName === 'chromium' ? await account.context.newCDPSession(page) : null;
    await cdp?.send('HeapProfiler.collectGarbage');
    const heapBefore = await cdp?.send('Runtime.getHeapUsage');
    const before = await page.evaluate(() => {
        const y = document.querySelector('#chat .mes[mesid="99"]').getBoundingClientRect().y;
        window.dispatchEvent(new CustomEvent('neconyan:memory-lifecycle', { detail: { state: 'background' } }));
        return { y };
    });
    await expect(rows).toHaveCount(25);
    const nodesHidden = await page.locator('#chat *').count();
    await cdp?.send('HeapProfiler.collectGarbage');
    const heapHidden = await cdp?.send('Runtime.getHeapUsage');
    expect(nodesHidden).toBeLessThan(nodesBefore / 2);
    expect(await page.evaluate(async () => (await import('/script.js')).chat.length)).toBe(100);
    await lifecycle(page, 'foreground');
    await expect(rows).toHaveCount(100, { timeout: 30000 });
    await expect.poll(async () => Math.abs((await page.locator('#chat .mes[mesid="99"]').boundingBox()).y - before.y)).toBeLessThan(2);
    await expect(page.locator('#send_textarea')).toHaveValue('Keep this unsent draft.');
    const measurement = { phone, nodesBefore, nodesHidden, heapBefore, heapHidden };
    console.log(JSON.stringify(measurement));
    await info.attach('memory-measurement', { body: JSON.stringify(measurement), contentType: 'application/json' });
    await cdp?.detach();

    if (phone) {
        await lifecycle(page, 'background');
        await expect(rows).toHaveCount(25);
        await page.evaluate(() => {
            const observer = new MutationObserver(() => {
                const count = document.querySelectorAll('#chat .mes[mesid]').length;
                if (count <= 25 || count >= 100) return;
                observer.disconnect();
                document.querySelector('#chat').dataset.memoryRestoreInterrupted = 'true';
                window.dispatchEvent(new CustomEvent('neconyan:memory-lifecycle', { detail: { state: 'background' } }));
                window.dispatchEvent(new CustomEvent('neconyan:memory-lifecycle', { detail: { state: 'foreground' } }));
            });
            observer.observe(document.querySelector('#chat'), { childList: true });
        });
        await lifecycle(page, 'foreground');
        await expect(rows).toHaveCount(100, { timeout: 30000 });
        expect(await rows.evaluateAll(rows => rows.map(row => Number(row.getAttribute('mesid'))))).toEqual(Array.from({ length: 100 }, (_, index) => index));
        await expect(page.locator('#chat')).toHaveAttribute('data-memory-restore-interrupted', 'true');
        await expect(page.locator('#send_textarea')).toHaveValue('Keep this unsent draft.');
    }

    const last = rows.last();
    await last.locator('.mes_edit').click();
    await page.locator('#curEditTextarea').fill('Keep this unfinished edit.');
    await lifecycle(page, 'background');
    await expect(rows).toHaveCount(100);
    await lifecycle(page, 'foreground');
    await expect(page.locator('#curEditTextarea')).toHaveValue('Keep this unfinished edit.');
    await last.locator('.mes_edit_cancel').click();
    // A changed chat must not receive the old chat's restoration callback.
    await lifecycle(page, 'background');
    await expect(rows).toHaveCount(25);
    await page.evaluate(async () => { await (await import('/script.js')).openCharacterChat('Another memory test'); });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Different saved chat.');
    await lifecycle(page, 'foreground');
    await expect(rows).toHaveCount(1);
    await expect(rows).not.toContainText('Message 99.');
    const saved = await account.post('/api/chats/get', fields);
    expect(saved).toEqual(savedBefore);
    expect(saved.slice(1)).toEqual(records.slice(1));
});
