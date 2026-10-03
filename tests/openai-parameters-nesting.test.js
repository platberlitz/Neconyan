import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const openAiSource = read('public', 'scripts', 'openai.js');
const tabManagerSource = read('public', 'scripts', 'extensions', 'third-party', 'ChatCompletionTabs', 'components', 'openai-tab-manager.js');
const neconyanCss = read('public', 'css', 'neconyan.css');

function getGroupConfig(id) {
    const start = openAiSource.indexOf(`id: '${id}'`);
    expect(start).toBeGreaterThan(-1);
    const end = openAiSource.indexOf('],', start);
    return openAiSource.slice(start, end);
}

describe('Presets Parameters nesting', () => {
    test('prompt templates get their own top-level group instead of sitting inside Output', () => {
        const output = getGroupConfig('sb-openai-output');
        const templates = getGroupConfig('sb-openai-prompt-templates');

        expect(templates).toContain('title: \'Prompt Templates\'');
        expect(templates).toContain('#main_prompt_quick_edit_textarea');
        expect(templates).toContain('#impersonation_prompt_textarea');
        expect(output).not.toContain('#main_prompt_quick_edit_textarea');
        expect(output).not.toContain('#impersonation_prompt_textarea');
        expect(output).toContain('#character_names_none');
        expect(output).toContain('#continue_postfix_none');
        expect(openAiSource.indexOf('id: \'sb-openai-output\'')).toBeLessThan(openAiSource.indexOf('id: \'sb-openai-prompt-templates\''));
        expect(openAiSource.indexOf('id: \'sb-openai-prompt-templates\'')).toBeLessThan(openAiSource.indexOf('id: \'sb-openai-advanced\''));
    });

    test('drawers inside a Parameters group become always-open titled sections', () => {
        const start = openAiSource.indexOf('function flattenOpenAISettingsSubdrawer(');
        const body = openAiSource.slice(start, openAiSource.indexOf('\n}\n', start));

        expect(body).toContain('drawer.classList.remove(\'inline-drawer\'');
        expect(body).toContain('drawer.classList.add(\'sb-openai-settings-section\')');
        expect(body).toContain('header?.classList.remove(\'inline-drawer-toggle\', \'inline-drawer-header\')');
        expect(body).toContain('header?.querySelector(\':scope > .inline-drawer-icon\')?.remove()');
        expect(body).toContain('content?.style.removeProperty(\'display\')');
        expect(openAiSource).toContain('flattenOpenAISettingsSubdrawer($block[0]);');
        expect(openAiSource).toContain('flattenOpenAISettingsSubdrawer($drawer[0]);');
    });

    test('the Parameters tab carries the new group and sections are divided', () => {
        expect(tabManagerSource).toContain('\'#left-nav-panel #sb-openai-output\',\n                        \'#left-nav-panel #sb-openai-prompt-templates\',');
        expect(neconyanCss).toContain('.sb-openai-settings-section:not(:first-child) > .sb-openai-settings-section-header');
    });
});
