/* global document, window, navigator, innerWidth, innerHeight, MutationObserver, localStorage */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Each parameterised case has explicit boundary-specific assertions. */
import { expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { test, MODEL, send, noLateEffects } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'default' });
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an explicitly opted-in disposable server.');
test.setTimeout(180000);

for (const changeBinding of [false, true]) {
    test(`group batching ${changeBinding ? 'separates changed bindings' : 'uses later mentions with captured bindings'}`, async ({ app, browser }) => {
        const account = await app.account({ configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push({ ...saved.extension_settings.connectionManager.profiles[0],
                id: 'group-other', name: 'Other group profile', model: 'group-other' });
        } });
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
            data: { ch_name: 'Durable Kit', description: 'A second group member.', first_mes: 'Hello.' } });
        expect(created.ok()).toBe(true);
        const partner = await created.text();
        const current = await account.post('/api/neconyan-conversation/store/get');
        const { group } = await account.post('/api/neconyan-conversation/group/create', { version: current.version,
            personaId: account.personaId, members: [account.avatar, partner], name: 'Captured group',
            settings: { enabled: true, availability: 'online', reply_delay_multiplier: 0 } });
        const page = await account.open();
        await page.evaluate(async ({ avatar, partner, groupId }) => {
            const context = await import('/scripts/neconyan-conversation/context.js');
            for (const member of [avatar, partner]) Object.assign(context.getConversationThreadStore(member, { groupId, create: true }).settings,
                { enabled: true, availability: 'online', connection_profile: 'durable', reply_delay_multiplier: 0 });
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, { groupId });
            if (!await (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore()) throw new Error('Group setup failed');
        }, { avatar: account.avatar, partner, groupId: group.id });
        app.provider.mode.hold = [MODEL, 'group-other'];
        app.provider.mode.reply = { choices: [{ message: { content: 'Captured group reply.' } }] };
        const first = await send(page, 'Please wait for my next message.');
        expect(Object.keys(first.job.config.participantBindings).sort()).toEqual([account.avatar, partner].sort());
        if (changeBinding) await page.evaluate(async () => {
            const context = await import('/scripts/neconyan-conversation/context.js');
            context.getConversationStore().settings.connection_profile = 'group-other';
        });
        const second = await send(page, '@Durable Nova and @Durable Kit, please both answer.');
        expect(second.job.id === first.job.id).toBe(!changeBinding);
        expect(second.job.config.participantBindings[partner].profileId).toBe(changeBinding ? 'group-other' : 'durable');
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
        await app.release();
        await account.settled(first.job.id);
        await account.settled(second.job.id);
        const firstRoot = await account.job(first.job.id);
        expect(firstRoot.children).toHaveLength(2);
        for (const id of firstRoot.children) expect((await account.job(id)).credentialRef.profileId).toBe('durable');
        const secondRoot = await account.job(second.job.id);
        if (changeBinding) {
            expect(secondRoot.children.length).toBeGreaterThanOrEqual(1);
            for (const id of secondRoot.children) expect((await account.job(id)).credentialRef.profileId).toBe('group-other');
        }
        expect(app.provider.calls).toHaveLength(2 + (changeBinding ? secondRoot.children.length : 0));
        expect(app.provider.calls.filter(call => call.model === 'group-other')).toHaveLength(changeBinding ? secondRoot.children.length : 0);
    });
}

for (const phone of [false, true]) {
    for (const count of [249, 250]) {
        test(`${phone ? 'phone' : 'desktop'} retention at ${count} preserves a multi-bubble send and native effects`, async ({ app, browser }) => {
            const restart = !phone && count === 250;
            const account = await app.account({ phone, settings: { reply_delay_multiplier: restart ? 300 : 0 } });
            const history = Array.from({ length: count }, (_, index) => ({ id: `history-${index}`, role: 'user', name: 'User', mes: `Earlier ${index}`, timestamp: 1700000000000 + index }));
            await account.changeStore(store => { store.characters[account.threadKey].branches.main.messages = history; });
            app.provider.mode.reply = { choices: [{ message: { content: 'First. [reminder: 1h | Retention reminder]\n\n' + 'Remaining reply. '.repeat(40) } }] };
            const page = await account.open();
            const accepted = await send(page, 'First new input.\n\nSecond new input.');
            expect(accepted.userMessageIds).toHaveLength(2);
            await page.close();
            expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
            if (restart) {
                await expect.poll(async () => (await account.branch()).messages.filter(message => message.role === 'character').length, { timeout: 30000 }).toBe(1);
                await app.restart();
                expect(app.processes[0].signal).toBe('SIGKILL');
            }
            await account.settled(accepted.job.id);
            const branch = await account.branch();
            expect(branch.messages).toHaveLength(250);
            expect(branch.messages.slice(0, -4).map(message => message.id)).toEqual(history.slice(count - 246).map(message => message.id));
            expect(branch.messages.slice(-4, -2).map(message => message.mes)).toEqual(['First new input.', 'Second new input.']);
            expect((await account.store()).reminders).toHaveLength(1);
            expect(app.provider.calls).toHaveLength(1);
            const reopened = await account.open();
            expect((await account.branch()).messages).toEqual(branch.messages);
            expect(app.provider.calls).toHaveLength(1);
            await reopened.close();
        });
    }
}

