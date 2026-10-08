import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPromptPreview, PROMPT_PREVIEW_MAX_LENGTH } from '../public/scripts/prompt-preview.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptManagerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'PromptManager.js'), 'utf8');
const promptManagerCss = readFileSync(path.join(repoRoot, 'public', 'css', 'promptmanager.css'), 'utf8');

describe('prompt list previews', () => {
    test('uses a {{// comment}} as the whole blurb', () => {
        const preview = getPromptPreview('{{// This prompt is for friction}}{{trim}}\nCreate friction between {{char}} and {{user}}.');

        expect(preview).toEqual({ text: 'This prompt is for friction', isComment: true });
    });

    test('finds a comment that is not at the very start', () => {
        const preview = getPromptPreview('{{trim}}\n  {{//   Keeps   the pacing\n slow }}\nBody text');

        expect(preview).toEqual({ text: 'Keeps the pacing slow', isComment: true });
    });

    test('truncates a long comment', () => {
        const preview = getPromptPreview(`{{// ${'friction '.repeat(40)}}}`);

        expect(preview.isComment).toBe(true);
        expect(preview.text.length).toBeLessThanOrEqual(PROMPT_PREVIEW_MAX_LENGTH);
        expect(preview.text.endsWith('…')).toBe(true);
    });

    test('falls back to the prompt text without comments or trim macros', () => {
        const preview = getPromptPreview('{{//}}{{trim}}\n\nWrite   in third person.\n{{trim}}');

        expect(preview).toEqual({ text: 'Write in third person.', isComment: false });
    });

    test('truncates long prompt text at a word boundary', () => {
        const preview = getPromptPreview('word '.repeat(100));

        expect(preview.text.length).toBeLessThanOrEqual(PROMPT_PREVIEW_MAX_LENGTH);
        expect(preview.text).toMatch(/word…$/);
    });

    test('drops Markdown bold marks and heading hashes', () => {
        const preview = getPromptPreview('{{// # README\n**Pura\'s Director Preset** __V16__}}');

        expect(preview.text).toBe('README Pura\'s Director Preset V16');
    });

    test('returns no blurb for empty prompts', () => {
        expect(getPromptPreview('')).toEqual({ text: '', isComment: false });
        expect(getPromptPreview(undefined)).toEqual({ text: '', isComment: false });
        expect(getPromptPreview('{{trim}}  ')).toEqual({ text: '', isComment: false });
    });

    test('rows render the escaped preview after the token count, leaving control positions alone', () => {
        expect(promptManagerSource).toContain('import { getPromptPreview } from \'./prompt-preview.js\';');
        expect(promptManagerSource).toContain('const promptPreview = prompt.marker ? null : getPromptPreview(prompt.content);');
        expect(promptManagerSource).toMatch(/prompt-manager-prompt-preview[^`]*\$\{escapeHtml\(promptPreview\.text\)\}<\/small>/);
        expect(promptManagerSource).toMatch(/prompt_manager_prompt_tokens" data-pm-tokens="\$\{calculatedTokens\}">[^\n]*<\/span>\n\s*\$\{previewHtml\}\n\s*<\/li>/);
    });

    test('phone rows place the preview between the name and the controls', () => {
        expect(promptManagerCss).toMatch(/:has\(> \.prompt-manager-prompt-preview\) \{\s*grid-template-areas:\s*"name tokens"\s*"preview preview"\s*"controls controls";/);
    });
});
