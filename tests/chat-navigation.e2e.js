/* global document, window, PopStateEvent, PageTransitionEvent */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);

async function navigation(account) {
    const state = await account.post('/api/chat-navigation/state');
    return (action, body = {}) => account.post('/api/chat-navigation/' + action, { ...body, account: state.account });
}

async function ready(page) {
    await expect.poll(() => page.evaluate(async () => !(await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked()), { timeout: 45000 }).toBe(true);
}

async function roleplayFixtures(app, account) {
    const folder = path.join(app.directory, 'data', 'default-user', 'chats', account.avatar.slice(0, -4));
    await fs.mkdir(folder, { recursive: true });
    for (const name of ['Nav A', 'Nav B']) await fs.writeFile(path.join(folder, name + '.jsonl'),
        [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { tainted: true } },
            { name: 'User', is_user: true, mes: 'Exact ' + name }, { name: 'Durable Nova', is_user: false, mes: 'Saved answer ' + name }].map(row => JSON.stringify(row)).join('\n'));
    const nav = await navigation(account);
    const establish = chat => nav('establish', { mode: 'roleplay', locator: { group: false, avatar: account.avatar, chat } });
    return { a: await establish('Nav A'), b: await establish('Nav B'), nav, folder };
}

async function preferences(page, { links = false, resume = false } = {}) {
    await page.evaluate(async ({ links, resume }) => {
        const core = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_links = links;
        power_user.auto_load_chat = resume;
        if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Test preference save failed');
        window.dispatchEvent(new CustomEvent('neconyan:chat-links-preference'));
        window.dispatchEvent(new CustomEvent('neconyan:resume-preference'));
    }, { links, resume });
}

async function assertRoleplay(page, name) {
    await ready(page);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).getCurrentChatId())).toBe(name);
    await expect(page.locator('#chat .mes_text').filter({ hasText: 'Exact ' + name })).toHaveCount(1);
    await expect(page.locator('#chat .mes_text').filter({ hasText: 'Saved answer ' + name })).toHaveCount(1);
    expect(await page.evaluate(() => ['send_textarea', 'sb_conversation_input'].includes(document.activeElement?.id))).toBe(false);
}

async function navigateInPage(page, destination) {
    await page.evaluate(async destination => {
        const policy = await import('/scripts/chat-navigation-policy.js');
        const navigation = await import('/scripts/chat-navigation.js');
        const intent = { kind: 'chat', ...destination };
        window.history.pushState(null, '', policy.chatNavigationUrl(window.location.href, intent));
        await navigation.requestNavigation(intent, { reason: 'popstate' });
    }, destination);
}

for (const links of [false, true]) for (const resume of [false, true]) test(`explicit saved links win with links ${links}, resume ${resume}, without creating or generating`, async ({ app }) => {
    const account = await app.account();
    const { a, b, folder, nav } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    const before = await fs.readFile(path.join(folder, 'Nav A.jsonl'), 'utf8');
    const contentWrites = [];
    page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/(?:chats\/(?:save|import)|jobs(?:\/submit)?$|neconyan-conversation\/(?:message\/append|thread\/save))/.test(request.url())) contentWrites.push(request.url());
    });
    await test.step('explicit link and refresh use the same saved chat', async () => {
        await preferences(page, { links, resume });
        if (resume) await nav('remember', { destination: { id: b.id, mode: b.mode }, clientId: '11111111-1111-4111-8111-111111111111', sequence: 1 });
        const link = `${app.url}/?chat=${a.id}&mode=roleplay&unrelated=keep#saved`;
        await page.goto(link);
        await assertRoleplay(page, 'Nav A');
        expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
        expect(new URL(page.url()).searchParams.get('unrelated')).toBe('keep');
        await page.reload();
        await assertRoleplay(page, 'Nav A');
    });
    expect(contentWrites).toEqual([]);
    expect(await fs.readFile(path.join(folder, 'Nav A.jsonl'), 'utf8')).toBe(before);
    expect(app.provider.calls.filter(call => /completions/.test(call.path || call.url || ''))).toEqual([]);
});

