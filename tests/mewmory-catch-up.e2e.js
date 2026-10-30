/* global document, window */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

async function attachPendingFile(page, name) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#attachFile').evaluate(element => element.click());
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Pending attachment.') });
    await expect(page.locator('#file_form')).toBeVisible();
}

async function checkRecoveryButtons(page, info, phone) {
    const results = [];
    for (const accent of ['default', 'Pearl', 'Midnight Ink']) {
        if (accent !== 'default') {
            const profile = page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`);
            await expect(profile).toHaveCount(1);
            await profile.evaluate(element => element.click());
        }
        for (const label of ['Retry reply', 'Reply now']) {
            const button = page.getByRole('button', { name: label, exact: true });
            const measured = await button.evaluate(async element => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const context = document.createElement('canvas').getContext('2d');
                const rgba = colour => {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = colour;
                    context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data];
                };
                const ancestors = [];
                for (let node = element; node; node = node.parentElement) ancestors.push(node);
                // An accent change fades the fill over a CSS transition while the ink snaps. Read the colours only once the button and
                // everything it sits on have stopped animating; animations that never end (ambient decoration) are left out.
                for (let round = 0; round < 10; round += 1) {
                    const running = ancestors.flatMap(node => node.getAnimations())
                        .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
                    if (!running.length) break;
                    await Promise.allSettled(running.map(animation => animation.finished));
                }
                context.clearRect(0, 0, 1, 1);
                for (const node of ancestors.reverse()) {
                    context.fillStyle = window.getComputedStyle(node).backgroundColor;
                    context.fillRect(0, 0, 1, 1);
                }
                const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return { ratio: contrastRatio(rgba(style.color).slice(0, 3), background),
                    x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
                    width: rect.width, height: rect.height, clipped: element.scrollWidth > element.clientWidth + 1,
                    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
            });
            results.push({ accent, label, ...measured });
            expect(measured.ratio, JSON.stringify(results)).toBeGreaterThanOrEqual(4.5);
            expect(measured.height, JSON.stringify(results)).toBeGreaterThanOrEqual(phone ? 44 : 36);
            expect(measured.width).toBeGreaterThan(0);
            expect(measured.clipped).toBe(false);
            expect(measured.x).toBeGreaterThanOrEqual(0);
            expect(measured.y).toBeGreaterThanOrEqual(0);
            expect(measured.right).toBeLessThanOrEqual(measured.viewportWidth + 1);
            expect(measured.bottom).toBeLessThanOrEqual(measured.viewportHeight + 1);
        }
    }
    await info.attach('memory-recovery-button-geometry', { body: JSON.stringify(results), contentType: 'application/json' });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} reply now preserves the saved row and draft after stopping a memory wait`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.send_if_empty = 'Unexpected empty message';
            saved.oai_settings.openai_max_context = 65536;
            saved.oai_settings.openai_max_tokens = 512;
        } });
        const chatName = 'Mewmory catch-up fixture';
        const locator = { avatar: account.avatar, chat: chatName, group: false };
        const fields = { avatar_url: account.avatar, file_name: chatName };
        const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
        expect(vacant.ok()).toBe(true);
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        const messages = Array.from({ length: 15 }, (_, index) => ({ name: index % 2 ? 'User' : 'Nova', is_user: Boolean(index % 2),
            mes: `Original scene message ${index}.`, send_date: `fixture-${index}` }));
        await account.post('/api/chats/save', { ...fields, chat: [{ chat_metadata: {} }, ...messages],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        const config = (await account.post('/api/mewmory/config/get')).config;
        Object.assign(config, { autoUpdate: false, excludeHistory: true, historyMode: 'messages', recentMessages: 10,
            historyBatchMessages: 5, historyCatchUp: 'reply', writerTokenizer: 'cl100k_base' });
        Object.assign(config.roles.extractor, { enabled: true, endpoint: app.provider.url, model: 'memory-fixture', profileId: '' });
        await account.post('/api/mewmory/config/save', { config });
        const inspection = await account.post('/api/mewmory/inspect', { locator });
        await account.post('/api/mewmory/enabled', { locator, enabled: true, revision: inspection.revision });
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ avatar, chatName }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await core.openCharacterChat(chatName);
        }, { avatar: account.avatar, chatName });
        await page.locator('#send_textarea').fill('First question.');
        await page.evaluate(async () => (await import('/script.js')).Generate('normal', { skipNativeRoleplay: true }));
        await expect.poll(() => app.provider.calls.length).toBe(1);
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Original scene message 0.');

        const next = (await account.post('/api/mewmory/config/get')).config;
        next.historyCatchUp = 'wait';
        await account.post('/api/mewmory/config/save', { config: next });
        await page.evaluate(async () => (await import('/scripts/mewmory/index.js')).refreshMewmory());
        // Keep the real preparation/checkpoint state and replace only the worker start with a
        // harmless no-op, so Stop can be tested without a model request or artificial checkpoint.
        await page.route('**/api/mewmory/process', route => route.fulfill({ json: {} }));
        await page.locator('#send_textarea').fill('Second question.');
        const prepareResponse = page.waitForResponse(response => {
            if (response.request().method() !== 'POST') return false;
            if (new URL(response.url()).pathname !== '/api/mewmory/prepare') return false;
            return response.request().postData()?.includes('Second question.') === true;
        }, { timeout: 30000 });
        await page.evaluate(() => { void import('/script.js').then(core => core.Generate('normal', { skipNativeRoleplay: true })); });
        const prepared = await prepareResponse;
        expect((await prepared.json()).waiting).toBe(true);
        await expect(page.getByText(/Waiting for memory before replying/)).toBeVisible();
        await page.locator('#send_textarea').fill('Draft stays here.');
        await attachPendingFile(page, 'draft-note.txt');
        expect(await page.evaluate(async () => (await import('/scripts/chats.js')).hasPendingFileAttachment())).toBe(true);
        await page.locator('#mes_stop').click();
        await expect(page.getByRole('button', { name: 'Reply now', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Retry reply', exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath('memory-wait-recovery.png') });
        await checkRecoveryButtons(page, info, phone);
        await page.getByRole('button', { name: 'Reply now', exact: true }).click();
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
        await expect(page.locator('#send_textarea')).toHaveValue('Draft stays here.');
        expect(await page.locator('#file_form_input').evaluate(input => [...input.files].map(file => file.name))).toEqual(['draft-note.txt']);
        const rows = await page.evaluate(async () => (await import('/script.js')).chat.filter(row => row.is_user).map(row => row.mes));
        expect(rows.filter(text => text === 'Second question.')).toHaveLength(1);
        expect(rows).not.toContain('Unexpected empty message');
    });
}