for (const method of ['snapshot', 'folder', 'zip', 'reset then snapshot']) test(`restoring settings through ${method} invalidates a reply captured from newer history`, async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    expect((await account.context.request.post('/api/settings/make-snapshot', { headers: account.headers })).status()).toBe(204);
    const snapshots = await account.post('/api/settings/get-snapshots');
    const snapshot = snapshots.sort((a, b) => b.date - a.date)[0];
    expect(snapshot).toBeTruthy();
    const originalSettings = (await account.post('/api/settings/get')).settings;
    app.provider.mode.hold = MODEL;
    const accepted = await send(page, 'This newer input must not survive the backup restore.');
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await page.close();
    const before = await account.post('/api/neconyan-conversation/store/get');
    if (method === 'folder') {
        const source = path.join(app.directory, 'import');
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, 'settings.json'), originalSettings);
        await account.post('/api/users/import-sillytavern/folder', { sourcePath: source });
    } else if (method === 'zip') {
        const archive = archiver('zip');
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.append(originalSettings, { name: 'settings.json' });
        await archive.finalize();
        const response = await account.context.request.post('/api/users/import-sillytavern/zip', {
            headers: account.headers, multipart: { avatar: { name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks) } },
        });
        expect(response.ok(), await response.text()).toBe(true);
    } else {
        if (method === 'reset then snapshot') {
            expect((await account.context.request.post('/api/users/reset-settings', { headers: account.headers, data: { password: '' } })).status()).toBe(204);
            expect((await account.post('/api/neconyan-conversation/store/get')).version).toBeGreaterThan(before.version);
        }
        expect((await account.context.request.post('/api/settings/restore-snapshot', { headers: account.headers, data: { name: snapshot.name } })).status()).toBe(204);
    }
    const restored = await account.post('/api/neconyan-conversation/store/get');
    expect(restored.version).toBeGreaterThan(before.version);
    expect(restored.store.characters[account.threadKey].branches.main.messages.map(message => message.mes)).toEqual(['Original question.']);
    await app.release();
    await account.settled(accepted.job.id, 'interrupted');
    expect(await account.store()).toEqual(restored.store);
    expect(app.provider.calls).toHaveLength(1);
});

test('a lost first save of a new branch does not block the next real Send', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    await page.evaluate(async threadKey => {
        const { getConversationStore } = await import('/scripts/neconyan-conversation/context.js');
        const thread = getConversationStore().characters[threadKey];
        thread.branches.recovered = { ...structuredClone(thread.branches.main), id: 'recovered', createdAt: Date.now() + 1 };
        delete thread.branches.recovered.messageContentHash;
        delete thread.branches.recovered.messageEditRevision;
        thread.activeBranchId = 'recovered';
    }, account.threadKey);
    let dropped = false;
    await page.route('**/api/neconyan-conversation/store/save', async route => {
        if (dropped) return route.continue();
        const response = await route.fetch();
        if (response.status() === 409) return route.fulfill({ response });
        expect(response.ok(), await response.text()).toBe(true);
        dropped = true;
        await route.abort('failed');
    });
    expect(await page.evaluate(async () => {
        try { await (await import('/scripts/neconyan-conversation/store-sync.js')).persistConversationStoreNow(); }
        catch { return 'lost'; }
    })).toBe('lost');
    expect(dropped).toBe(true);
    expect((await account.store()).characters[account.threadKey].branches.recovered.messageContentHash).toMatch(/^[a-f0-9]{64}$/);
    const accepted = await send(page, 'Send after a lost branch save.');
    await page.close();
    await account.settled(accepted.job.id);
    expect((await account.branch('recovered')).messages.filter(message => message.mes === 'Send after a lost branch save.')).toHaveLength(1);
    expect(app.provider.calls).toHaveLength(1);
});

test('startup migration survives a native reply completed after the downloaded baseline', async ({ app }) => {
    const account = await app.account();
    const sending = await account.open();
    app.provider.mode.hold = MODEL;
    const accepted = await send(sending);
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await sending.close();
    await account.changeStore(store => { store.localStorageMigrated = false; });
    const page = await account.context.newPage();
    await page.addInitScript(() => localStorage.setItem('sb_conv_thread_migrated.png', JSON.stringify([{ id: 'migrated-user', role: 'user', mes: 'Unsaved local migration.', timestamp: 1700000000000 }])));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        await app.release();
        await account.settled(accepted.job.id);
        await route.fulfill({ response });
    });
    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    expect(await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore())).toBe(true);
    const saved = await account.store();
    expect(saved.characters[account.threadKey].branches.main.messages.filter(message => message.role === 'character')).toHaveLength(2);
    const allMessages = Object.values(saved.characters).flatMap(thread => Object.values(thread.branches || {}).flatMap(branch => branch.messages || []));
    expect(allMessages.filter(message => message.mes === 'Unsaved local migration.')).toHaveLength(1);
    await page.close();
    expect(app.provider.calls).toHaveLength(1);
});

test('a replacement branch cannot join or repair the previous branch batch without a browser anchor', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    let payload;
    await page.route('**/reply/submit', route => {
        payload = route.request().postDataJSON();
        delete payload.branchCreatedAt;
        return route.continue({ postData: JSON.stringify(payload) });
    });
    const old = await send(page, 'Old branch input.');
    await page.close();
    await account.changeStore(store => {
        const branch = store.characters[account.threadKey].branches.main;
        branch.createdAt = 'replacement-identity';
        branch.messages = [];
    });
    expect((await account.context.request.post('/api/neconyan-conversation/reply/submit', { headers: account.headers, data: payload })).status()).toBe(409);
    const fresh = await account.open();
    const accepted = await send(fresh, 'New branch input.');
    expect(accepted.job.id).not.toBe(old.job.id);
    await fresh.close();
    await account.settled(old.job.id, 'failed');
    await account.settled(accepted.job.id);
    expect((await account.branch()).messages.filter(message => message.role === 'user').map(message => message.mes)).toEqual(['New branch input.']);
    expect(app.provider.calls).toHaveLength(1);
});

