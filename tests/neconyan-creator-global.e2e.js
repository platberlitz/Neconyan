/* global localStorage */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

const preferences = {
    style: 'custom',
    writing: {
        prompts: { director: 'Account director.', grounded: 'Account grounded prose.', macros: 'Account macro guidance.' },
        connection: { profile: 'durable', fallbacks: ['durable'], maxTokens: 2048, prefill: 'Account prefill.', partialPrefill: '', stream: true },
        targets: { characterWords: '500', greetingWords: '200', greetingCount: '2', tense: 'present', pov: 'third' },
        nsfw: { enabled: true, instruction: 'Account optional guidance.', fetishes: '' },
        formatInstruction: 'Account custom format.', plistDestination: 'depth_prompt',
        askQuestionsFirst: true, dossierFields: ['description', 'personality'],
        userInstructions: 'Account custom instructions.', mode: 'custom', custom: 'Account prose rules.',
    },
    portraitGuidelines: 'Account watercolour guidelines.', portraitSupportsNegative: true, creator: 'Account author',
};

function privateDraft(id, name) {
    const draft = createCreatorDraft({ id, card: {
        spec: 'chara_card_v3', spec_version: '3.0',
        data: { name, creator: 'Old draft author', description: `${name} description.`,
            system_prompt: `${name} public system prompt.`, extensions: { retained: { custom: 'untouched' } } },
    } });
    Object.assign(draft, { dossier: `${name} private dossier.`, privateNotes: `${name} private notes.`,
        portraitPrompt: `${name} portrait.`, portraitNegativePrompt: `${name} negative portrait.`,
        portraitGuidelines: 'Old draft guidelines.', portraitSupportsNegative: true, style: 'alichat',
        writing: { prompts: { grounded: 'Old draft grounded prose.' }, userInstructions: 'Old draft instructions.',
            connection: { stream: true }, nsfw: { enabled: true }, askQuestionsFirst: true, privateRequest: `${name} private request.` } });
    return draft;
}

async function openCatelier(page) {
    await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
    await page.locator('#sb_character_tab_creator').click();
    return page.locator('#sb_character_creator_panel');
}

async function currentDraft(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem('neconyan.creator.recovery:default-user')).draft);
}

async function savedPreferences(account) {
    return JSON.parse((await account.post('/api/settings/get')).settings).extension_settings.neconyan_creator;
}

function sharedValues(draft) {
    return { style: draft.style, writing: Object.fromEntries(Object.keys(preferences.writing).map(key => [key, draft.writing[key]])),
        portraitGuidelines: draft.portraitGuidelines, portraitSupportsNegative: draft.portraitSupportsNegative, creator: draft.card.data.creator };
}