test('foreground history, null history state, explicit Home and a second-context resume remain independent', async ({ app, browser }) => {
    const account = await app.account();
    const { a, b, nav } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await preferences(page, { links: true, resume: true });
    await page.goto(`${app.url}/?chat=${a.id}&mode=roleplay`);
    await assertRoleplay(page, 'Nav A');
    await page.evaluate(async () => (await import('/script.js')).openCharacterChat('Nav B'));
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(b.id);
    await expect.poll(async () => (await nav('state')).pointer?.id).toBe(b.id);
    const second = await browser.newContext({ storageState: await account.context.storageState(), viewport: { width: 1280, height: 900 } });
    try {
        const other = await second.newPage();
        await other.goto(app.url);
        await assertRoleplay(other, 'Nav B');
        await page.goBack();
        await assertRoleplay(page, 'Nav A');
        expect((await nav('state')).pointer.id).toBe(b.id);
        await page.evaluate(() => { window.history.pushState(null, '', '?view=home'); window.dispatchEvent(new PopStateEvent('popstate', { state: null })); });
        await ready(page);
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        await page.reload();
        await ready(page);
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        expect((await nav('state')).pointer.id).toBe(b.id);
        await page.goBack();
        await assertRoleplay(page, 'Nav A');
        await assertRoleplay(other, 'Nav B');
    } finally { await second.close(); }
});

test('invalid and missing links block sends; transient failure retries its exact address', async ({ app }) => {
    const account = await app.account();
    const { a } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await page.goto(`${app.url}/?chat=&mode=roleplay`);
    await expect(page.locator('#neconyan-chat-route h2')).toHaveText('Chat could not be opened', { timeout: 45000 });
    await expect(page.getByRole('button', { name: 'Go to Home', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked())).toBe(true);
    expect(new URL(page.url()).searchParams.has('chat')).toBe(true);
    await page.getByRole('button', { name: 'Go to Home', exact: true }).click();
    await ready(page);
    expect(new URL(page.url()).searchParams.get('view')).toBe('home');
    let failing = true;
    await page.route('**/api/chat-navigation/resolve', route => failing ? route.fulfill({ status: 503, json: { error: 'navigation_retry' } }) : route.continue());
    const link = `${app.url}/?chat=${a.id}&mode=roleplay`;
    await page.goto(link);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 45000 });
    expect(page.url()).toBe(link);
    failing = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await assertRoleplay(page, 'Nav A');
    expect(page.url()).toBe(link);
    await page.goto(`${app.url}/?chat=99999999-9999-4999-8999-999999999999&mode=roleplay`);
    await expect(page.locator('#neconyan-chat-route h2')).toHaveText('Chat could not be opened', { timeout: 45000 });
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
    await account.context.setOffline(true);
    await navigateInPage(page, a);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    await account.context.setOffline(false);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await assertRoleplay(page, 'Nav A');
    expect((await (await navigation(account))('state')).pointer).toBeNull();
});

test('Conversation links load the saved persona and branch, and survive a real server restart', async ({ app }) => {
    const account = await app.account();
    await account.changeStore(store => {
        const thread = store.characters[account.threadKey];
        thread.branches.alternate = { ...thread.branches.main, id: 'alternate', name: 'Alternate', lifetimeSeed: 'alternate-life',
            messages: [{ id: 'alternate-message', role: 'user', name: 'User', mes: 'Only the alternate branch.', timestamp: 1700000000001 }] };
    });
    const nav = await navigation(account);
    const destination = await nav('establish', { mode: 'conversation', target: { avatar: account.avatar, personaId: account.personaId, groupId: '', branchId: 'alternate' } });
    const page = await account.open({ workspace: false });
    await ready(page);
    const link = `${app.url}/?chat=${destination.id}&mode=conversation`;
    await page.goto(link);
    await ready(page);
    await expect(page.locator('#sb_conversation_timeline')).toContainText('Only the alternate branch.');
    await expect(page.locator('#sb_conversation_timeline')).not.toContainText('Original question.');
    expect(await page.evaluate(async () => (await import('/scripts/neconyan-conversation/context.js')).getActiveConversationBranch((await import('/scripts/neconyan-conversation/state.js')).conversationState.conversationSelectedAvatar, { create: false }).id)).toBe('alternate');
    await app.restart();
    await page.reload();
    await ready(page);
    await expect(page.locator('#sb_conversation_timeline')).toContainText('Only the alternate branch.');
    expect(page.url()).toBe(link);
});