test('legacy repeated messages survive concurrent native additions and unrelated local edits', async ({ app }) => {
    const account = await app.account();
    const file = path.join(app.directory, 'data/default-user/settings.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const branch = saved.extension_settings.sillybunny_conversation.characters[account.threadKey].branches.main;
    branch.messages = [{ role: 'user', mes: 'Repeated legacy message.' }, { role: 'user', mes: 'Repeated legacy message.' }];
    delete branch.messageEditRevision;
    delete branch.messageContentHash;
    await fs.writeFile(file, JSON.stringify(saved));
    const page = await account.context.newPage();
    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(async () => {
        const { getConversationStore } = await import('/scripts/neconyan-conversation/context.js');
        getConversationStore().settings.custom_instructions = 'Keep this local edit.';
    });
    const current = await account.post('/api/neconyan-conversation/store/get');
    await account.post('/api/neconyan-conversation/message/append', { avatar: account.avatar, personaId: account.personaId, version: current.version,
        message: { id: 'native-addition', role: 'character', name: 'Nova', mes: 'New server message.' } });
    expect(await page.evaluate(async () => {
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        await sync.refreshConversationStore();
        await sync.refreshConversationStore();
        return sync.flushConversationStore();
    })).toBe(true);
    const result = await account.store();
    expect(result.settings.custom_instructions).toBe('Keep this local edit.');
    expect(result.characters[account.threadKey].branches.main.messages.map(message => message.mes)).toEqual(['Repeated legacy message.', 'Repeated legacy message.', 'New server message.']);
    await page.close();
    const reopened = await account.open();
    expect((await account.branch()).messages.map(message => message.mes)).toEqual(['Repeated legacy message.', 'Repeated legacy message.', 'New server message.']);
    await reopened.close();
});

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} message menus and pet controls remain accessible`, async ({ app }) => {
        const account = await app.account({ phone });
        await account.changeStore(store => {
            store.characters[account.threadKey].branches.main.messages.push({ id: 'cat-character', role: 'character', name: 'Durable Nova', mes: 'Hello.', timestamp: Date.now() });
        });
        const page = await account.open();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        const animals = page.locator('#sb_conversation_timeline .neconyan-message-sleeper');
        await expect(animals).toHaveCount(2);
        for (const animal of await animals.all()) {
            await expect(animal).toHaveAttribute('role', 'button');
            await expect(animal).toHaveAttribute('tabindex', '0');
            await expect(animal).toHaveAttribute('aria-label', 'Pet sleeping cat');
            const original = await animal.getAttribute('src');
            await animal.evaluate(img => {
                img.__petLog = [];
                new MutationObserver(() => img.__petLog.push(img.src)).observe(img, { attributes: true, attributeFilter: ['src'] });
            });
            const twitched = () => animal.evaluate(img => img.__petLog.splice(0).some(src => src.includes('-twitch.webp')));
            if (phone) await animal.tap({ position: { x: 48, y: 25 } });
            else await animal.click({ position: { x: 48, y: 25 } });
            await expect.poll(twitched).toBe(true);
            await expect(animal).toHaveAttribute('src', original);
            for (const key of ['Enter', 'Space']) {
                await animal.press(key);
                await expect.poll(twitched).toBe(true);
                await expect(animal).toHaveAttribute('src', original);
            }
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await animal.press('Enter');
            await delay(300);
            expect(await twitched()).toBe(false);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
        }
        for (const menu of await page.locator('#sb_conversation_timeline .sb-conversation-more-actions').all()) {
            await menu.click();
            await expect(menu).toHaveAttribute('aria-expanded', 'true');
            await menu.click();
            await expect(menu).toHaveAttribute('aria-expanded', 'false');
            await menu.press('Enter');
            await expect(menu).toHaveAttribute('aria-expanded', 'true');
            await menu.press('Space');
            await expect(menu).toHaveAttribute('aria-expanded', 'false');
        }
    });
    for (const { control, textProfile } of ['Send', 'Enter', 'Ask for reply', 'Branch from here'].flatMap(control => [false, true].map(textProfile => ({ control, textProfile })))) {
        test(`${phone ? 'phone' : 'desktop'} ${textProfile ? 'saved text ' : ''}${control}: zero-page completion and repeat-safe reopening`, async ({ app, browser }, info) => {
            const account = await app.account({ phone, textProfile });
            const page = await account.open();
            app.provider.mode.hold = textProfile ? 'text-writer' : MODEL;
            const original = await account.branch('main');
            if (control === 'Ask for reply') await page.locator('#sb_conversation_toggle_tools').click();
            if (control === 'Branch from here') {
                const menu = page.locator('.sb-conversation-message[data-message-id="seed-user"] .sb-conversation-more-actions');
                const hit = await menu.evaluate(button => {
                    const rect = button.getBoundingClientRect();
                    return { width: rect.width, height: rect.height, reachable: [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.1], [0.5, 0.9]].every(([x, y]) =>
                        button.contains(document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y))) };
                });
                expect(hit).toEqual({ width: 44, height: 44, reachable: true });
                await menu.click();
            }
            const response = page.waitForResponse(response => response.url().endsWith('/reply/submit'));
            if (control === 'Send') {
                await page.locator('#sb_conversation_input').fill('Durable question.');
                await page.locator('#sb_conversation_send').click();
            } else if (control === 'Enter') {
                await page.locator('#sb_conversation_input').fill('Durable question.');
                await page.locator('#sb_conversation_input').press('Shift+Enter');
                expect(app.provider.calls).toHaveLength(0);
                await page.locator('#sb_conversation_input').press('Enter');
            } else if (control === 'Ask for reply') {
                await page.locator('[data-sb-conversation-action="force-response"]').click();
            } else {
                await page.locator('[data-sb-conversation-action="branch-from-message"]').click();
            }
            const acceptedResponse = await response;
            expect(acceptedResponse.ok(), await acceptedResponse.text()).toBe(true);
            const accepted = await acceptedResponse.json();
            if (['Send', 'Enter'].includes(control)) {
                expect(accepted.inputDurable).toBe(true);
                await expect(page.locator('#sb_conversation_input')).toHaveValue('');
            }
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
            if (textProfile) {
                expect(app.provider.calls[0].prompt).toContain('<user>');
                expect(app.provider.calls[0].prompt).toContain('<assistant>');
                expect(app.provider.calls[0].prompt).toContain('Original question.');
                expect(accepted.job.config.participantBindings[account.avatar].backend).toBe('text');
            }
            const geometry = await page.locator('#sb_conversation_send').evaluate(element => ({
                width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
                touch: navigator.maxTouchPoints, viewport: { width: innerWidth, height: innerHeight },
                overflow: document.documentElement.scrollWidth > innerWidth,
            }));
            await info.attach('geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
            expect(geometry.overflow).toBe(false);
            if (phone) {
                expect(geometry.touch).toBeGreaterThan(0);
                expect(geometry.width).toBeGreaterThanOrEqual(44);
                expect(geometry.height).toBeGreaterThanOrEqual(44);
            }
            await info.attach('before-closing', { body: await page.screenshot(), contentType: 'image/png' });
            await page.close();
            expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
            await app.release();
            await account.settled(accepted.job.id);
            const branch = await account.branch();
            expect(branch.messages.filter(message => message.role === 'character').map(message => message.mes)).toEqual(['Durable first reply.', 'Durable second reply.']);
            expect((await account.store()).reminders.filter(reminder => reminder.reason === 'Durable reminder' || reminder.message === 'Durable reminder' || reminder.text === 'Durable reminder')).toHaveLength(1);
            expect((await account.store()).runtimeStatusOverrides[`${account.personaId}\u001f${account.avatar}`]).toMatchObject({ status: 'dnd', activity: 'fixture rest' });
            if (control === 'Branch from here') {
                expect(branch.id).not.toBe('main');
                expect((await account.branch('main')).messages).toEqual(original.messages);
            }
            const reopened = await account.open();
            for (const message of branch.messages.filter(message => message.role === 'character')) {
                await expect(reopened.locator(`#sb_conversation_timeline .sb-conversation-message[data-message-id="${message.id}"]`)).toHaveCount(1);
            }
            expect((await account.branch()).messages).toEqual(branch.messages);
            expect(app.provider.calls).toHaveLength(1);
            await info.attach('after-reopening', { body: await reopened.screenshot(), contentType: 'image/png' });
            await info.attach('saved-branch', { body: JSON.stringify(branch), contentType: 'application/json' });
        });
    }
}

