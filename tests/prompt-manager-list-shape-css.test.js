import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptManagerCss = readFileSync(path.join(repoRoot, 'public', 'css', 'promptmanager.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = cssSource.match(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'ms'));

    return match?.groups?.body ?? '';
}

describe('prompt manager list shape css', () => {
    test('caps the borrowed text_pole radius so pill shells do not clip the list', () => {
        const listSelector = '#completion_prompt_manager #completion_prompt_manager_list.text_pole';
        const listRule = getRuleBody(promptManagerCss, listSelector);

        expect(listRule).toMatch(/border-radius:\s*min\(var\(--sb-radius-button\),\s*18px\);/);
        expect(listRule).not.toContain('var(--sb-radius-button);');
    });
});