test('native wait failure offers Reply now for the same accepted message', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.oai_settings.send_if_empty = 'Unexpected empty message';
        saved.oai_settings.openai_max_context = 65536;
        saved.oai_settings.openai_max_tokens = 512;
    } });
    const chatName = 'Native catch-up fixture';
    const locator = { avatar: account.avatar, chat: chatName, group: false };
    const fields = { avatar_url: account.avatar, file_name: chatName };
    const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(vacant.ok()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    const messages = Array.from({ length: 15 }, (_, index) => ({ name: index % 2 ? 'User' : 'Nova', is_user: Boolean(index % 2),
        mes: `Native scene ${index}.`, send_date: `native-${index}` }));
    await account.post('/api/chats/save', { ...fields, chat: [{ chat_metadata: {} }, ...messages],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    const config = (await account.post('/api/mewmory/config/get')).config;
    Object.assign(config, { autoUpdate: false, excludeHistory: true, historyMode: 'messages', recentMessages: 10,
        historyBatchMessages: 5, historyCatchUp: 'wait', writerTokenizer: 'cl100k_base' });
    config.roles.extractor.enabled = false;
    await account.post('/api/mewmory/config/save', { config });
    const inspection = await account.post('/api/mewmory/inspect', { locator });
    await account.post('/api/mewmory/enabled', { locator, enabled: true, revision: inspection.revision });
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, chatName }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(chatName);
    }, { avatar: account.avatar, chatName });
    await acknowledgeActiveSettings(page);
    const submissions = [];
    const acceptedJobs = [];
    page.on('request', request => {
        if (request.url().endsWith('/api/roleplay/workflow/submit')) submissions.push(request.postDataJSON());
    });
    page.on('response', async response => {
        if (!response.url().endsWith('/api/roleplay/workflow/submit') || !response.ok()) return;
        const accepted = await response.json();
        if (accepted.jobId) acceptedJobs.push(accepted.jobId);
    });
    await page.locator('#send_textarea').fill('Native question.');
    await page.evaluate(() => { void import('/script.js').then(core => core.Generate('normal', { skipNativeRoleplay: false })); });
    await expect(page.getByRole('button', { name: 'Reply now', exact: true })).toBeVisible({ timeout: 30000 });
    const retryConfig = (await account.post('/api/mewmory/config/get')).config;
    Object.assign(retryConfig.roles.extractor, { enabled: true, endpoint: app.provider.url, model: 'memory-fixture', profileId: '' });
    await account.post('/api/mewmory/config/save', { config: retryConfig });
    app.provider.mode.hold = ['memory-fixture'];
    await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
    await expect.poll(() => app.provider.calls.filter(call => call.model === 'memory-fixture').length, { timeout: 30000 }).toBe(1);
    await page.locator('#send_textarea').fill('Native draft stays here.');
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    await attachPendingFile(page, 'native-draft.txt');
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(0);
    await expect(page.locator('#mes_stop')).toBeVisible();
    await page.locator('#mes_stop').click();
    await expect(page.getByRole('button', { name: 'Reply now', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    expect(await page.locator('#file_form_input').evaluate(input => [...input.files].map(file => file.name))).toEqual(['native-draft.txt']);
    expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(0);
    app.provider.mode.hold = ['memory-fixture', MODEL];
    await page.getByRole('button', { name: 'Reply now', exact: true }).click();
    await expect.poll(() => app.provider.calls.filter(call => call.model === MODEL).length, { timeout: 30000 }).toBe(1);
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    await expect.poll(() => submissions.length).toBe(3);
    await expect.poll(() => acceptedJobs.length).toBe(3);
    await expect(page.locator('#mes_stop')).toBeVisible();
    await page.locator('#mes_stop').click();
    await expect.poll(async () => (await account.job(acceptedJobs[2])).state, { timeout: 30000 }).toBe('cancelled');
    expect(submissions[0].mewmoryCatchUpOverride).toBeUndefined();
    expect(submissions[1].mewmoryCatchUpOverride).toBeUndefined();
    expect(submissions[2].mewmoryCatchUpOverride).toBe('reply');
    expect(submissions[1].key).not.toBe(submissions[0].key);
    expect(submissions[2].key).not.toBe(submissions[1].key);
    expect(submissions[1].source).toEqual(submissions[0].source);
    expect(submissions[2].source).toEqual(submissions[0].source);
    expect((await account.post('/api/mewmory/config/get')).config.historyCatchUp).toBe('wait');
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    expect(await page.locator('#file_form_input').evaluate(input => [...input.files].map(file => file.name))).toEqual(['native-draft.txt']);
    const rows = await page.evaluate(async () => (await import('/script.js')).chat.filter(row => row.is_user).map(row => row.mes));
    expect(rows.filter(text => text === 'Native question.')).toHaveLength(1);
    expect(rows).not.toContain('Unexpected empty message');
    await app.release();
    await expect.poll(async () => (await account.job(acceptedJobs[2])).state).toBe('cancelled');
    await page.evaluate(async () => (await import('/script.js')).refreshCurrentChatFromSaved());
    await expect(page.locator('#send_textarea')).toHaveValue('Native draft stays here.');
    expect(await page.locator('#file_form_input').evaluate(input => [...input.files].map(file => file.name))).toEqual(['native-draft.txt']);
    const otherName = 'Native catch-up other chat';
    const otherFields = { avatar_url: account.avatar, file_name: otherName };
    const otherVacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...otherFields, allow_create: true } });
    expect(otherVacant.ok()).toBe(true);
    const otherVacancy = JSON.parse(otherVacant.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...otherFields, chat: [{ chat_metadata: {} }, { name: 'Nova', is_user: false, mes: 'Other chat.' }],
        roleplay: { account: otherVacancy.account, vacancy: otherVacancy.vacancy, operationKey: randomUUID() } });
    await page.evaluate(async name => (await import('/script.js')).openCharacterChat(name), otherName);
    expect(await page.locator('#file_form_input').evaluate(input => input.files.length)).toBe(0);
});
