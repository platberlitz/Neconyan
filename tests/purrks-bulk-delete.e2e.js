/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-standalone-expect -- Helpers assert their own saved data and control measurements. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { normalizeCharacterPurrks } from '../src/purrks.js';
import { contrastRatio } from '../public/scripts/theme-contrast.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellSource = await fs.readFile(path.join(root, 'public/scripts/neconyan-tabs.js'), 'utf8');
const shells = [...shellSource.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
const initialPurrks = normalizeCharacterPurrks({
    enabled: true,
    autoSceneProfileId: 'durable',
    items: [
        { id: 'voices', label: 'Two distinct voices', prompt: 'Keep each speaker recognisable through their own vocabulary and rhythm.', mode: 'always', placement: 'system' },
        { id: 'rain', label: 'Rain cloak', prompt: 'Reach for the oilskin cloak when rain starts.', mode: 'keyword', keywords: ['rain'], enabled: false },
        { id: 'banter', label: 'Roommate banter', prompt: 'Let familiar disagreements show years of shared history.', mode: 'always' },
        { id: 'quiet', label: 'Quiet moments', prompt: 'Leave room for comfortable pauses.', mode: 'manual' },
    ],
});

async function openEditor(page, avatar, name = 'Durable Nova') {
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        window.NeconyanShell.openTab('characters', 'characters');
    }, avatar);
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    const panel = await page.locator('#character_purrks_block').evaluate(node => node.closest('[data-sb-character-editor-panel]').dataset.sbCharacterEditorPanel);
    await page.locator(`[data-sb-character-editor-tab="${panel}"]`).click();
    const block = page.locator('#character_purrks_block');
    await expect(block).toBeVisible();
    await block.evaluate(node => node.scrollIntoView({ block: 'start' }));
    return block;
}

async function screenshot(page, phone, phase, info) {
    await page.evaluate(() => document.fonts.ready);
    const directory = path.join(root, 'screenshots');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `purrks-bulk-delete-${phone ? 'phone' : 'desktop'}-${phase}.png`);
    await page.screenshot({ path: file });
    await info.attach(`Purrks ${phase}`, { path: file, contentType: 'image/png' });
}

async function seedPurrks(account, avatar = account.avatar) {
    const response = await account.context.request.post('/api/characters/merge-attributes', {
        headers: account.headers,
        data: { avatar, data: { extensions: { neconyan_purrks: initialPurrks } } },
    });
    expect(response.ok()).toBe(true);
}

async function savedPurrks(account, avatar = account.avatar) {
    const character = await account.post('/api/characters/get', { avatar_url: avatar });
    return character.data.extensions.neconyan_purrks;
}

async function checkBulkControlContrast(page, selector, phone) {
    const results = [];
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        for (const profile of [null, 'Mint Glass', 'Plum Wine']) {
            // eslint-disable-next-line playwright/no-force-option -- The theme selector lives in a different settings panel.
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
            for (const shell of shells) {
                await page.evaluate(shell => {
                    document.documentElement.dataset.sbTheme = shell;
                    if (shell === 'kittyless') document.documentElement.dataset.sbKittyless = 'true';
                    else delete document.documentElement.dataset.sbKittyless;
                }, shell);
                const controls = await page.locator(selector).evaluateAll(elements => elements.map(element => {
                    const context = document.createElement('canvas').getContext('2d');
                    const rgb = colour => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data];
                    };
                    const composite = (over, under) => over.slice(0, 3).map((channel, index) => Math.round(channel * over[3] / 255 + under[index] * (1 - over[3] / 255)));
                    const ancestors = [];
                    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
                    let backdrop = [255, 255, 255];
                    for (const parent of ancestors) backdrop = composite(rgb(getComputedStyle(parent).backgroundColor), backdrop);
                    const style = getComputedStyle(element);
                    const base = composite(rgb(style.backgroundColor), backdrop);
                    const brightness = Number(style.filter.match(/brightness\(([\d.]+)\)/)?.[1] || 1);
                    const filtered = channels => channels.slice(0, 3).map(channel => Math.min(255, Math.round(channel * brightness)));
                    const image = style.backgroundClip === 'padding-box, border-box'
                        ? style.backgroundImage.split(/, (?=linear-gradient)/)[0] : style.backgroundImage;
                    const stops = image.match(/(?:rgba?|color)\([^)]+\)/g) || [];
                    return {
                        label: element.textContent, height: element.getBoundingClientRect().height,
                        ink: filtered(rgb(style.color)), stops: stops.length ? stops.map(stop => filtered(composite(rgb(stop), base))) : [filtered(base)],
                    };
                }));
                for (const control of controls) {
                    const ratio = Math.min(...control.stops.map(stop => contrastRatio(control.ink, stop)));
                    const result = { theme, profile, shell, ratio, ...control };
                    results.push(result);
                    expect(ratio, JSON.stringify(result)).toBeGreaterThanOrEqual(4.5);
                    expect(control.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
                }
            }
        }
    }
    await page.evaluate(() => {
        document.documentElement.dataset.sbTheme = 'calico';
        delete document.documentElement.dataset.sbKittyless;
    });
    // eslint-disable-next-line playwright/no-force-option -- Restore the theme without leaving the Purrks editor.
    await page.locator('#themes').selectOption({ label: 'Neconyan Calico Dark' }, { force: true });
    return results;
}

