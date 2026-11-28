/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const firstName = 'Writing preset';
const secondName = 'Review preset';
const thirdName = 'Reading preset';
const addedName = 'Writing notes';
const addedContent = 'Notes for the writing preset.';
const firstEdit = { name: 'Writing instructions', content: 'Instructions for the writing preset.' };
const secondEdit = { name: 'Review instructions', content: 'Instructions for the review preset.' };
const savedPrompt = { identifier: 'review-style', name: 'Saved review style', content: 'Keep the review concise.', role: 'system', system_prompt: false };
const savedOrder = [{ identifier: 'review-style', enabled: true }, { identifier: 'nsfw', enabled: false }];
const editor = '#completion_prompt_manager_popup_entry_form_';
const rows = '#completion_prompt_manager_list > li[data-pm-identifier]:not([data-pm-runtime])';

async function openPrompts(account) {
    const page = await account.open({ workspace: false });
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), wizard => wizard.getByRole('button', { name: 'Skip', exact: true }).click());
    await page.evaluate(async avatar => {
        const { eventSource, event_types, selectCharacterById } = await import('/script.js');
        window.completedPromptPresetChanges = [];
        eventSource.on(event_types.PRESET_CHANGED, ({ apiId, name }) => {
            if (apiId === 'openai') window.completedPromptPresetChanges.push(name);
        });
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        window.NeconyanShell.openTab('left', 'presets');
    }, account.avatar);
    const invitation = page.getByRole('button', { name: 'Not now', exact: true });
    await page.addLocatorHandler(invitation, button => button.click());
    await showPrompts(page);
    return page;
}

async function showPrompts(page) {
    await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New prompt', exact: true })).toBeVisible();
}

async function snapshot(page) {
    return page.evaluate(async () => {
        const { promptManager } = await import('/scripts/openai.js');
        const { chatCompletionDefaultPrompts } = await import('/scripts/PromptManager.js');
        return {
            active: promptManager.serviceSettings.prompts,
            canonical: chatCompletionDefaultPrompts.prompts,
            order: promptManager.getPromptOrderForCharacter(promptManager.activeCharacter),
            preset: promptManager.serviceSettings.preset_settings_openai,
            changing: promptManager.isPresetChanging,
            completed: window.completedPromptPresetChanges,
        };
    });
}

async function savePrompt(page, { name, content }) {
    await page.locator(editor + 'name').fill(name);
    await page.locator(editor + 'prompt').fill(content);
    await page.locator(editor + 'save').click();
}

async function editDefault(page, values) {
    await page.locator(`${rows}[data-pm-identifier="nsfw"] .prompt-manager-edit-action`).click();
    await expect(page.locator(editor + 'save')).toHaveAttribute('data-pm-prompt', 'nsfw');
    await savePrompt(page, values);
    await expect(page.locator(`${rows}[data-pm-identifier="nsfw"] [data-pm-name]`)).toHaveText(values.name);
}

async function waitForPreset(page, name, completedCount) {
    await expect.poll(async () => {
        const { completed, preset, changing } = await snapshot(page);
        return { completedName: completed[completedCount], preset, changing };
    }, { message: `${name} finished applying its settings` }).toEqual({ completedName: name, preset: name, changing: false });
}

async function choosePreset(page, name) {
    const { completed } = await snapshot(page);
    await page.locator('#sb-openai-preset-picker-button').click();
    await page.locator('#sb-openai-preset-picker').getByTitle(name, { exact: true }).click();
    await waitForPreset(page, name, completed.length);
}

async function captureRows(page, viewport) {
    const destination = process.env.NECONYAN_PROMPT_DEFAULTS_SCREENSHOTS;
    if (!destination) return;
    await fs.mkdir(destination, { recursive: true });
    await expect(page.locator('#toast-container')).toBeHidden({ timeout: 15000 });
    const defaultRow = page.locator(`${rows}[data-pm-identifier="nsfw"]`);
    await defaultRow.evaluate(row => row.scrollIntoView({ block: 'nearest' }));
    await expect(defaultRow).toBeInViewport({ ratio: 0.95 });
    await page.screenshot({ path: path.join(destination, `${viewport}.png`) });
}

