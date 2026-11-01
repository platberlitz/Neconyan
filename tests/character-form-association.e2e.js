/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function openEditor(page, avatar) {
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === target));
        window.NeconyanShell.openTab('characters', 'characters');
    }, avatar);
    await page.getByRole('button', { name: 'Edit Durable Nova', exact: true }).click();
    await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
    await expect(page.locator('#character_name_pole')).toHaveValue('Durable Nova');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushCharacterSaveDebounced())).toBe(true);
}

async function installObserver(context) {
    await context.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.associationEdits = [];
        window.fetch = function (input, init) {
            const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
            if (url.pathname !== '/api/characters/edit') return original(input, init);
            const body = init?.body;
            const entry = { names: body instanceof FormData ? body.getAll('ch_name').map(String) : null,
                avatar: body instanceof FormData ? String(body.get('avatar_url') ?? '') : null, status: null, invalidName: false };
            window.associationEdits.push(entry);
            const promise = original(input, init);
            void promise.then(response => {
                entry.status = response.status;
                if (response.status === 400) void response.clone().text().then(text => { entry.invalidName = /invalid name/i.test(text); }).catch(() => {});
            }).catch(() => {});
            return promise;
        };
    });
}

async function moveName(page, mode = 'valid') {
    await page.evaluate(mode => {
        const node = document.querySelector('#character_name_pole');
        window.associationRestore = { node, parent: node.parentNode, next: node.nextSibling, value: node.value,
            disabled: node.disabled, form: node.getAttribute('form') };
        const container = document.createElement('div');
        container.id = 'association-test-container';
        document.body.append(container);
        container.append(node);
        if (mode === 'empty') node.value = '';
        if (mode === 'dot') node.value = '.';
        if (mode === 'disabled') node.disabled = true;
    }, mode);
}

async function restoreName(page) {
    await page.evaluate(() => {
        const saved = window.associationRestore;
        if (!saved) return;
        saved.parent.insertBefore(saved.node, saved.next);
        saved.node.value = saved.value;
        saved.node.disabled = saved.disabled;
        if (saved.form === null) saved.node.removeAttribute('form'); else saved.node.setAttribute('form', saved.form);
        document.getElementById('association-test-container')?.remove();
        delete window.associationRestore;
    });
}

async function formState(page) {
    return page.evaluate(() => {
        const name = document.querySelector('#character_name_pole');
        const form = document.querySelector('#form_create');
        return { outside: !form.contains(name), owner: name.form?.id ?? null, names: new FormData(form).getAll('ch_name').map(String), value: name.value };
    });
}

async function edits(page) { return page.evaluate(() => structuredClone(window.associationEdits)); }
async function cardBytes(app, avatar) { return fs.readFile(path.join(app.dataRoot, 'default-user', 'characters', avatar)); }

for (const phone of [false, true]) {
    test(`moved valid character name saves to its own card on ${phone ? 'touch phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, activeConnection: true });
        await installObserver(account.context);
        const otherResponse = await account.context.request.post('/api/characters/create', { headers: account.headers,
            data: { ch_name: 'Association Other', description: 'Other card.', first_mes: 'Hello.' } });
        expect(otherResponse.ok()).toBe(true);
        const other = await otherResponse.text();
        const page = await account.open({ workspace: false });
        await page.evaluate(async () => (await import('/script.js')).getCharacters());
        await openEditor(page, account.avatar);
        const otherBefore = await cardBytes(app, other);
        try {
            await moveName(page);
            expect(await formState(page)).toEqual({ outside: true, owner: 'form_create', names: ['Durable Nova'], value: 'Durable Nova' });
            const before = (await edits(page)).length;
            await page.locator('#description_textarea').fill('Association regression marker.');
            await page.locator('#create_button_label').click();
            await expect.poll(async () => (await edits(page)).slice(before).some(item => item.avatar === account.avatar && item.status === 200)).toBe(true);
            const relevant = (await edits(page)).slice(before).filter(item => item.avatar === account.avatar);
            expect(relevant).toHaveLength(1);
            expect(relevant[0].names).toEqual(['Durable Nova']);
            await expect(page.locator('#sb_character_save_status')).toHaveAttribute('data-save-status', 'saved');
            const saved = await account.post('/api/characters/get', { avatar_url: account.avatar });
            expect(saved.data.name).toBe('Durable Nova');
            expect(saved.data.description).toBe('Association regression marker.');
            expect(await cardBytes(app, other)).toEqual(otherBefore);
            await restoreName(page);
            await page.evaluate(async avatar => {
                const context = window.SillyTavern.getContext();
                await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
            }, other);
            await expect.poll(() => page.evaluate(async () => {
                const core = await import('/script.js');
                return core.characters[core.this_chid]?.avatar;
            })).toBe(other);
            await expect(page.locator('#character_name_pole')).toHaveValue('Association Other');
            await expect.poll(() => page.evaluate(() => String(new FormData(document.querySelector('#form_create')).get('avatar_url')))).toBe(other);
            await expect(page.locator('#toast-container .toast').filter({ hasText: 'Could not save the character.' })).toHaveCount(0);
        } finally { await restoreName(page); }
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const mode of ['empty', 'dot', 'disabled']) {
    test(`moved ${mode} character name remains refused and recovers`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ activeConnection: true });
        await installObserver(account.context);
        const page = await account.open({ workspace: false });
        await openEditor(page, account.avatar);
        const beforeBytes = await cardBytes(app, account.avatar);
        try {
            await moveName(page, mode);
            const state = await formState(page);
            expect(state.outside).toBe(true);
            expect(state.owner).toBe('form_create');
            expect(state.names).toEqual(mode === 'disabled' ? [] : [mode === 'dot' ? '.' : '']);
            const before = (await edits(page)).length;
            await page.locator('#create_button_label').click();
            await expect.poll(async () => (await edits(page)).slice(before).some(item => item.avatar === account.avatar && item.status === 400 && item.invalidName)).toBe(true);
            const rejection = (await edits(page)).slice(before).find(item => item.avatar === account.avatar && item.status === 400 && item.invalidName);
            expect(rejection.names).toEqual(state.names);
            expect(await cardBytes(app, account.avatar)).toEqual(beforeBytes);
            expect((await formState(page)).value).toBe(state.value);
        } finally {
            await restoreName(page);
            await page.locator('#create_button_label').click();
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushCharacterSaveDebounced())).toBe(true);
            await page.evaluate(() => window.NeconyanShell.closeCharacters());
            const previousChat = await page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
            await page.locator('#options_button').click();
            await page.locator('#option_start_new_chat').click();
            const dialog = page.locator('dialog[open]').filter({ hasText: 'Start new chat?' });
            await expect(dialog).toBeVisible();
            await dialog.locator('.popup-button-ok').click();
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).getCurrentChatId())).not.toBe(previousChat);
        }
        expect(app.provider.calls).toHaveLength(0);
    });
}