for (const phone of [true, false]) {
    test(`Purrks bulk deletion keeps unselected items on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(120000);
        const account = await app.account({ phone });
        await seedPurrks(account);
        const page = await account.open({ workspace: false, timeout: 60000 });
        const block = await openEditor(page, account.avatar);
        await expect(block.locator('.neconyan-purrk-card')).toHaveCount(4);
        const writes = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/characters/merge-attributes')) writes.push(request.postDataJSON());
        });
        const before = await savedPurrks(account);
        const bulkDelete = block.getByRole('button', { name: 'Bulk Delete', exact: true });
        const remove = block.getByRole('button', { name: /^Delete selected/ });
        const selectAll = block.getByRole('button', { name: 'Select all', exact: true });
        const cancel = block.getByRole('button', { name: 'Cancel', exact: true });
        await screenshot(page, phone, 'after', info);
        await bulkDelete.click();
        await expect(remove).toHaveText('Delete selected (0)');
        await expect(remove).toBeDisabled();
        await expect(selectAll).toBeFocused();
        const rain = block.getByRole('checkbox', { name: 'Select Rain cloak for deletion' });
        await rain.check();
        await expect(remove).toHaveText('Delete selected (1)');
        await expect(rain).toBeFocused();
        await cancel.click();
        await expect(bulkDelete).toBeFocused();
        await expect(block.getByRole('checkbox', { name: 'Enable Rain cloak', exact: true })).not.toBeChecked();
        expect(await savedPurrks(account)).toEqual(before);
        expect(writes).toHaveLength(0);

        await bulkDelete.click();
        await expect(remove).toBeDisabled();
        await selectAll.click();
        await expect(remove).toHaveText('Delete selected (4)');
        await expect(block.locator('input:checked')).toHaveCount(4);
        await block.getByRole('button', { name: 'Clear selection', exact: true }).click();
        await expect(block.locator('input:checked')).toHaveCount(0);
        await expect(remove).toBeDisabled();
        await selectAll.click();
        await block.getByRole('checkbox', { name: 'Select Two distinct voices for deletion' }).uncheck();
        await block.getByRole('button', { name: 'Quiet moments', exact: true }).click();
        await expect(remove).toHaveText('Delete selected (2)');
        await block.evaluate(node => node.scrollIntoView({ block: 'start' }));
        await screenshot(page, phone, 'selection', info);
        const geometry = await block.locator('.neconyan-purrks-toolbar button, .neconyan-purrk-toggle, .neconyan-purrk-label-btn').evaluateAll(nodes => nodes.map(node => {
            const bounds = node.getBoundingClientRect();
            return { name: node.getAttribute('aria-label') || node.textContent, height: bounds.height, left: bounds.left, right: bounds.right, viewport: window.innerWidth };
        }));
        await info.attach('selection geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        for (const control of geometry) {
            expect(control.left).toBeGreaterThanOrEqual(0);
            expect(control.right).toBeLessThanOrEqual(control.viewport);
            expect(control.height).toBeGreaterThanOrEqual(phone ? 44 : 16);
        }

        await remove.click();
        const confirmation = page.locator('dialog[open]').filter({ hasText: 'Delete the 2 selected Purrks?' });
        await confirmation.locator('.popup-button-cancel').click();
        await expect(remove).toHaveText('Delete selected (2)');
        expect(await savedPurrks(account)).toEqual(before);
        expect(writes).toHaveLength(0);
        await remove.click();
        await confirmation.locator('.popup-button-ok').click();
        await expect(block.locator('.neconyan-purrk-card')).toHaveCount(2);
        const expected = { ...before, items: before.items.filter(item => ['voices', 'quiet'].includes(item.id)) };
        await expect.poll(() => savedPurrks(account)).toEqual(expected);
        expect(writes).toHaveLength(1);
        await page.reload();
        await openEditor(page, account.avatar);
        await expect(block.locator('.neconyan-purrk-label-btn')).toHaveText(['Two distinct voices', 'Quiet moments']);

        await block.getByRole('button', { name: 'Edit Quiet moments', exact: true }).click();
        await block.getByLabel('Prompt directive', { exact: true }).fill('Keep the comfortable pauses.');
        await block.getByLabel('Prompt directive', { exact: true }).blur();
        await expect.poll(async () => (await savedPurrks(account)).items[1].prompt).toBe('Keep the comfortable pauses.');
        expect((await savedPurrks(account)).items[0]).toEqual(before.items[0]);
        await bulkDelete.click();
        await selectAll.click();
        await remove.click();
        await confirmation.locator('.popup-button-ok').click();
        await expect(bulkDelete).toBeDisabled();
        await expect(block.locator('.neconyan-purrks-empty')).toBeVisible();
        await expect.poll(async () => (await savedPurrks(account)).items).toEqual([]);
    });

    test(`Purrks bulk controls stay readable on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await app.account({ phone });
        await seedPurrks(account);
        const page = await account.open({ workspace: false, timeout: 60000 });
        const block = await openEditor(page, account.avatar);
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
        for (const shell of shells.filter(shell => shell !== 'calico')) await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
        await page.addStyleTag({ url: '/css/neconyan-kittyless.css' });
        const entry = await checkBulkControlContrast(page, '#character_purrks_bulk_delete_btn', phone);
        await block.getByRole('button', { name: 'Bulk Delete', exact: true }).click();
        await block.getByRole('button', { name: 'Select all', exact: true }).click();
        const selection = await checkBulkControlContrast(page, '#character_purrks_block .neconyan-purrks-toolbar button', phone);
        await info.attach('bulk button contrast', { body: JSON.stringify({ entry, selection }), contentType: 'application/json' });
        expect(entry).toHaveLength(shells.length * 6);
        expect(selection).toHaveLength(shells.length * 6 * 3);
    });
}