test('draft survives a lost accepted response and retries the identical submission', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    app.provider.mode.hold = MODEL;
    const submissions = [];
    let first;
    await page.route('**/reply/submit', async route => {
        submissions.push(route.request().postDataJSON());
        await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this draft.');
        const response = await route.fetch();
        expect(response.ok(), await response.text()).toBe(true);
        const accepted = await response.json();
        expect(accepted.inputDurable).toBe(true);
        expect((await account.branch()).messages.filter(message => accepted.userMessageIds.includes(message.id))).toHaveLength(1);
        if (!first) { first = accepted; await route.abort('failed'); }
        else { expect(accepted.job.id).toBe(first.job.id); await route.fulfill({ response }); }
    });
    await page.locator('#sb_conversation_input').fill('Keep this draft.');
    const lost = page.waitForEvent('requestfailed', request => request.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    await lost;
    await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this draft.');
    await expect(page.locator('#sb_conversation_send')).toBeEnabled();
    await page.locator('#sb_conversation_send').click();
    await expect(page.locator('#sb_conversation_input')).toHaveValue('');
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    await app.release();
    await account.settled(first.job.id);
    expect(app.provider.calls).toHaveLength(1);
    expect((await account.branch()).messages.filter(message => message.mes === 'Keep this draft.')).toHaveLength(1);
});