test('phone copy fallback is honest, selectable and within the screen with iPhone home-screen emulation', async ({ app }) => {
    const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    await installIPhoneSafari(account.context, { standalone: true });
    const { a } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await page.goto(`${app.url}/?chat=${a.id}&mode=roleplay&secret=not-in-copy#fragment`);
    await assertRoleplay(page, 'Nav A');
    await applyIOSOnlyCss(page);
    await page.evaluate(() => {
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Test denied clipboard'); } } });
        window.NeconyanShell.openChatTools();
    });
    const copy = page.locator('#sb-mobile-chat-copy-link');
    await expect(copy).toBeVisible();
    await expect(copy).toBeEnabled();
    expect((await copy.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await copy.click();
    const dialog = page.locator('#neconyan-chat-route');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input')).toHaveValue(`${app.url}/?chat=${a.id}&mode=roleplay`);
    await expect(dialog).toContainText('does not share the chat');
    const geometry = await dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: window.innerWidth,
            button: element.querySelector('[data-route-close]').getBoundingClientRect().height, selected: element.querySelector('input').selectionEnd > 0 };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.button).toBeGreaterThanOrEqual(44);
    expect(geometry.selected).toBe(true);
    await expect(page.locator('.toast-success')).toHaveCount(0);
});

test('saved group links choose the exact group chat without greeting, saves or generation', async ({ app }) => {
    const account = await app.account();
    const group = await account.post('/api/groups/create', { name: 'Navigation group', members: [account.avatar], disabled_members: [], chat_id: 'Nav group B', chats: ['Nav group A', 'Nav group B'] });
    const folder = path.join(app.directory, 'data', 'default-user', 'group chats');
    await fs.mkdir(folder, { recursive: true });
    for (const name of ['Nav group A', 'Nav group B']) await fs.writeFile(path.join(folder, name + '.jsonl'),
        [{ chat_metadata: { tainted: true } }, { name: 'User', is_user: true, mes: 'Exact ' + name }, { name: 'Durable Nova', is_user: false, mes: 'Saved answer ' + name }].map(row => JSON.stringify(row)).join('\n'));
    const nav = await navigation(account);
    const destination = await nav('establish', { mode: 'roleplay', locator: { group: true, chat: 'Nav group A' }, groupId: group.id });
    const before = await fs.readFile(path.join(folder, 'Nav group A.jsonl'), 'utf8');
    const page = await account.open({ workspace: false });
    await ready(page);
    const writes = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:chats\/(?:save|group\/save)|groups\/edit|jobs\/submit)/.test(request.url())) writes.push(request.url()); });
    await navigateInPage(page, destination);
    await assertRoleplay(page, 'Nav group A');
    expect(await page.evaluate(async () => String((await import('/scripts/group-chats.js')).selected_group))).toBe(String(group.id));
    expect(await fs.readFile(path.join(folder, 'Nav group A.jsonl'), 'utf8')).toBe(before);
    expect(writes).toEqual([]);
    expect(app.provider.calls.filter(call => /completions/.test(call.path || call.url || ''))).toEqual([]);
    const replacement = await nav('establish', { mode: 'roleplay', locator: { group: true, chat: 'Nav group B' }, groupId: group.id });
    await page.route('**/api/chats/group/get', async route => {
        const response = await route.fetch();
        const headers = response.headers();
        const evidence = JSON.parse(headers['x-neconyan-roleplay']);
        evidence.source.instanceId = destination.id;
        headers['x-neconyan-roleplay'] = JSON.stringify(evidence);
        delete headers['content-length'];
        const records = await response.json();
        records[1].mes = 'Forbidden group replacement';
        await route.fulfill({ response, headers, json: records });
    });
    await navigateInPage(page, replacement);
    await expect(page.locator('#neconyan-chat-route-title')).toHaveText('Chat could not be opened');
    await expect(page.getByText('Forbidden group replacement', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-route-retry]')).toBeVisible();
    expect(await page.evaluate(async () => (await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked())).toBe(true);
});

