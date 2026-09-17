import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS,
    MODEL_FILTER_PHONE_ONLY_SELECTORS,
    computeVisibleModelOptions,
} from '../public/scripts/neconyan-model-filter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

const options = [
    { value: 'gpt-6', text: 'GPT-6 Turbo' },
    { value: 'claude-4', text: 'Claude 4 Opus' },
    { value: 'local-llama', text: 'Llama 3.3 70B' },
];

describe('computeVisibleModelOptions', () => {
    test('returns every option for an empty query', () => {
        expect(computeVisibleModelOptions(options, '')).toEqual(options);
        expect(computeVisibleModelOptions(options, '   ')).toEqual(options);
    });

    test('matches option text and value, case-insensitively', () => {
        expect(computeVisibleModelOptions(options, 'claude').map(o => o.value)).toEqual(['claude-4']);
        expect(computeVisibleModelOptions(options, 'GPT-6').map(o => o.value)).toEqual(['gpt-6']);
        expect(computeVisibleModelOptions(options, 'llama').map(o => o.value)).toEqual(['local-llama']);
    });

    test('keeps the currently selected option even when it does not match', () => {
        const visible = computeVisibleModelOptions(options, 'claude', { currentValue: 'gpt-6' });
        expect(visible.map(o => o.value)).toEqual(['gpt-6', 'claude-4']);
    });

    test('keeps every selected option on a multiple select', () => {
        const visible = computeVisibleModelOptions(options, 'claude', {
            multiple: true,
            selectedValues: ['gpt-6', 'local-llama'],
        });
        expect(visible.map(o => o.value)).toEqual(['gpt-6', 'claude-4', 'local-llama']);
    });

    test('returns nothing when no option matches', () => {
        expect(computeVisibleModelOptions(options, 'zzz', { currentValue: 'unrelated' })).toEqual([]);
    });
});

describe('model filter selectors', () => {
    const selectIds = [
        ...MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS,
        ...MODEL_FILTER_PHONE_ONLY_SELECTORS,
    ];

    test('every selector points at a real model select in index.html', () => {
        const missing = selectIds.filter(selector => {
            const id = selector.replace('#', '');
            return !new RegExp(`<select[^>]*id="${id}"`).test(indexHtml);
        });
        expect(missing).toEqual([]);
    });

    test('no selector is listed twice', () => {
        expect(new Set(selectIds).size).toBe(selectIds.length);
    });

    test('Model ID providers keep their own filter inputs and are not targeted', () => {
        for (const selector of selectIds) {
            expect(selector).not.toMatch(/model_id$/);
        }
    });
});