test('Purrks selection stays with its editor and also works before saving a new character', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    await seedPurrks(account);
    const created = await account.context.request.post('/api/characters/create', {
        headers: account.headers, data: { ch_name: 'Other Nova', first_mes: 'Hello.' },
    });
    expect(created.ok()).toBe(true);
    const otherAvatar = await created.text();
    await seedPurrks(account, otherAvatar);
    const page = await account.open({ workspace: false, timeout: 60000 });
    const block = await openEditor(page, account.avatar);
    const bulkDelete = block.getByRole('button', { name: 'Bulk Delete', exact: true });
    const remove = block.getByRole('button', { name: /^Delete selected/ });
    await bulkDelete.click();
    await block.getByRole('checkbox', { name: 'Select Rain cloak for deletion' }).check();
    await remove.click();
    const confirmation = page.locator('dialog[open]').filter({ hasText: 'Delete the selected Purrk?' });
    await expect(confirmation).toBeVisible();
    // An asynchronous character switch must invalidate an already open confirmation, even when IDs match.
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
    }, otherAvatar);
    await confirmation.locator('.popup-button-ok').click();
    await openEditor(page, otherAvatar, 'Other Nova');
    await expect(block.locator('.neconyan-purrk-card')).toHaveCount(4);
    expect(await savedPurrks(account)).toEqual(initialPurrks);
    expect(await savedPurrks(account, otherAvatar)).toEqual(initialPurrks);
    await bulkDelete.click();
    await expect(remove).toBeDisabled();
    await block.getByRole('checkbox', { name: 'Select Rain cloak for deletion' }).check();
    await remove.click();
    // Reopening the same editor also ends its previous selection session.
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        await eventSource.emit(event_types.CHARACTER_EDITOR_OPENED);
    });
    await confirmation.locator('.popup-button-ok').click();
    await expect(bulkDelete).toBeVisible();
    expect(await savedPurrks(account, otherAvatar)).toEqual(initialPurrks);

    await page.locator('#rm_button_back').click();
    await page.locator('#rm_button_create').click();
    await page.getByRole('tab', { name: 'Basics', exact: true }).click();
    await page.locator('#character_name_pole').fill('Draft Nova');
    const panel = await block.evaluate(node => node.closest('[data-sb-character-editor-panel]').dataset.sbCharacterEditorPanel);
    await page.locator(`[data-sb-character-editor-tab="${panel}"]`).click();
    await expect(bulkDelete).toBeDisabled();
    await block.getByRole('button', { name: '+ Add Purrk', exact: true }).click();
    await block.getByLabel('Label', { exact: true }).fill('Draft first');
    await block.getByLabel('Label', { exact: true }).blur();
    await block.getByRole('button', { name: '+ Add Purrk', exact: true }).click();
    await block.getByLabel('Label', { exact: true }).last().fill('Draft second');
    await block.getByLabel('Label', { exact: true }).last().blur();
    await bulkDelete.click();
    await block.getByRole('checkbox', { name: 'Select Draft first for deletion' }).check();
    await remove.click();
    await confirmation.locator('.popup-button-ok').click();
    await expect(block.locator('.neconyan-purrk-label-btn')).toHaveText(['Draft second']);
    expect(await page.evaluate(async () => (await import('/script.js')).create_save.extensions.neconyan_purrks.items.map(item => item.label))).toEqual(['Draft second']);
    await page.locator('#create_button_label').click();
    await expect.poll(async () => {
        const characters = await account.post('/api/characters/all', {});
        const draft = characters.find(character => character.name === 'Draft Nova');
        return draft ? (await savedPurrks(account, draft.avatar)).items.map(item => item.label) : null;
    }).toEqual(['Draft second']);
});