test('Story links change only presentation, and a disabled Story extension stays disabled', async ({ app }) => {
    const account = await app.account();
    const { a, folder, nav } = await roleplayFixtures(app, account);
    const story = await nav('establish', { mode: 'story', locator: { group: false, avatar: account.avatar, chat: 'Nav A' } });
    const before = await fs.readFile(path.join(folder, 'Nav A.jsonl'), 'utf8');
    const page = await account.open({ workspace: false });
    await ready(page);
    const writes = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:chats\/(?:save|group\/save)|jobs\/submit)/.test(request.url())) writes.push(request.url()); });
    await navigateInPage(page, story);
    await assertRoleplay(page, 'Nav A');
    await expect(page.locator('body')).toHaveClass(/sbstory/);
    await expect(page.locator('#sbstory-bar')).toBeVisible();
    await navigateInPage(page, a);
    await expect(page.locator('body')).not.toHaveClass(/sbstory/);
    expect(await fs.readFile(path.join(folder, 'Nav A.jsonl'), 'utf8')).toBe(before);
    expect(writes).toEqual([]);
    await page.evaluate(async () => {
        const core = await import('/script.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        extension_settings.disabledExtensions.push('third-party/Neconyan-Story-Mode');
        if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Could not disable test Story extension');
    });
    await page.goto(`${app.url}/?chat=${story.id}&mode=story`);
    await expect(page.locator('#neconyan-chat-route h2')).toHaveText('Chat could not be opened', { timeout: 45000 });
    expect(await page.evaluate(async () => (await import('/scripts/extensions.js')).extension_settings.disabledExtensions.includes('third-party/Neconyan-Story-Mode'))).toBe(true);
    expect(await fs.readFile(path.join(folder, 'Nav A.jsonl'), 'utf8')).toBe(before);
});

test('different persona and Conversation group links retain their own saved branch and messages', async ({ app }) => {
    const account = await app.account();
    const companion = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Navigation companion', description: 'A second saved group member.', first_mes: 'Hello.' } });
    expect(companion.ok()).toBe(true);
    const secondAvatar = await companion.text();
    const avatars = path.join(app.directory, 'data', 'default-user', 'User Avatars');
    await fs.copyFile(path.join(avatars, account.personaId), path.join(avatars, 'Other.png'));
    const directKey = 'persona:Other.png:' + account.avatar;
    const groupId = 'navigation-conversation-group';
    const groupKey = 'persona:Other.png:group:' + groupId + ':' + account.avatar;
    await account.changeStore(store => {
        const original = store.characters[account.threadKey];
        const branch = { ...original.branches.main, id: 'linked', name: 'Linked', lifetimeSeed: 'other-persona-life',
            messages: [{ id: 'other-persona-message', role: 'user', name: 'Other', mes: 'Only the other persona.', timestamp: 1700000000001 }] };
        store.characters[directKey] = { ...original, activeBranchId: 'linked', branches: { linked: branch } };
        store.groups.push({ id: groupId, name: 'Linked Conversation group', personaId: 'Other.png', members: [account.avatar, secondAvatar], disabled_members: [], createdAt: 1700000000002, lifetimeSeed: 'linked-group-life', conversation_settings: { enabled: true } });
        store.characters[groupKey] = { ...original, groupId, activeBranchId: 'linked', branches: { linked: { ...branch, lifetimeSeed: 'group-branch-life',
            messages: [{ id: 'other-group-message', role: 'user', name: 'Other', mes: 'Only the linked group branch.', timestamp: 1700000000003 }] } } };
    });
    const nav = await navigation(account);
    const direct = await nav('establish', { mode: 'conversation', target: { avatar: account.avatar, personaId: 'Other.png', groupId: '', branchId: 'linked' } });
    const group = await nav('establish', { mode: 'conversation', target: { avatar: account.avatar, personaId: 'Other.png', groupId, branchId: 'linked' } });
    const page = await account.open({ workspace: false });
    await ready(page);
    await navigateInPage(page, direct);
    await expect(page.locator('#sb_conversation_timeline')).toContainText('Only the other persona.');
    expect(await page.evaluate(async () => (await import('/scripts/personas.js')).user_avatar)).toBe('Other.png');
    await navigateInPage(page, group);
    await expect(page.locator('#sb_conversation_timeline')).toContainText('Only the linked group branch.');
    await expect(page.locator('#sb_conversation_timeline')).not.toContainText('Original question.');
    expect(await page.evaluate(async () => (await import('/scripts/neconyan-conversation/state.js')).conversationState.conversationSelectedGroupId)).toBe(groupId);
    await navigateInPage(page, direct);
    await expect(page.locator('#sb_conversation_timeline')).toContainText('Only the other persona.');
    expect(app.provider.calls.filter(call => /completions/.test(call.path || call.url || ''))).toEqual([]);
});