for (const phone of [true, false]) {
    test(`Catelier shares account settings without sharing private draft content on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings.neconyan_creator = structuredClone(preferences);
        } });
        const oldDraft = privateDraft('legacy-mira', 'Legacy Mira');
        const response = await account.context.request.post('/api/creator/save', {
            headers: { ...account.headers, 'X-Neconyan-Account': 'default-user' }, data: { draft: oldDraft, expectedRevision: null },
        });
        expect(response.ok(), await response.text()).toBe(true);
        const page = await account.open({ workspace: false });
        let creator = await openCatelier(page);
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await expect(creator.getByLabel('Display name', { exact: true })).toBeVisible();
        expect(sharedValues(await currentDraft(page))).toEqual(preferences);
        await creator.getByLabel('Display name', { exact: true }).fill('New Mira');
        await creator.getByLabel('Description', { exact: true }).fill('Only the new draft description.');
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await expect(creator.getByLabel('Stream live output', { exact: true })).toBeChecked();
        await creator.getByLabel('Stream live output', { exact: true }).uncheck();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('');
        await creator.getByLabel('Prefill', { exact: true }).fill('');
        await creator.getByLabel('Description & personality words', { exact: true }).fill('');
        await creator.getByRole('button', { name: 'Off', exact: true }).click();
        await creator.getByLabel('Director prompt', { exact: true }).fill('');
        await creator.getByLabel('Grounded prose prompt', { exact: true }).fill('');
        const instructions = creator.getByLabel('Custom user instructions', { exact: true });
        await expect(instructions).toHaveValue(preferences.writing.userInstructions);
        expect(await instructions.evaluate(node => node.closest('.creator-field').previousElementSibling.querySelector('label')?.textContent)).toBe('Grounded prose prompt');
        await instructions.fill('');
        await creator.getByRole('button', { name: 'Writing partner', exact: true }).click();
        await expect(creator.getByLabel('Ask questions first', { exact: true })).toBeChecked();
        await creator.getByLabel('Ask questions first', { exact: true }).uncheck();
        await creator.getByLabel('My prose rules', { exact: true }).fill('');
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        await creator.getByLabel('Image prompt guidelines (optional)', { exact: true }).fill('');
        await expect(creator.getByLabel('Image provider supports negative prompts', { exact: true })).toBeChecked();
        await creator.getByLabel('Image provider supports negative prompts', { exact: true }).uncheck();
        await creator.getByRole('button', { name: 'Details', exact: true }).click();
        await creator.getByLabel('Creator', { exact: true }).fill('Shared current author');
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByRole('radio', { name: 'Natural description', exact: true }).check();

        const expected = structuredClone(preferences);
        expected.style = 'plain';
        Object.assign(expected.writing.connection, { stream: false, profile: '', prefill: '' });
        expected.writing.targets.characterWords = '';
        expected.writing.nsfw.enabled = false;
        Object.assign(expected.writing.prompts, { director: '', grounded: '' });
        Object.assign(expected.writing, { userInstructions: '', askQuestionsFirst: false, custom: '' });
        Object.assign(expected, { portraitGuidelines: '', portraitSupportsNegative: false, creator: 'Shared current author' });
        await expect.poll(() => savedPreferences(account), { timeout: 20000 }).toEqual(expected);
        await creator.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(creator.getByLabel('Description', { exact: true })).toHaveValue('');
        expect(sharedValues(await currentDraft(page))).toEqual(expected);
        await creator.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(creator.getByLabel('Description', { exact: true })).toHaveValue('Only the new draft description.');
        expect(sharedValues(await currentDraft(page))).toEqual(expected);

        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        await creator.locator('.creator-draft-list').getByRole('button', { name: 'Legacy Mira', exact: true }).click();
        await expect(creator.getByLabel('Display name', { exact: true })).toHaveValue('Legacy Mira');
        const opened = await currentDraft(page);
        expect(sharedValues(opened)).toEqual(expected);
        expect(opened.dossier).toBe(oldDraft.dossier);
        expect(opened.privateNotes).toBe(oldDraft.privateNotes);
        expect(opened.portraitPrompt).toBe(oldDraft.portraitPrompt);
        expect(opened.portraitNegativePrompt).toBe(oldDraft.portraitNegativePrompt);
        expect(opened.writing.privateRequest).toBe(oldDraft.writing.privateRequest);
        await expect(creator.getByLabel('Description', { exact: true })).toHaveValue(oldDraft.card.data.description);
        await creator.getByRole('button', { name: 'Prompts', exact: true }).click();
        await expect(creator.getByLabel('Custom user instructions', { exact: true })).toHaveCount(0);
        await expect(creator.getByLabel('Main prompt', { exact: true })).toHaveValue(oldDraft.card.data.system_prompt);
        await creator.getByRole('button', { name: 'Server requests', exact: true }).click();
        await expect(creator.locator('[data-creator-server-requests]')).toBeVisible();
        await expect(creator.getByRole('button', { name: 'Server requests', exact: true })).toHaveAttribute('aria-expanded', 'true');
        await creator.getByRole('button', { name: 'Server requests', exact: true }).click();
        await expect(creator.locator('[data-creator-server-requests]')).toHaveCount(0);
        await expect(creator.getByRole('button', { name: 'Server requests', exact: true })).toHaveAttribute('aria-expanded', 'false');

        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const restoredSource = privateDraft('backup-jun', 'Backup Jun');
        await creator.getByText('Restore a private draft backup', { exact: true }).locator('..').locator('input').setInputFiles({
            name: 'private-backup.json', mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ format: 'neconyan-creator-backup', version: 1, draft: restoredSource })),
        });
        await expect(creator.getByRole('heading', { name: 'Backup Jun', exact: true })).toBeVisible();
        const restored = await currentDraft(page);
        expect(restored.id).not.toBe(restoredSource.id);
        expect(sharedValues(restored)).toEqual(expected);
        expect(restored.dossier).toBe(restoredSource.dossier);
        expect(restored.privateNotes).toBe(restoredSource.privateNotes);
        expect(restored.writing.privateRequest).toBe(restoredSource.writing.privateRequest);
        await creator.getByRole('button', { name: 'Preview & export', exact: true }).click();
        const downloadEvent = page.waitForEvent('download');
        await creator.getByRole('button', { name: 'Download character JSON', exact: true }).click();
        const download = await downloadEvent;
        const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
        expect(exported.spec).toBe('chara_card_v3');
        expect(exported.data.creator).toBe('Shared current author');
        expect(exported.data.extensions.retained).toEqual({ custom: 'untouched' });
        expect(JSON.stringify(exported)).not.toContain('private');
        expect(JSON.stringify(exported)).not.toContain('Account director.');
        expect(JSON.stringify(await savedPreferences(account))).not.toContain('private');

        await page.reload();
        creator = await openCatelier(page);
        await creator.getByRole('button', { name: 'Recover Backup Jun', exact: true }).click();
        expect(sharedValues(await currentDraft(page))).toEqual(expected);
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await expect(creator.getByLabel('Stream live output', { exact: true })).not.toBeChecked();
        await expect(creator.getByLabel('Grounded prose prompt', { exact: true })).toHaveValue('');
        await expect(creator.getByLabel('Custom user instructions', { exact: true })).toHaveValue('');
        await expect(creator.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await expect(creator.getByLabel('Display name', { exact: true })).toHaveValue('');
        const fresh = await currentDraft(page);
        expect(sharedValues(fresh)).toEqual(expected);
        expect(fresh.card.data.description).toBe('');
        expect(fresh.dossier).toBe('');
        expect(fresh.privateNotes).toBe('');
        expect(fresh.portraitPrompt).toBeUndefined();
        expect(fresh.writing.privateRequest).toBeUndefined();
    });

    test(`Catelier shares the creator chosen in a library comparison on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings.neconyan_creator = structuredClone(preferences);
        } });
        const draft = privateDraft('compare-mira', 'Compare Mira');
        Object.assign(draft.source, { avatar: account.avatar, revision: 'original-library-revision' });
        const response = await account.context.request.post('/api/creator/save', {
            headers: { ...account.headers, 'X-Neconyan-Account': 'default-user' }, data: { draft, expectedRevision: null },
        });
        expect(response.ok(), await response.text()).toBe(true);
        const remoteCard = structuredClone(draft.card);
        remoteCard.data.creator = 'Creator chosen from library';
        const page = await account.open({ workspace: false });
        await page.route('**/api/creator/character', route => route.fulfill({ json: {
            owner: 'default-user', avatar: account.avatar, revision: 'changed-library-revision', card: remoteCard, extraBooks: [],
        } }));
        const creator = await openCatelier(page);
        await creator.locator('.creator-draft-list').getByRole('button', { name: 'Compare Mira', exact: true }).click();
        await creator.getByRole('button', { name: 'Details', exact: true }).click();
        await expect(creator.getByLabel('Creator', { exact: true })).toHaveValue(preferences.creator);
        await creator.getByRole('button', { name: 'Review & save', exact: true }).click();
        await creator.getByRole('button', { name: 'Compare with library', exact: true }).click();
        const conflict = creator.locator('.creator-review-item').filter({ has: page.getByRole('heading', { name: 'data / creator', exact: true }) });
        await conflict.getByRole('radio', { name: 'Keep library', exact: true }).check();
        await creator.getByRole('button', { name: 'Apply comparison to draft', exact: true }).click();
        await expect(creator.getByLabel('Creator', { exact: true })).toHaveValue(remoteCard.data.creator);
        await expect.poll(async () => (await savedPreferences(account)).creator, { timeout: 20000 }).toBe(remoteCard.data.creator);
        await creator.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(creator.getByLabel('Creator', { exact: true })).toHaveValue(remoteCard.data.creator);
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Details', exact: true }).click();
        await expect(creator.getByLabel('Creator', { exact: true })).toHaveValue(remoteCard.data.creator);
        expect((await currentDraft(page)).privateNotes).toBe('');
    });
}