for (const boundary of ['solo chat', 'group chat', 'group metadata']) {
    test(`native aside ${boundary} save rejects a shared-browser account switch before writing`, async ({ app }) => {
        const first = await app.account({ settings: { roleplay_reactions: true } });
        await first.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
        const second = await app.account({ handle: 'second-user' });
        const group = boundary === 'solo chat' ? null : await first.post('/api/groups/create', {
            name: 'Private group', members: [first.avatar], conversation_settings: { enabled: true, roleplay_reactions: true },
        });
        const page = await first.open();
        const source = await page.evaluate(async ({ avatar, group }) => {
            const context = window.SillyTavern.getContext();
            const chrome = await import('/scripts/neconyan-conversation/chrome.js');
            chrome.setConversationInterfaceActive(false);
            if (group) {
                const groups = await import('/scripts/group-chats.js');
                await groups.getGroups();
                await groups.openGroupById(group.id);
            } else {
                await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
            }
            chrome.disableConversationModeForCurrentCharacter();
            if (group) {
                const conversation = await import('/scripts/neconyan-conversation/context.js');
                Object.assign(conversation.getConversationThreadStore(avatar, { groupId: group.id, create: true }).settings,
                    { enabled: true, roleplay_reactions: true, availability: 'online' });
            }
            window.SillyTavern.getContext().chat.push({ is_user: true, name: 'User', mes: 'Private aside source.', send_date: Date.now() });
            chrome.setConversationInterfaceActive(false);
            await (await import('/script.js')).saveChatConditional({ throwOnError: true });
            const aside = await import('/scripts/neconyan-conversation/auto-engine.js');
            const current = window.SillyTavern.getContext();
            const options = { sourceMessageId: current.chat.length - 1 };
            return { captured: group
                ? aside.captureGroupAsideRequest(current.characters.find(character => character.avatar === avatar), options)
                : aside.captureRoleplayDMRequest({ ...options, avatar }),
            settings: (await import('/scripts/neconyan-conversation/settings-store.js')).getSettings(avatar, { groupId: group?.id || '' }) };
        }, { avatar: first.avatar, group });
        expect(source.captured).not.toBeNull();
        expect(source.settings.enabled).toBe(true);
        expect(source.settings.roleplay_reactions).toBe(true);
        const destination = path.join(app.directory, 'data', 'second-user');
        const before = (await fs.readdir(destination, { recursive: true })).sort();
        const effects = await second.effects();
        const endpoint = boundary === 'solo chat' ? '/api/chats/save' : boundary === 'group chat' ? '/api/chats/group/save' : '/api/groups/edit';
        await page.route('**' + endpoint, async route => {
            expect(route.request().headers()['x-neconyan-account']).toBe('default-user');
            await first.post('/api/users/login', { handle: 'second-user', password: '' });
            await route.continue();
        });
        const response = page.waitForResponse(response => response.url().endsWith(endpoint));
        const triggered = page.evaluate(async ({ avatar, group }) => {
            const aside = await import('/scripts/neconyan-conversation/auto-engine.js');
            const context = window.SillyTavern.getContext();
            const options = { sourceMessageId: context.chat.length - 1 };
            return group
                ? aside.triggerGroupAsideDM(context.characters.find(character => character.avatar === avatar), options)
                : aside.triggerRoleplayDM({ ...options, avatar });
        }, { avatar: first.avatar, group });
        const rejected = await response;
        expect(rejected.status()).toBe(409);
        expect(await rejected.json()).toEqual({ error: 'account_changed' });
        expect(await triggered).toBe(false);
        expect((await fs.readdir(destination, { recursive: true })).sort()).toEqual(before);
        expect(await second.effects()).toEqual(effects);
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const boundary of ['preparing', 'generating']) {
    test(`HTTP cancellation while ${boundary} prevents late effects`, async ({ app }) => {
        const account = await app.account();
        const page = await account.open();
        app.provider.mode.hold = MODEL;
        const accepted = await send(page);
        if (boundary === 'generating') await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        else expect((await account.job(accepted.job.id)).stage).toBe('preparing');
        await account.post(`/api/jobs/${accepted.job.id}/cancel`);
        await page.close();
        await app.release();
        await account.settled(accepted.job.id, 'cancelled');
        const before = await account.effects();
        expect(before.branch.messages.filter(message => message.role === 'character')).toHaveLength(0);
        await noLateEffects(account, before);
        expect(app.provider.calls).toHaveLength(boundary === 'generating' ? 1 : 0);
    });
}

for (const action of ['cancel', 'restart']) {
    test(`partial delivery ${action} preserves committed effects without repeating the provider`, async ({ app, browser }) => {
        const account = await app.account({ settings: { reply_delay_multiplier: 300 } });
        const second = 'Remaining delivery. '.repeat(40).trim();
        app.provider.mode.reply.choices[0].message.content = `First. [reminder: 1h | First effect]\n\n${second} [reminder: 2h | Second effect]`;
        const page = await account.open();
        const accepted = await send(page);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await expect.poll(async () => (await account.store()).reminders.map(item => item.text), { timeout: 30000 }).toEqual(['First effect']);
        const before = await account.effects();
        expect(before.branch.messages.filter(item => item.role === 'character').map(item => item.mes)).toEqual(['First.']);
        const root = await account.job(accepted.job.id);
        expect((await account.job(root.children[0])).resume).toBe('delivery');
        if (action === 'cancel') {
            await account.post(`/api/jobs/${root.id}/cancel`);
            await account.settled(root.id, 'cancelled');
            await delay(11200);
            expect(await account.effects()).toEqual(before);
        } else {
            await app.restart();
            expect(app.processes[0].signal).toBe('SIGKILL');
            await account.settled(root.id);
            expect((await account.branch()).messages.filter(item => item.role === 'character').map(item => item.mes)).toEqual(['First.', second]);
            expect((await account.store()).reminders.map(item => item.text)).toEqual(['First effect', 'Second effect']);
        }
        const saved = await account.effects();
        await account.open();
        expect(await account.effects()).toEqual(saved);
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('a newer draft survives delayed acknowledgement of an older accepted draft', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let accepted;
    await page.route('**/reply/submit', async route => {
        const response = await route.fetch();
        accepted = await response.json();
        await gate;
        await route.fulfill({ response });
    });
    await page.locator('#sb_conversation_input').fill('Accepted old draft.');
    await page.locator('#sb_conversation_send').click();
    try {
        await expect.poll(() => accepted?.inputDurable).toBe(true);
        await expect(page.locator('#sb_conversation_input')).toHaveValue('Accepted old draft.');
        await page.locator('#sb_conversation_input').fill('New unsent draft.');
    } finally { release(); }
    await expect(page.locator('#sb_conversation_send')).toBeEnabled();
    await expect(page.locator('#sb_conversation_input')).toHaveValue('New unsent draft.');
    await account.settled(accepted.job.id);
    expect((await account.branch()).messages.filter(item => item.role === 'user').map(item => item.mes)).toEqual(['Original question.', 'Accepted old draft.']);
});

test('a missing saved binding rejects Send without consuming the draft', async ({ app }) => {
    const account = await app.account({ settings: { connection_profile: 'missing-profile' } });
    const page = await account.open();
    const before = await account.effects();
    await page.locator('#sb_conversation_input').fill('Do not lose this.');
    const response = page.waitForResponse(response => response.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    expect((await response).ok()).toBe(false);
    await expect(page.locator('#sb_conversation_send')).toBeEnabled();
    await expect(page.locator('#sb_conversation_input')).toHaveValue('Do not lose this.');
    expect(await account.effects()).toEqual(before);
    expect(app.provider.calls).toHaveLength(0);
});

test('failed store acknowledgement prevents submission and preserves the draft', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    let submissions = 0;
    page.on('request', request => { if (request.url().endsWith('/reply/submit')) submissions++; });
    await page.route('**/api/neconyan-conversation/store/save', route => route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }));
    await page.locator('#sb_conversation_input').fill('Keep after failed save.');
    const failed = page.waitForResponse(response => response.url().endsWith('/store/save') && response.status() === 503);
    await page.locator('#sb_conversation_send').click();
    await failed;
    await expect(page.locator('#sb_conversation_send')).toBeEnabled();
    await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep after failed save.');
    expect(submissions).toBe(0);
    expect(app.provider.calls).toHaveLength(0);
});

for (const change of ['edit', 'delete', 'replace branch', 'delete destination', 'append']) {
    test(`held generation ${change} respects the captured source and destination`, async ({ app }) => {
        const account = await app.account();
        const page = await account.open();
        app.provider.mode.hold = MODEL;
        const accepted = await send(page);
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        await account.changeStore(store => {
            const branch = store.characters[account.threadKey].branches.main;
            if (change === 'edit') branch.messages[0].mes = 'Edited source.';
            else if (change === 'delete') branch.messages.splice(0, 1);
            else if (change === 'replace branch') branch.createdAt = String(Date.now() + 1000);
            else if (change === 'delete destination') delete store.characters[account.threadKey];
            else branch.messages.push({ id: 'later-user', role: 'user', name: 'User', mes: 'Later append.', timestamp: Date.now() });
        });
        const before = await account.effects();
        await app.release();
        await account.settled(accepted.job.id, change === 'append' ? 'completed' : 'interrupted');
        if (change === 'append') {
            expect((await account.branch()).messages.filter(item => item.role === 'character')).toHaveLength(2);
            expect((await account.branch()).messages.some(item => item.id === 'later-user')).toBe(true);
        } else expect(await account.effects()).toEqual(before);
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('an unrelated save from a stale tab retains native replies and effect receipts', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    app.provider.mode.hold = MODEL;
    const accepted = await send(page);
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await page.close();
    const stale = await account.open();
    const snapshot = await account.post('/api/neconyan-conversation/store/get');
    await stale.route('**/api/neconyan-conversation/store/get', route => route.fulfill({ json: snapshot }));
    await app.release();
    await account.settled(accepted.job.id);
    const saved = await account.effects();
    const localMessages = await stale.evaluate(async key => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return extension_settings.sillybunny_conversation.characters[key].branches.main.messages;
    }, account.threadKey);
    expect(localMessages.some(item => item.role === 'character')).toBe(false);
    const request = stale.waitForRequest(request => request.url().endsWith('/api/settings/save'));
    const preference = await stale.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.confirm_message_delete = !power_user.confirm_message_delete;
        await (await import('/script.js')).saveSettings();
        return power_user.confirm_message_delete;
    });
    expect((await request).postDataJSON()._conversationOmitted).toBe(true);
    expect(JSON.parse((await account.post('/api/settings/get')).settings).power_user.confirm_message_delete).toBe(preference);
    expect(await account.effects()).toEqual(saved);
    await stale.unroute('**/api/neconyan-conversation/store/get');
    await stale.evaluate(async () => {
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        await sync.refreshConversationStore();
        if (!await sync.flushConversationStore()) throw new Error('Refresh/save failed');
    });
    expect(await account.effects()).toEqual(saved);
});

test('two real accounts isolate overlapping submission keys, prompts, results and cancellation', async ({ app }) => {
    const first = await app.account();
    await first.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
    const second = await app.account({ handle: 'second-user' });
    const a = await first.open();
    const b = await second.open();
    for (const page of [a, b]) {
        await page.route('**/reply/submit', route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), submissionKey: 'same-account-test-key' }) }));
    }
    app.provider.mode.hold = MODEL;
    const acceptedA = await send(a, 'Account A question.');
    const acceptedB = await send(b, 'Account B question.');
    expect(acceptedA.job.id).not.toBe(acceptedB.job.id);
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
    for (const [account, other] of [[first, acceptedB], [second, acceptedA]]) {
        const listed = await (await account.context.request.get('/api/jobs/list')).json();
        expect(listed.jobs.some(job => job.id === other.job.id)).toBe(false);
        for (const suffix of ['', '/result']) expect((await account.context.request.get(`/api/jobs/${other.job.id}${suffix}`)).status()).toBe(404);
        expect((await account.context.request.post(`/api/jobs/${other.job.id}/cancel`, { headers: account.headers, data: {} })).status()).toBe(404);
    }
    const prompts = app.provider.calls.map(call => JSON.stringify(call.messages));
    expect(prompts.filter(text => text.includes('Account A question.') && !text.includes('Account B question.'))).toHaveLength(1);
    expect(prompts.filter(text => text.includes('Account B question.') && !text.includes('Account A question.'))).toHaveLength(1);
    await first.post(`/api/jobs/${acceptedA.job.id}/cancel`);
    await a.close();
    await b.close();
    await app.release();
    await first.settled(acceptedA.job.id, 'cancelled');
    await second.settled(acceptedB.job.id);
    expect((await first.branch()).messages.filter(item => item.role === 'character')).toHaveLength(0);
    expect((await second.branch()).messages.filter(item => item.role === 'character')).toHaveLength(2);
});

