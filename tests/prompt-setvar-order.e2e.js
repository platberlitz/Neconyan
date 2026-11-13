/* global window, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

function configureSettings(settings) {
    const prompts = [
        { identifier: 'main', role: 'system', system_prompt: true, content: 'Main fixture instruction' },
        { identifier: 'chatHistory', marker: true, system_prompt: true },
        { identifier: 'fixture-formatting', name: 'Formatting', role: 'system', system_prompt: false,
            content: 'Formatting: [{{getvar::writefor}}] [{{getvar::length}}]', injection_position: 1, injection_depth: 1 },
        { identifier: 'fixture-write-for-user', role: 'system', system_prompt: false,
            content: '{{setvar::writefor::Write for every character}}', injection_position: 0 },
        { identifier: 'fixture-length', role: 'system', system_prompt: false,
            content: '{{setvar::length::Any length}}', injection_position: 0 },
    ];
    const remaining = settings.oai_settings.prompts.filter(prompt => !prompts.some(item => item.identifier === prompt.identifier));
    Object.assign(settings.oai_settings, { prompts: [...prompts, ...remaining], prompt_order: [{ character_id: 100001,
        order: [...['main', 'fixture-formatting', 'chatHistory', 'fixture-write-for-user', 'fixture-length']
            .map(identifier => ({ identifier, enabled: true })),
        ...remaining.map(({ identifier }) => ({ identifier, enabled: false }))] }],
    squash_system_messages: false, new_chat_prompt: '', names_behavior: -1, send_if_empty: '',
    custom_prompt_post_processing: '' });
    settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
}

test('the first reply reads setvar toggles placed below the prompt that uses them', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        const id = context.characters.findIndex(character => character.avatar === avatar);
        if (id < 0 || !await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Fixture character unavailable');
        delete context.chatMetadata.variables;
    }, account.avatar);
    const dryRun = await page.evaluate(async () => {
        const { prepareOpenAIMessages } = await import('/scripts/openai.js');
        const [messages] = await prepareOpenAIMessages({ name2: 'Fixture', charDescription: '', charPersonality: '', scenario: '',
            worldInfoBefore: '', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {},
            messages: [{ role: 'user', content: 'Dry-run question' }], messageExamples: [] }, true);
        return { messages, variables: window.SillyTavern.getContext().chatMetadata.variables };
    });
    expect(dryRun.messages.map(message => message.content)).toContain('Formatting: [Write for every character] [Any length]');
    expect(dryRun.variables).toBeUndefined();
    await page.locator('#send_textarea').fill('Fixture setvar question');
    await page.locator('#send_but').click();
    await expect.poll(() => app.provider.calls.filter(call => call.messages?.some(message => message.content === 'Fixture setvar question')).length,
        { timeout: 60000 }).toBe(1);
    const messages = app.provider.calls.find(call => call.messages?.some(message => message.content === 'Fixture setvar question')).messages;
    expect(messages.map(message => message.content)).toContain('Formatting: [Write for every character] [Any length]');
});

for (const phone of [false, true]) {
    test(`Formatting previews later setters without saving variables (${phone ? 'phone' : 'desktop'})`, async ({ app }) => {
        const account = await app.account({ activeConnection: true, phone,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings });
        if (phone) await installIPhoneSafari(account.context, { standalone: false });
        const page = await account.open({ workspace: false });
        await page.evaluate(async () => {
            window.NeconyanShell.openTab('left', 'presets');
        });
        await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
        await page.evaluate(async () => {
            const { promptManager } = await import('/scripts/openai.js');
            const context = window.SillyTavern.getContext();
            delete context.chatMetadata.variables;
            promptManager.selectedPromptId = 'fixture-formatting';
            promptManager.loadPromptIntoEditForm(promptManager.getPromptById('fixture-formatting'));
            promptManager.showPopup('edit');
        });
        await page.locator('.completion_prompt_manager_tab_button[data-tab="preview"]').click();
        if (phone) await applyIOSOnlyCss(page);
        const preview = page.locator('#completion_prompt_manager_preview_text');
        await expect(preview).toBeVisible();
        await expect(page.locator('#completion_prompt_manager_preview_token_count')).toHaveText(/^\d+$/);
        if (process.env.NECONYAN_PREVIEW_SCREENSHOTS) {
            await page.screenshot({ path: `../screenshots/prompt-variables-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_PREVIEW_SCREENSHOTS}.png` });
        }
        await expect(preview).toHaveText('Formatting: [Write for every character] [Any length]');
        const layout = await preview.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, bottom: bounds.bottom, whiteSpace: getComputedStyle(element).whiteSpace };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(page.viewportSize().width);
        expect(layout.bottom).toBeLessThanOrEqual(page.viewportSize().height);
        expect(layout.whiteSpace).toBe('pre-wrap');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables)).toBeUndefined();

        // Reopening and editing use a fresh snapshot and the unsaved form text.
        await page.locator('.completion_prompt_manager_tab_button[data-tab="edit"]').click();
        const promptField = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
        // The editor focuses and moves the caret on the next animation frame.
        await expect(promptField).toBeFocused();
        await promptField.fill('Draft: {{getvar::writefor}} / {{getvar::length}}');
        await expect(promptField).toHaveValue('Draft: {{getvar::writefor}} / {{getvar::length}}');
        await page.locator('.completion_prompt_manager_tab_button[data-tab="preview"]').click();
        await expect(preview).toHaveText('Draft: Write for every character / Any length');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables)).toBeUndefined();

        await page.locator('.completion_prompt_manager_tab_button[data-tab="edit"]').click();
        await expect(promptField).toBeFocused();
        await promptField.fill('{{setvar::preview-only::yes}}{{getvar::preview-only}}');
        await expect(promptField).toHaveValue('{{setvar::preview-only::yes}}{{getvar::preview-only}}');
        await page.locator('.completion_prompt_manager_tab_button[data-tab="preview"]').click();
        await expect(preview).toHaveText('yes');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables)).toBeUndefined();

        const checks = await page.evaluate(async () => {
            const { promptManager } = await import('/scripts/openai.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { extension_settings } = await import('/scripts/extensions.js');
            const context = window.SillyTavern.getContext();
            const savedMode = power_user.experimental_macro_engine;
            const results = [];
            const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
            const toggle = promptManager.getPromptById('fixture-length');
            toggle.content = '{{setvar::length::Any length}}{{setglobalvar::preview-global::fresh}}';
            context.chatMetadata.variables = { length: 'stale', count: '0' };
            extension_settings.variables.global['preview-global'] = 'saved';
            for (const modern of [false, true]) {
                power_user.experimental_macro_engine = modern;
                const draft = { identifier: 'fixture-formatting', role: 'system',
                    content: '{{getvar::length}} / {{getglobalvar::preview-global}}' };
                results.push(promptManager.preparePromptPreview(draft).content);
                order.find(entry => entry.identifier === toggle.identifier).enabled = false;
                results.push(promptManager.preparePromptPreview(draft).content);
                order.find(entry => entry.identifier === toggle.identifier).enabled = true;
                toggle.injection_trigger = ['continue'];
                results.push(promptManager.preparePromptPreview(draft).content);
                toggle.injection_trigger = [];
                // A selected setter uses the unsaved text exactly once.
                results.push(promptManager.preparePromptPreview({ ...toggle,
                    content: '{{setvar::length::draft}}{{incvar::count}}{{getvar::length}}' }).content);
                order.find(entry => entry.identifier === 'main').enabled = false;
                results.push(promptManager.preparePromptPreview({ identifier: 'main', role: 'system', content: 'Disabled: {{getvar::length}}' }).content);
                results.push(promptManager.preparePromptPreview({ role: 'system', content: 'New: {{getvar::length}}' }).content);
            }
            power_user.experimental_macro_engine = savedMode;
            return { results, local: context.chatMetadata.variables, global: extension_settings.variables.global['preview-global'] };
        });
        expect(checks.results).toEqual(Array(2).fill(['Any length / fresh', 'stale / saved', 'stale / saved', '1draft', 'Disabled: Any length', 'New: Any length']).flat());
        expect(checks.local).toEqual({ length: 'stale', count: '0' });
        expect(checks.global).toBe('saved');
    });
}
