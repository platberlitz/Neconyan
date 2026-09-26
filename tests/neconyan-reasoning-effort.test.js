import { describe, expect, test } from '@jest/globals';
import {
    getReasoningEffortShortLabel,
    isReasoningEffortSupported,
} from '../public/scripts/neconyan-reasoning-effort.js';

describe('reasoning effort quick switch helpers', () => {
    test('short labels stay compact for the bottom bar', () => {
        expect(getReasoningEffortShortLabel('medium')).toBe('Med');
        expect(getReasoningEffortShortLabel('xhigh')).toBe('XHigh');
        expect(getReasoningEffortShortLabel('custom')).toBe('custom');
        expect(getReasoningEffortShortLabel('')).toBe('');
    });

    test('only shows for chat completion sources that accept the setting', () => {
        const dataSource = 'openai,claude, openrouter';
        expect(isReasoningEffortSupported({ mainApi: 'openai', source: 'claude', dataSource })).toBe(true);
        expect(isReasoningEffortSupported({ mainApi: 'openai', source: 'openrouter', dataSource })).toBe(true);
        expect(isReasoningEffortSupported({ mainApi: 'openai', source: 'ai21', dataSource })).toBe(false);
        expect(isReasoningEffortSupported({ mainApi: 'textgenerationwebui', source: 'claude', dataSource })).toBe(false);
        expect(isReasoningEffortSupported({ mainApi: 'openai', source: 'claude', dataSource: '' })).toBe(false);
    });
});