test('attachment-only Send keeps its file until accepted and includes extracted text in the saved request', async ({ app }) => {
    const account = await app.account();
    const page = await account.open();
    const input = page.locator('#sb_conversation_file_input');
    await input.setInputFiles({ name: 'durable-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Exclusive attachment fixture text.') });
    let accepted;
    await page.route('**/reply/submit', async route => {
        expect(await input.evaluate(element => element.files.length)).toBe(1);
        const response = await route.fetch();
        accepted = await response.json();
        expect(accepted.inputDurable).toBe(true);
        expect(await input.evaluate(element => element.files.length)).toBe(1);
        await route.fulfill({ response });
    });
    await page.locator('#sb_conversation_send').click();
    await expect.poll(() => input.evaluate(element => element.files.length)).toBe(0);
    await page.close();
    await account.settled(accepted.job.id);
    expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Exclusive attachment fixture text.');
    const attachment = (await account.branch()).messages.find(item => accepted.userMessageIds.includes(item.id));
    expect(JSON.stringify(attachment.extra)).toContain('durable-note');
});

test('native image delivery saves a real image with zero pages and reopening does not regenerate it', async ({ app, browser }) => {
    const images = await app.images();
    const account = await app.account({ settings: { image_gen_enabled: true }, configureSettings(saved) {
        saved.extension_settings['quick-image-gen'] = { provider: 'local', localUrl: images.url.replace(/\/v1$/, ''),
            localType: 'stable-diffusion', a1111Model: 'nova.safetensors', sampler: 'euler_a' };
    } });
    app.provider.mode.reply.choices[0].message.content = 'Here you are. [selfie: context="A cheerful portrait"]';
    app.provider.mode.hold = MODEL;
    const page = await account.open();
    const accepted = await send(page, 'A cheerful greeting.');
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    await app.release();
    await account.settled(accepted.job.id);
    const messages = (await account.branch()).messages;
    const pictures = messages.filter(item => item.extra?.conversation_mode_image);
    expect(pictures).toHaveLength(1);
    const image = await account.context.request.get(pictures[0].extra.image_url);
    expect(image.ok()).toBe(true);
    expect((await image.body()).subarray(1, 4).toString()).toBe('PNG');
    const reopened = await account.open();
    const visible = reopened.locator(`.sb-conversation-message[data-message-id="${pictures[0].id}"] img`).filter({ visible: true });
    expect(await visible.evaluateAll(elements => elements.some(img => img.complete && img.naturalWidth === 1))).toBe(true);
    expect((await account.branch()).messages).toEqual(messages);
    expect(app.provider.calls).toHaveLength(1);
    expect(images.calls).toHaveLength(1);
});