test('slow chat loading cannot overwrite a newer destination or an account cancellation', async ({ app }) => {
    const account = await app.account();
    const { a, b, nav } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await navigateInPage(page, b);
    let release;
    let paused;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { paused = resolve; });
    await page.route('**/api/chats/get', async route => {
        if (route.request().postDataJSON()?.file_name !== 'Nav A') { await route.continue(); return; }
        paused(); await gate; await route.continue();
    });
    await page.evaluate(async destination => {
        window.history.pushState(null, '', `?chat=${destination.id}&mode=roleplay`);
        window.fixtureNavigationA = (await import('/scripts/chat-navigation.js')).requestNavigation({ kind: 'chat', ...destination }, { reason: 'popstate' });
    }, a);
    await waiting;
    await page.evaluate(async destination => {
        window.history.pushState(null, '', `?chat=${destination.id}&mode=roleplay`);
        window.fixtureNavigationB = (await import('/scripts/chat-navigation.js')).requestNavigation({ kind: 'chat', ...destination }, { reason: 'popstate' });
    }, b);
    release();
    await page.evaluate(async () => Promise.all([window.fixtureNavigationA, window.fixtureNavigationB]));
    await assertRoleplay(page, 'Nav B');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(b.id);
    await page.unroute('**/api/chats/get');
    let releaseAccount;
    let accountPaused;
    const accountGate = new Promise(resolve => { releaseAccount = resolve; });
    const accountWaiting = new Promise(resolve => { accountPaused = resolve; });
    await page.route('**/api/chat-navigation/resolve', async route => { accountPaused(); await accountGate; await route.continue().catch(() => {}); });
    await page.evaluate(async destination => { window.fixtureNavigationA = (await import('/scripts/chat-navigation.js')).requestNavigation({ kind: 'chat', ...destination }, { reason: 'popstate' }); }, a);
    await accountWaiting;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('neconyan:account-changing')));
    releaseAccount();
    await page.evaluate(async () => window.fixtureNavigationA);
    expect(await page.evaluate(async () => (await import('/script.js')).getCurrentChatId())).toBe('Nav B');
    expect(await page.evaluate(async () => (await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked())).toBe(true);
    await expect(page.locator('#option_copy_chat_link')).toHaveAttribute('aria-disabled', 'true');
    expect((await nav('state')).pointer).toBeNull();
});

