/* global window, document */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { searchAgentTemplates } from './in-chat-agents-e2e-helpers.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120000);

async function dismissTutorial(page) {
    const skip = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) await skip.click();
}

for (const width of [1280, 393]) {
    test.describe(`reply rule context at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393 });

        test('checks resolved before/after-main prompts and preserves them through quiet requests', async ({ page }, info) => {
            await isolateSettingsSaves(page, settings => {
                settings.main_api = 'openai';
                delete settings.accountStorage?.['ica--workspace-view'];
            });
            await page.goto('/');
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const assistant = page.locator('[data-assistant-personality="miso"]');
            await assistant.locator('input[value="miso-male"]').check();
            await assistant.locator('[data-assistant-open]').click();
            await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
            await dismissTutorial(page);
            await page.waitForFunction(() => Boolean(window.SillyTavern.getContext().chatId));

            const result = await page.evaluate(async () => {
                const { oai_settings, prepareOpenAIMessages } = await import('/scripts/openai.js');
                const { getPreparedPresetPrompts } = await import('/scripts/extensions/in-chat-agents/agent-context-macros.js');
                const { buildPromptDynamicMacros } = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
                oai_settings.prompts = [
                    { identifier: 'main', name: 'Main', role: 'system', system_prompt: true, content: 'SAVED_RULE', injection_position: 0 },
                    { identifier: 'off', name: 'Off', role: 'system', content: 'DISABLED_RULE' },
                    { identifier: 'chatHistory', name: 'Chat History', marker: true, system_prompt: true },
                ];
                oai_settings.prompt_order = [{ character_id: 100001,
                    order: oai_settings.prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.identifier !== 'off' })) }];
                oai_settings.openai_max_context = 32768;
                oai_settings.openai_max_tokens = 1024;
                let filterCalls = 0;
                const input = { name2: 'Miso', type: 'normal', messages: [], messageExamples: [], systemPromptOverride: 'RESOLVED_MAIN_RULE',
                    extensionPrompts: {
                        before: { value: 'HTML_RULE', position: 2, role: 0, name: 'HTML Toggle' },
                        '2_floating_prompt': { value: 'NOTE_RULE', position: 0, role: 0 },
                        after: { value: 'TIME_RULE', position: 0, role: 1, name: 'Time Tracker' },
                        filtered: { value: 'FILTERED_RULE', position: 0, role: 0, filter: () => { filterCalls++; return false; } },
                    } };
                const [sent] = await prepareOpenAIMessages(input, false);
                const chatId = window.SillyTavern.getContext().chatId;
                const rules = structuredClone(getPreparedPresetPrompts(chatId, 'normal'));
                const macro = () => buildPromptDynamicMacros('Reply', null, { prompt: '{{preset-prompts}}' }, 'normal')['preset-prompts'];
                const checked = macro();
                await prepareOpenAIMessages({ ...input, type: 'quiet', extensionPrompts: {}, systemPromptOverride: 'QUIET_RULE' }, false);
                const afterQuiet = macro();
                await prepareOpenAIMessages({ ...input, extensionPrompts: {}, systemPromptOverride: 'PREVIEW_RULE' }, true);
                return { sent, rules, checked, afterQuiet, afterPreview: macro(), filterCalls };
            });
            expect(result.rules.map(rule => rule.content)).toEqual(['HTML_RULE', 'RESOLVED_MAIN_RULE', 'NOTE_RULE', 'TIME_RULE']);
            expect(result.sent).toContainEqual(expect.objectContaining({ role: 'user', content: 'TIME_RULE' }));
            expect(result.checked).toContain('<prompt name="Time Tracker">\nTIME_RULE\n</prompt>');
            expect(result.checked).not.toMatch(/DISABLED_RULE|FILTERED_RULE|SAVED_RULE/);
            expect(result.afterQuiet).toBe(result.checked);
            expect(result.afterPreview).toBe(result.checked);
            expect(result.filterCalls).toBe(1);

            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            await expect(page.locator('#ica--settings')).toBeVisible();
            await page.locator('#ica--templates').click();
            await searchAgentTemplates(page, 'Prompt Adherence Checker', { count: 1 });
            const card = page.locator('.ica--template-card[data-id="tpl-prompt-adherence-checker"]');
            await expect(card).toContainText('before or after the main prompt');
            await expect(card.locator('.ica--card-pill--version')).toHaveText('v2');
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: info.outputPath(`prompt-adherence-${width}.png`) });
        });
    });
}
