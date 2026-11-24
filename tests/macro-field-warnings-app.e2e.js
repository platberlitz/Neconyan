/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { openPersonaEditor } from './chat-scroll-regression-helpers.js';
import { EXPECTED_TRUE_POSITIVES, auditMacroTexts, bundledMacroTexts } from './macro-field-audit-texts.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const TYPO = 'Nova waves at {{chra}} and {{user';
const FIXED = 'Nova waves at {{char}} and {{user}}.';
const SETTLE_MS = 450;

function configureSettings(saved) {
    saved.firstRun = false;
    saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanAssistantSeed.v1': 'done' };
    const prompts = [
        { identifier: 'umw-typo', name: 'Typo prompt', role: 'system', system_prompt: false, content: 'Speak to {{chra}} about {{user', injection_position: 0 },
        { identifier: 'umw-clean', name: 'Clean prompt', role: 'system', system_prompt: false, content: 'Speak to {{char}} about {{user}}.', injection_position: 0 },
    ];
    const settings = saved.oai_settings;
    settings.prompts = [...prompts, ...settings.prompts.filter(prompt => !prompts.some(item => item.identifier === prompt.identifier))];
    for (const entry of settings.prompt_order ?? []) {
        entry.order = [...prompts.map(({ identifier }) => ({ identifier, enabled: true })), ...entry.order];
    }
}

async function openAccount(app, phone, { lorebook = false } = {}) {
    const account = await app.account({ phone, configureSettings });
    await account.context.addInitScript(() => {
        window.addEventListener('neconyan:ready', () => { window.macroWarningsAppReady = true; }, { once: true });
    });
    if (lorebook) {
        await account.post('/api/worldinfo/edit', { name: 'Macro notes', data: { entries: {
            0: { uid: 0, key: ['lamp'], keysecondary: [], content: 'The lamp glows for {{chra}} and {{user', comment: 'Typo entry',
                constant: false, selective: true, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true, addMemo: true },
            1: { uid: 1, key: ['door'], keysecondary: [], content: 'The door opens for {{char}}.', comment: 'Clean entry',
                constant: false, selective: true, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true, addMemo: true },
        } } });
    }
    const page = await account.open({ workspace: false });
    await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
    await page.waitForFunction(() => window.macroWarningsAppReady === true);
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/macro-field-warnings.js')).macroFieldWarningsStarted())).toBe(true);
    await page.evaluate(() => window.toastr?.remove());
    return { account, page };
}

/** Visible text of the warning linked to a field, or '' when there is none. */
function warningText(field) {
    return field.evaluate(node => {
        const id = (node.getAttribute('aria-describedby') || '').split(/\s+/).find(token => token.startsWith('nn-macro-warning-'));
        const warning = id ? document.getElementById(id) : null;
        if (!warning || !warning.getClientRects().length) return '';
        return warning.textContent.replace(/\s+/g, ' ').trim();
    });
}

async function expectTypoWarning(field) {
    await expect.poll(() => warningText(field)).toContain('Unknown macro: {{chra}}');
    const text = await warningText(field);
    expect(text).toContain('Unclosed macro: {{user');
    const warning = await field.evaluate(node => {
        const id = node.getAttribute('aria-describedby').split(/\s+/).find(token => token.startsWith('nn-macro-warning-'));
        const element = document.getElementById(id);
        const box = element.getBoundingClientRect();
        return { role: element.getAttribute('role'), live: element.getAttribute('aria-live'), right: box.right, left: box.left,
            fieldBottom: node.getBoundingClientRect().bottom, top: box.top,
            overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(warning).toMatchObject({ role: 'status', live: 'polite' });
    expect(warning.left).toBeGreaterThanOrEqual(-1);
    expect(warning.right).toBeLessThanOrEqual(await field.page().evaluate(() => window.innerWidth) + 1);
    expect(warning.top).toBeGreaterThanOrEqual(warning.fieldBottom - 1);
    expect(warning.overflow).toBeLessThanOrEqual(0);
}

async function expectNoWarning(field) {
    await field.page().waitForTimeout(SETTLE_MS);
    expect(await warningText(field)).toBe('');
    expect(await field.getAttribute('aria-describedby') ?? '').not.toMatch(/nn-macro-warning-/);
}

async function selectCharacter(page, avatar) {
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === target));
    }, avatar);
}

async function openCharacterEditor(page, avatar, name) {
    await selectCharacter(page, avatar);
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        window.macroWarningsEditorOpened = new Promise(resolve => context.eventSource.once(context.eventTypes.CHARACTER_EDITOR_OPENED, resolve));
    });
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await page.evaluate(() => window.macroWarningsEditorOpened);
    await expect(page.locator('#character_name_pole')).toHaveValue(name);
}