test('a replacement Roleplay source between lookup and loading never becomes editable under the old link', async ({ app }) => {
    const account = await app.account();
    const { a, b, nav } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await page.route('**/api/chats/get', async route => {
        const response = await route.fetch();
        const headers = response.headers();
        const evidence = JSON.parse(headers['x-neconyan-roleplay']);
        evidence.source.instanceId = b.id;
        headers['x-neconyan-roleplay'] = JSON.stringify(evidence);
        delete headers['content-length'];
        const records = await response.json();
        records[1].mes = 'Forbidden replacement';
        await route.fulfill({ response, headers, json: records });
    });
    await navigateInPage(page, a);
    await expect(page.locator('#neconyan-chat-route-title')).toHaveText('Chat could not be opened');
    await expect(page.getByText('Forbidden replacement', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-route-retry]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    expect(await page.evaluate(async () => (await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked())).toBe(true);
    expect((await nav('state')).pointer).toBeNull();
});

test('a Conversation reset between lookup and refresh never opens its replacement branch', async ({ app }) => {
    const account = await app.account();
    const nav = await navigation(account);
    const target = { avatar: account.avatar, personaId: account.personaId, groupId: '', branchId: 'main' };
    const original = await nav('establish', { mode: 'conversation', target });
    const page = await account.open({ workspace: false });
    await ready(page);
    let replacement;
    await page.route('**/api/neconyan-conversation/store/get', async route => {
        if (!replacement) {
            await account.changeStore(store => {
                const branch = store.characters[account.threadKey].branches.main;
                branch.lifetimeSeed = 'new-navigation-lifetime';
                branch.messages = [{ id: 'replacement-question', name: 'User', is_user: true, mes: 'Forbidden replacement' }];
            });
            replacement = await nav('establish', { mode: 'conversation', target });
        }
        await route.continue();
    });
    await navigateInPage(page, original);
    expect(replacement.id).not.toBe(original.id);
    await expect(page.locator('#neconyan-chat-route-title')).toHaveText('Chat could not be opened');
    await expect(page.getByText('Forbidden replacement', { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('chat')).toBe(original.id);
    expect(await page.evaluate(async ({ target, id }) => (await import('/scripts/neconyan-conversation/chrome.js')).selectConversationThread(target.avatar,
        { ...target, savedOnly: true, expectedNavigationId: id }), { target, id: original.id })).toBe(false);
    expect((await nav('state')).pointer).toBeNull();
});

test('draft refusal, disabled URL tracking and restored-page routing preserve the current destination', async ({ app }) => {
    const account = await app.account();
    const { a, b, nav } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await navigateInPage(page, a);
    await page.locator('#send_textarea').fill('Unsent draft belongs to A.');
    await navigateInPage(page, b);
    await expect(page.locator('#send_textarea')).toHaveValue('Unsent draft belongs to A.');
    expect(await page.evaluate(async () => (await import('/script.js')).getCurrentChatId())).toBe('Nav A');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    await page.locator('#send_textarea').fill('');
    await page.evaluate(async () => (await import('/script.js')).openCharacterChat('Nav B'));
    await expect.poll(() => new URL(page.url()).searchParams.has('chat')).toBe(false);
    await preferences(page, { links: false, resume: true });
    await expect.poll(async () => (await nav('state')).pointer?.id).toBe(b.id);
    await nav('remember', { destination: a, clientId: '11111111-1111-4111-8111-111111111111', sequence: 1 });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await assertRoleplay(page, 'Nav B');
    expect((await nav('state')).pointer.id).toBe(a.id);
    const length = await page.evaluate(() => window.history.length);
    await preferences(page, { links: true, resume: false });
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(b.id);
    expect(await page.evaluate(() => window.history.length)).toBe(length);
    await preferences(page, { links: false, resume: false });
    expect(new URL(page.url()).searchParams.has('chat')).toBe(false);
    expect(await page.evaluate(() => window.history.length)).toBe(length);
    await page.goto(app.url);
    await ready(page);
    await page.evaluate(() => window.NeconyanShell.showHome());
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('home');
});

test('desktop clipboard success uses the real labelled control and expired sign-in retains the chat link', async ({ app }) => {
    const account = await app.account();
    const { a } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await navigateInPage(page, a);
    await account.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => window.NeconyanShell.openChatTools());
    const copy = page.locator('#sb-desktop-chat-copy-link');
    await expect(copy).toBeVisible();
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(page.locator('.toast-success')).toContainText('Chat link copied.');
    expect(await page.evaluate(() => window.navigator.clipboard.readText())).toBe(`${app.url}/?chat=${a.id}&mode=roleplay`);
    expect((await account.context.request.post('/api/users/logout', { headers: account.headers, data: {} })).ok()).toBe(true);
    await navigateInPage(page, a);
    await expect(page.locator('#neconyan-chat-route-title')).toHaveText('Chat could not be opened');
    await expect(page.locator('[data-route-retry]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    await page.goto(`${app.url}/?chat=${a.id}&mode=roleplay&noauto=true`);
    await expect(page).toHaveURL(new RegExp('/login\\?'));
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    await page.locator('#userList .userSelect').filter({ hasText: 'default-user' }).click();
    await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('chat') === a.id, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await assertRoleplay(page, 'Nav A');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    expect(new URL(page.url()).searchParams.has('noauto')).toBe(false);
});

test('link switches beside Copy chat link drive the saved preferences on desktop and phones', async ({ app }) => {
    const account = await app.account();
    const { a } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await navigateInPage(page, a);
    await page.evaluate(() => window.NeconyanShell.openChatTools());
    const links = page.locator('#sb-desktop-chat-chat_links');
    await expect(links).toBeVisible();
    await expect(links).not.toBeChecked();
    await expect(page.locator('#sb-desktop-chat-auto_load_chat')).not.toBeChecked();
    await links.check();
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    await expect(page.locator('#chat-links-checkbox')).toBeChecked();
    await page.evaluate(() => {
        const source = document.getElementById('chat-links-checkbox');
        source.checked = false;
        source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(links).not.toBeChecked();
    await expect(page.locator('#sb-mobile-chat-chat_links')).not.toBeChecked();
    await links.check();
    await page.locator('#sb-desktop-chat-auto_load_chat').check();
    await expect(page.locator('#auto-load-chat-checkbox')).toBeChecked();
    await page.reload();
    await ready(page);
    expect(await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        return [power_user.chat_links, power_user.auto_load_chat];
    })).toEqual([true, true]);

    const phone = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    await installIPhoneSafari(phone.context, { standalone: true });
    const phonePage = await phone.open({ workspace: false });
    await ready(phonePage);
    await phonePage.goto(`${app.url}/?chat=${a.id}&mode=roleplay`);
    await assertRoleplay(phonePage, 'Nav A');
    await applyIOSOnlyCss(phonePage);
    await phonePage.locator('#options_button').click();
    const item = phonePage.locator('#option_chat_link_settings');
    await expect(item).toBeVisible();
    expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await item.focus();
    await item.press('Enter');
    const dialog = phonePage.locator('#neconyan-chat-link-settings');
    await expect(dialog).toBeVisible();
    await expect(phonePage.locator('#options')).toBeHidden();
    await expect(dialog.locator('h2')).toBeFocused();
    await expect(dialog.locator('[data-chat-link-copy]')).toBeEnabled();
    await expect(phonePage.locator('#neconyan-chat-link-settings-chat_links')).toBeChecked();
    const geometry = await dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight,
            rows: [...element.querySelectorAll('.neconyan-link-switch')].map(row => row.getBoundingClientRect().height) };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.rows).toHaveLength(2);
    for (const row of geometry.rows) expect(row).toBeGreaterThanOrEqual(44);
    await phonePage.locator('#neconyan-chat-link-settings-chat_links').uncheck();
    await expect.poll(() => new URL(phonePage.url()).searchParams.has('chat')).toBe(false);
    await expect(phonePage.locator('#chat-links-checkbox')).not.toBeChecked();
    await dialog.locator('[data-link-settings-close]').click();
    await expect(dialog).toBeHidden();
    await phonePage.locator('#options_button').click();
    await item.click();
    await phonePage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await phonePage.locator('#options_button').click();
    await item.click();
    await phonePage.evaluate(() => {
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Test denied clipboard'); } } });
    });
    await dialog.locator('[data-chat-link-copy]').click();
    await expect(dialog).toBeHidden();
    await expect(phonePage.locator('#neconyan-chat-route')).toBeVisible();
    await expect(phonePage.locator('[data-route-link]')).toHaveValue(`${app.url}/?chat=${a.id}&mode=roleplay`);
});

test('foreground link preparation never exposes a different editable chat under the previous link', async ({ app }) => {
    const account = await app.account();
    const { a, b } = await roleplayFixtures(app, account);
    const page = await account.open({ workspace: false });
    await ready(page);
    await preferences(page, { links: true, resume: false });
    await navigateInPage(page, a);
    let release;
    let reached;
    let gate = new Promise(resolve => { release = resolve; });
    let requested = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/chat-navigation/establish', async route => {
        if (route.request().postDataJSON().locator?.chat === 'Nav B') { reached(); await gate; }
        await route.continue();
    });
    const opening = page.evaluate(async () => (await import('/script.js')).openCharacterChat('Nav B'));
    await requested;
    await expect(page.locator('#neconyan-chat-route-title')).toHaveText('Opening chat');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(a.id);
    expect(await page.evaluate(async () => (await import('/scripts/chat-navigation-flight.js')).isChatNavigationBlocked())).toBe(true);
    release();
    await opening;
    await ready(page);
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(b.id);
    await page.unroute('**/api/chat-navigation/establish');
    await preferences(page, { links: false, resume: false });
    await navigateInPage(page, a);
    gate = new Promise(resolve => { release = resolve; });
    requested = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/chat-navigation/establish', async route => {
        if (route.request().postDataJSON().locator?.chat === 'Nav B') { reached(); await gate; }
        await route.continue();
    });
    const withoutUrls = page.evaluate(async () => (await import('/script.js')).openCharacterChat('Nav B'));
    await requested;
    expect(new URL(page.url()).searchParams.has('chat')).toBe(false);
    release();
    await withoutUrls;
    await expect.poll(async () => page.locator('#option_copy_chat_link').getAttribute('aria-disabled')).toBe('false');
    expect(new URL(page.url()).searchParams.has('chat')).toBe(false);
});

test('real authentication and CSRF still protect navigation endpoints', async ({ app, browser }) => {
    const account = await app.account();
    const noCsrf = await account.context.request.post('/api/chat-navigation/state', { data: {} });
    expect(noCsrf.status()).toBe(403);
    const anonymous = await browser.newContext();
    try {
        const csrf = await (await anonymous.request.get(app.url + '/csrf-token')).json();
        const denied = await anonymous.request.post(app.url + '/api/chat-navigation/state', { data: {}, headers: { 'X-CSRF-Token': csrf.token } });
        expect(denied.status()).toBe(403);
    } finally { await anonymous.close(); }
});
