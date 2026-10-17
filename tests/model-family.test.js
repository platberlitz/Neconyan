import { describe, expect, test } from '@jest/globals';

import {
    getModelFamilyGroup,
    groupByModelFamily,
} from '../public/scripts/model-family.js';

const label = id => getModelFamilyGroup(id)?.label ?? null;

describe('model families from IDs', () => {
    test.each([
        ['gemini-3.5-flash', 'Gemini 3.5'],
        ['gemini-3.5-flash-lite', 'Gemini 3.5'],
        ['models/gemini-3.7-pro-preview', 'Gemini 3.7'],
        ['gemini-3-flash-preview', 'Gemini 3'],
        ['gemma-4-26b-a4b-it', 'Gemma 4'],
        ['gpt-5.6-sol', 'GPT-5.6'],
        ['gpt-4o-mini', 'GPT-4o'],
        ['o3-mini', 'o3'],
        ['claude-opus-4-5', 'Claude 4.5'],
        ['claude-sonnet-5-5', 'Claude 5.5'],
        ['moonshotai/kimi-k3', 'Kimi K3'],
        ['deepseek-v4-flash', 'DeepSeek V4'],
        ['qwen3-235b-a22b', 'Qwen3'],
        ['meta-llama/llama-4-maverick:free', 'Llama 4'],
        ['z-ai/glm-5.3-flash', 'GLM 5.3'],
        ['mistral-large-2512', 'Mistral'],
        ['command-a-03-2025', 'Command'],
    ])('%s -> %s', (id, expected) => {
        expect(label(id)).toBe(expected);
    });

    test('parameter sizes, dates and non-names are not versions', () => {
        expect(label('llama-70b-instruct')).toBe('Llama');
        expect(label('mistral-small-2409')).toBe('Mistral');
        expect(label('7b-chat')).toBeNull();
        expect(label('')).toBeNull();
    });

    test('groups keep family order, newest version first, unknown IDs last', () => {
        const ids = ['gemini-2.5-pro', 'gpt-5.6-sol', '123-model', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gpt-6-astra'];
        const groups = groupByModelFamily(ids, id => id);
        expect(groups.map(group => [group.label, group.items])).toEqual([
            ['Gemini 3.5', ['gemini-3.5-flash']],
            ['Gemini 2.5', ['gemini-2.5-pro', 'gemini-2.5-flash']],
            ['GPT-6', ['gpt-6-astra']],
            ['GPT-5.6', ['gpt-5.6-sol']],
            [null, ['123-model']],
        ]);
    });
});