/** Geometry of the field and the next visible element below it. */
function belowGeometry(field) {
    return field.evaluate(node => {
        let next = node.nextElementSibling;
        while (next && !next.getClientRects().length) next = next.nextElementSibling;
        let anchor = node;
        while (!next && anchor.parentElement) {
            anchor = anchor.parentElement;
            next = anchor.nextElementSibling;
            while (next && !next.getClientRects().length) next = next.nextElementSibling;
        }
        const round = box => box && [box.x, box.y, box.width, box.height].map(value => Math.round(value));
        return { field: round(node.getBoundingClientRect()), next: round(next?.getBoundingClientRect()) };
    });
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`character card warns, clears on fix, expanded editor and character switch (${viewport})`, async ({ app }) => {
        const { account, page } = await openAccount(app, phone);
        const created = await account.context.request.post(`${app.url}/api/characters/create`, { headers: account.headers,
            data: { ch_name: 'Clean Pip', description: 'Pip greets {{user}} warmly.', first_mes: 'Hi.' } });
        expect(created.ok()).toBe(true);
        const cleanAvatar = (await created.text()).trim();

        await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);
        await openCharacterEditor(page, account.avatar, 'Durable Nova');
        const description = page.locator('#description_textarea');
        await expect(description).toBeVisible();
        await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);

        const clean = await belowGeometry(description);
        await description.fill('Nova greets {{user}} with {{random::a wave::a nod}}.');
        await expectNoWarning(description);
        expect(await belowGeometry(description)).toEqual(clean);

        await description.fill(TYPO);
        await expectTypoWarning(description);
        await description.fill(FIXED);
        await expect.poll(() => warningText(description)).toBe('');
        expect(await belowGeometry(description)).toEqual(clean);

        await description.fill(TYPO);
        await expectTypoWarning(description);
        await page.evaluate(() => document.querySelector('.editor_maximize[data-for="description_textarea"]').click());
        const expanded = page.locator('dialog[open] .maximized_textarea');
        await expect(expanded).toBeVisible();
        await expectTypoWarning(expanded);
        await expanded.fill(FIXED);
        await expect.poll(() => warningText(expanded)).toBe('');
        await expect.poll(() => warningText(description)).toBe('');
        await page.locator('dialog[open]:has(.maximized_textarea) .popup-button-ok').click();
        await expect(expanded).toHaveCount(0);

        await description.fill(TYPO);
        await expectTypoWarning(description);
        await page.evaluate(async () => (await import('/script.js')).flushCharacterSaveDebounced());
        await selectCharacter(page, cleanAvatar);
        await expect(page.locator('#character_name_pole')).toHaveValue('Clean Pip');
        await expect(description).toHaveValue('Pip greets {{user}} warmly.');
        await expect.poll(() => warningText(description)).toBe('');
        await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);
    });

    test(`persona, Author's Note and chat overrides warn and clear (${viewport})`, async ({ app }) => {
        const { account, page } = await openAccount(app, phone);
        await selectCharacter(page, account.avatar);

        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'persona'));
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'persona');
        await openPersonaEditor(page);
        const persona = page.locator('#persona_description');
        await expect(persona).toBeVisible();
        await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);
        await persona.fill(TYPO);
        await expectTypoWarning(persona);
        await persona.fill('I am {{user}}.');
        await expect.poll(() => warningText(persona)).toBe('');

        await page.evaluate(async () => (await import('/scripts/authors-note.js')).openAuthorsNotePanel('chat'));
        const note = page.locator('#extension_floating_prompt');
        await expect(note).toBeVisible();
        await note.fill(TYPO);
        await expectTypoWarning(note);
        await note.fill('[{{char}} keeps an eye on {{user}}]');
        await expect.poll(() => warningText(note)).toBe('');

        await page.evaluate(() => { void import('/script.js').then(core => core.setCharacterSettingsOverrides()); });
        const scenario = page.locator('dialog[open] #chat_scenario_override');
        await expect(scenario).toBeVisible();
        await expect(page.locator('dialog[open] .nn-macro-field-warning')).toHaveCount(0);
        await scenario.fill(TYPO);
        await expectTypoWarning(scenario);
        await scenario.fill('{{char}} and {{user}} meet.');
        await expect.poll(() => warningText(scenario)).toBe('');
        const system = page.locator('dialog[open] #chat_system_prompt_override');
        await system.fill('Write as {{chra}}.');
        await expect.poll(() => warningText(system)).toContain('Unknown macro: {{chra}}');
    });

    test(`lorebook entry, prompt entry, story string and Agents editor (${viewport})`, async ({ app }) => {
        const { page } = await openAccount(app, phone, { lorebook: true });

        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        await page.locator('.neconyan-lorebook-book-open').filter({ hasText: 'Macro notes' }).click();
        const openEntry = uid => page.locator(`#world_popup_entries_list .world_entry[uid="${uid}"] .inline-drawer-toggle`).first().click();
        await openEntry(0);
        const typoEntry = page.locator('#world_entry_content_0');
        await expect(typoEntry).toBeVisible();
        await expect(typoEntry).toHaveValue('The lamp glows for {{chra}} and {{user');
        await expectTypoWarning(typoEntry);
        await openEntry(1);
        const cleanEntry = page.locator('#world_entry_content_1');
        await expect(cleanEntry).toBeVisible();
        await expect(cleanEntry).toHaveValue('The door opens for {{char}}.');
        await expectNoWarning(cleanEntry);
        // Phones keep earlier entries open in the list; desktop shows one entry editor at a time.
        if (!await typoEntry.isVisible()) await openEntry(0);
        await expect(typoEntry).toBeVisible();
        await expectTypoWarning(typoEntry);
        await typoEntry.fill('The lamp glows for {{char}} and {{user}}.');
        await expect.poll(() => warningText(typoEntry)).toBe('');
        await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);

        await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
        await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
        const loadPrompt = id => page.evaluate(async identifier => {
            const { promptManager } = await import('/scripts/openai.js');
            promptManager.selectedPromptId = identifier;
            promptManager.loadPromptIntoEditForm(promptManager.getPromptById(identifier));
            promptManager.showPopup('edit');
        }, id);
        const prompt = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
        await loadPrompt('umw-typo');
        await expect(prompt).toBeVisible();
        await expect(prompt).toHaveValue('Speak to {{chra}} about {{user');
        await expectTypoWarning(prompt);
        await loadPrompt('umw-clean');
        await expect(prompt).toHaveValue('Speak to {{char}} about {{user}}.');
        await expect.poll(() => warningText(prompt)).toBe('');
        await loadPrompt('umw-typo');
        await expectTypoWarning(prompt);
        await prompt.fill('Speak to {{char}} about {{user}}.');
        await expect.poll(() => warningText(prompt)).toBe('');

        const story = page.locator('#context_story_string');
        // The story string belongs to Text Completion; the fixture starts on Chat Completion.
        await page.evaluate(() => window.$('#main_api').val('textgenerationwebui').trigger('change'));
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'advanced-formatting'));
        await expect(story).toBeAttached();
        if (!await story.isVisible()) {
            await page.evaluate(() => { document.querySelector('#context_story_string').closest('.inline-drawer-content')?.style.setProperty('display', 'block'); });
        }
        await expect(story).toBeVisible();
        const storyString = '{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#each mesExamplesRaw}}{{this}}{{/each}}'
            + '{{#unless persona}}none{{else}}{{persona}}{{/unless}}{{trim}}';
        await story.fill(storyString);
        await expectNoWarning(story);
        await story.fill('{{#if wiBefre}}{{wiBefre}}{{/if}}');
        await expect.poll(() => warningText(story)).toContain('Unknown macro: {{wiBefre}}');
        await story.fill(storyString);
        await expect.poll(() => warningText(story)).toBe('');

        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await page.waitForSelector('#ica--addAgent', { state: 'visible' });
        await page.evaluate(() => document.getElementById('ica--addAgent').click());
        const agentPrompt = page.locator('#ica--editor #ica--editor-prompt');
        await expect(agentPrompt).toBeAttached();
        await agentPrompt.scrollIntoViewIfNeeded();
        await expect(agentPrompt).toBeVisible();
        await agentPrompt.fill('Read {{lastMessage}} from {{assistantName}} with {{active-lore}}, {{tracker-state}} and {{full-mewmory}} for {{char}}.');
        await expectNoWarning(agentPrompt);
        await agentPrompt.fill('Read {{lastMesage}} for {{char}}.');
        await expect.poll(() => warningText(agentPrompt)).toContain('Unknown macro: {{lastMesage}}');
    });
}

test('bundled presets, cards and Agent templates raise no warnings against the live macro list', async ({ app }) => {
    const { page } = await openAccount(app, false);
    const texts = bundledMacroTexts();
    const { results, registrySize } = await page.evaluate(async items => {
        const { macroFieldProblems } = await import('/scripts/macro-field-warnings.js');
        const { MacroRegistry } = await import('/scripts/macros/engine/MacroRegistry.js');
        const knownNames = MacroRegistry.getAllMacros().map(definition => definition.name);
        return {
            registrySize: knownNames.length,
            results: items.map(({ text, dialect }) => macroFieldProblems(text, { knownNames, dialect })),
        };
    }, texts);
    const { findings, counts } = auditMacroTexts(texts, () => results.shift());
    console.log(`Live macro list: ${registrySize} names`);
    for (const [category, count] of Object.entries(counts)) {
        console.log(`${category}: ${count.texts} texts, ${count.withMacros} with macros, ${count.warned} warned`);
    }
    expect(registrySize).toBeGreaterThan(200);
    expect(findings).toEqual([...EXPECTED_TRUE_POSITIVES].sort());
});