for (const target of ['trigger', 'reply target']) {
    for (const change of ['edit', 'delete']) {
        test(`before acceptance ${change} of the ${target} refuses the captured request`, async ({ app }) => {
            const account = await app.account();
            if (target === 'reply target') await account.changeStore(store => {
                store.characters[account.threadKey].branches.main.messages.push({ id: 'reply-target', role: 'character', name: 'Durable Nova', mes: 'Reply to me.', timestamp: Date.now() });
            });
            const page = await account.open();
            if (target === 'trigger') await page.locator('#sb_conversation_toggle_tools').click();
            else {
                await page.locator('.sb-conversation-message[data-message-id="reply-target"] .sb-conversation-more-actions').click();
                await page.locator('[data-sb-conversation-action="reply-message"][data-message-id="reply-target"]').click();
                await page.locator('#sb_conversation_input').fill('Keep this targeted draft.');
            }
            let before;
            await page.route('**/reply/submit', async route => {
                await account.changeStore(store => {
                    const messages = store.characters[account.threadKey].branches.main.messages;
                    const index = messages.findIndex(item => item.id === (target === 'trigger' ? 'seed-user' : 'reply-target'));
                    if (change === 'edit') messages[index].mes = 'Edited before acceptance.';
                    else messages.splice(index, 1);
                });
                before = await account.effects();
                await route.continue();
            });
            const response = page.waitForResponse(response => response.url().endsWith('/reply/submit'));
            await page.locator(target === 'trigger' ? '[data-sb-conversation-action="force-response"]' : '#sb_conversation_send').click();
            expect((await response).status()).toBe(409);
            await expect(page.locator('#sb_conversation_send')).toBeEnabled();
            if (target === 'reply target') await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this targeted draft.');
            expect(await account.effects()).toEqual(before);
            expect(app.provider.calls).toHaveLength(0);
        });
    }
}

test('startup retains the settings owner when the shared browser changes account before profile loading', async ({ app }) => {
    const first = await app.account();
    await first.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
    const second = await app.account({ handle: 'second-user' });
    const beforeA = await first.post('/api/neconyan-conversation/store/get');
    const beforeB = await second.post('/api/neconyan-conversation/store/get');
    expect(beforeA.version).toBe(beforeB.version);
    const page = await first.context.newPage();
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        expect((await response.json()).inChatAgentAccount).toBe('default-user');
        await first.post('/api/users/login', { handle: 'second-user', password: '' });
        await route.fulfill({ response });
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/user.js')).getCurrentUserHandle())).toBe('second-user');
    const outcomes = await page.evaluate(async () => {
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        return Promise.all([sync.flushConversationStore, sync.refreshConversationStore].map(async operation => {
            try { await operation(); return 'accepted'; } catch (error) { return error.message; }
        }));
    });
    expect(outcomes).toEqual(['account_changed', 'account_changed']);
    expect(await second.post('/api/neconyan-conversation/store/get')).toEqual(beforeB);
    await page.close();
    await first.post('/api/users/login', { handle: 'default-user', password: '' });
    expect(await first.post('/api/neconyan-conversation/store/get')).toEqual(beforeA);
    expect(app.provider.calls).toHaveLength(0);
});