for (const { initial, phone } of [{ initial: 'missing', phone: true }, { initial: 'empty', phone: false }]) {
    test(`${initial} account prompts stay independent of other presets`, async ({ app }) => {
        let independentPreset;
        const account = await app.account({ phone, activeConnection: true, configureSettings(settings) {
            independentPreset = { ...structuredClone(settings.oai_settings), prompts: [savedPrompt], prompt_order: [{ character_id: 100001, order: savedOrder }] };
            if (initial === 'empty') settings.oai_settings.prompts = [];
            else delete settings.oai_settings.prompts;
        } });
        await account.post('/api/presets/save', { apiId: 'openai', name: secondName, preset: independentPreset });
        await account.post('/api/presets/save', { apiId: 'openai', name: thirdName, preset: independentPreset });
        const accountSettings = JSON.parse((await account.post('/api/settings/get')).settings).oai_settings;
        expect(accountSettings.prompts).toEqual(initial === 'empty' ? [] : undefined);

        const page = await openPrompts(account);
        const before = await snapshot(page);
        const builtIn = before.canonical.find(prompt => prompt.identifier === 'nsfw');
        expect(before.active).toEqual(before.canonical);
        expect(before.preset).toBe(accountSettings.preset_settings_openai);
        expect(builtIn.name).toBe('Auxiliary Prompt');

        await page.getByRole('button', { name: 'New prompt', exact: true }).click();
        await savePrompt(page, { name: addedName, content: addedContent });
        await expect(page.locator(`${rows} [data-pm-name="${addedName}"]`)).toHaveText(addedName);
        await editDefault(page, firstEdit);
        const edited = await snapshot(page);
        const added = edited.active.find(prompt => prompt.name === addedName);
        expect(added).toMatchObject({ identifier: expect.any(String), content: addedContent });
        expect(edited.active.find(prompt => prompt.identifier === 'nsfw')).toMatchObject(firstEdit);
        expect(edited.completed).toEqual([]);
        // Keep exercising persistence and capture the second preset even when this reproduces the leak.
        expect.soft(edited.canonical.map(prompt => prompt.identifier), 'the catalogue gets no added prompt').toEqual(before.canonical.map(prompt => prompt.identifier));
        expect.soft(edited.canonical.find(prompt => prompt.identifier === 'nsfw'), 'the catalogue keeps its original default').toEqual(builtIn);

        await page.locator('#new_oai_preset').click();
        const dialog = page.locator('dialog[open]').filter({ hasText: 'Preset name:' });
        await dialog.locator('.popup-input').fill(firstName);
        await dialog.locator('.popup-button-ok').click();
        await waitForPreset(page, firstName, edited.completed.length);

        await choosePreset(page, secondName);
        await showPrompts(page);
        await expect(page.locator(`${rows}[data-pm-identifier="review-style"] [data-pm-name]`)).toHaveText(savedPrompt.name);
        await expect(page.locator(rows)).toHaveCount(savedOrder.length);
        const second = await snapshot(page);
        expect(second.active.find(prompt => prompt.identifier === savedPrompt.identifier)).toEqual(savedPrompt);
        expect(second.order).toEqual(savedOrder);
        expect(await page.locator(rows).evaluateAll(elements => elements.map(row => ({
            identifier: row.dataset.pmIdentifier,
            enabled: !row.classList.contains('completion_prompt_manager_prompt_disabled'),
        })))).toEqual(savedOrder);
        await captureRows(page, phone ? 'phone' : 'desktop');
        expect.soft(second.active.some(prompt => prompt.identifier === added.identifier), 'the second preset does not inherit the added prompt').toBe(false);
        expect.soft(second.active.find(prompt => prompt.identifier === 'nsfw'), 'the second preset backfills the untouched default').toEqual(builtIn);
        await expect.soft(page.locator(`${rows}[data-pm-identifier="nsfw"] [data-pm-name]`)).toHaveText(builtIn.name);

        await editDefault(page, secondEdit);
        const secondEdited = await snapshot(page);
        expect(secondEdited.active.find(prompt => prompt.identifier === 'nsfw')).toMatchObject(secondEdit);
        expect.soft(secondEdited.canonical, 'the second edit leaves the catalogue pristine').toEqual(before.canonical);

        await choosePreset(page, thirdName);
        const third = await snapshot(page);
        expect.soft(third.active.find(prompt => prompt.identifier === 'nsfw'), 'a later hydration also gets the untouched default').toEqual(builtIn);
        await expect.soft(page.locator(`${rows}[data-pm-identifier="nsfw"] [data-pm-name]`)).toHaveText(builtIn.name);

        await choosePreset(page, firstName);
        await expect(page.locator(`${rows}[data-pm-identifier="${added.identifier}"] [data-pm-name]`)).toHaveText(addedName);
        await expect(page.locator(`${rows}[data-pm-identifier="nsfw"] [data-pm-name]`)).toHaveText(firstEdit.name);
        const reselected = await snapshot(page);
        expect(reselected.active.find(prompt => prompt.identifier === added.identifier)).toMatchObject({ name: addedName, content: addedContent });
        expect(reselected.active.find(prompt => prompt.identifier === 'nsfw')).toMatchObject(firstEdit);
    });
}