test('a stale page cannot submit into another account after its shared browser signs in again', async ({ app }) => {
    const first = await app.account();
    await first.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
    const second = await app.account({ handle: 'second-user' });
    const page = await first.open();
    const original = await first.store();
    await second.changeStore(store => { store.characters = structuredClone(original.characters); });
    const before = await second.effects();
    const jobsBefore = await (await second.context.request.get('/api/jobs/list')).json();
    await page.route('**/reply/submit', async route => {
        expect(route.request().headers()['x-neconyan-account']).toBe('default-user');
        await first.post('/api/users/login', { handle: 'second-user', password: '' });
        await route.continue();
    });
    app.provider.mode.hold = MODEL;
    await page.locator('#sb_conversation_input').fill('Private account A draft.');
    const response = page.waitForResponse(response => response.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    const rejected = await response;
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error).toBe('account_changed');
    await expect(page.locator('#sb_conversation_send')).toBeEnabled();
    await expect(page.locator('#sb_conversation_input')).toHaveValue('Private account A draft.');
    expect(await second.effects()).toEqual(before);
    const failures = await page.evaluate(async () => {
        const jobs = await import('/scripts/jobs.js');
        const outcomes = [];
        for (const call of [() => jobs.listJobs(), () => jobs.getJob('missing'), () => jobs.cancelJob('missing')]) {
            try { await call(); outcomes.push('accepted'); }
            catch (error) { outcomes.push({ status: error.status, message: error.message }); }
        }
        return outcomes;
    });
    expect(failures).toEqual(Array(3).fill({ status: 409, message: 'account_changed' }));
    await page.evaluate(() => document.getElementById('account_button').click());
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/user.js')).getCurrentUserHandle())).toBe('second-user');
    const storeFailures = await page.evaluate(async () => {
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        const outcomes = [];
        for (const operation of [sync.flushConversationStore, sync.refreshConversationStore]) {
            try { await operation(); outcomes.push('accepted'); }
            catch (error) { outcomes.push(error.message); }
        }
        return outcomes;
    });
    expect(storeFailures).toEqual(['account_changed', 'account_changed']);
    expect(await second.effects()).toEqual(before);
    expect(await (await second.context.request.get('/api/jobs/list')).json()).toEqual(jobsBefore);
    expect(app.provider.calls).toHaveLength(0);
});

for (const media of [false, true]) {
    test(`${media ? 'image' : 'text'} attachment upload rejects a shared-browser account switch before writing`, async ({ app }) => {
        const first = await app.account();
        await first.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
        const second = await app.account({ handle: 'second-user' });
        const page = await first.open();
        const destination = path.join(app.directory, 'data', 'second-user');
        const before = (await fs.readdir(destination, { recursive: true })).sort();
        const endpoint = media ? '/api/images/upload' : '/api/files/upload';
        await page.route('**' + endpoint, async route => {
            expect(route.request().headers()['x-neconyan-account']).toBe('default-user');
            await first.post('/api/users/login', { handle: 'second-user', password: '' });
            await route.continue();
        });
        await page.locator('#sb_conversation_input').fill('Private attachment draft.');
        await page.locator('#sb_conversation_file_input').setInputFiles({
            name: media ? 'private.png' : 'private.txt', mimeType: media ? 'image/png' : 'text/plain',
            buffer: media ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64') : Buffer.from('Private account A file'),
        });
        const response = page.waitForResponse(response => response.url().endsWith(endpoint));
        await page.locator('#sb_conversation_send').click();
        const rejected = await response;
        expect(rejected.status()).toBe(409);
        expect(await rejected.json()).toEqual({ error: 'account_changed' });
        await expect(page.locator('#sb_conversation_send')).toBeEnabled();
        await expect(page.locator('#sb_conversation_input')).toHaveValue('Private attachment draft.');
        expect(await page.locator('#sb_conversation_file_input').evaluate(input => input.files.length)).toBe(1);
        expect((await fs.readdir(destination, { recursive: true })).sort()).toEqual(before);
        expect((await second.branch()).messages).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const boundary of ['preparing', 'generating']) {
    test(`real process restart while ${boundary} preserves accepted work without repeating an uncertain call`, async ({ app, browser }) => {
        const account = await app.account();
        const page = await account.open();
        app.provider.mode.hold = MODEL;
        const accepted = await send(page);
        if (boundary === 'generating') await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.restart();
        expect(app.processes).toHaveLength(2);
        expect(app.processes[0].signal).toBe('SIGKILL');
        expect(app.processes[1].pid).not.toBe(app.processes[0].pid);
        await app.release();
        await account.settled(accepted.job.id, boundary === 'generating' ? 'interrupted' : 'completed');
        expect(app.provider.calls).toHaveLength(1);
        const branch = await account.branch();
        expect(branch.messages.filter(message => message.mes === 'Durable question.')).toHaveLength(1);
        expect(branch.messages.filter(message => message.role === 'character')).toHaveLength(boundary === 'generating' ? 0 : 2);
        await account.open();
        expect((await account.branch()).messages).toEqual(branch.messages);
        expect(app.provider.calls).toHaveLength(1);
    });
}
