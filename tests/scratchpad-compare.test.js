import { describe, expect, test } from '@jest/globals';
import {
    CURRENT_CONNECTION_CHOICE,
    activeCompareConnection,
    compareChoiceValue,
    compareConnectionFromChoice,
    comparedSiblings,
    comparingPending,
    effectiveConnection,
    sameCompareTarget,
} from '../public/scripts/scratchpad/compare.js';

const ALPHA = { kind: 'profile', profileId: 'alpha' };
const BETA = { kind: 'profile', profileId: 'beta' };
const CURRENT = { kind: 'current' };

describe('Scratchpad compare choice', () => {
    test('maps the select value to a saved connection and back', () => {
        expect(compareConnectionFromChoice('')).toBeNull();
        expect(compareConnectionFromChoice(CURRENT_CONNECTION_CHOICE)).toEqual(CURRENT);
        expect(compareConnectionFromChoice('beta')).toEqual(BETA);
        expect(compareChoiceValue(null)).toBe('');
        expect(compareChoiceValue(CURRENT)).toBe(CURRENT_CONNECTION_CHOICE);
        expect(compareChoiceValue(BETA)).toBe('beta');
        expect(compareChoiceValue({ kind: 'profile', profileId: '' })).toBe(CURRENT_CONNECTION_CHOICE);
    });

    test('resolves the current connection through the chat profile', () => {
        expect(effectiveConnection(CURRENT)).toEqual({ kind: 'active' });
        expect(effectiveConnection(CURRENT, 'beta')).toEqual(BETA);
        expect(effectiveConnection(ALPHA, 'beta')).toEqual(ALPHA);
    });

    test('spots two choices that reach the same connection', () => {
        expect(sameCompareTarget(ALPHA, null)).toBe(false);
        expect(sameCompareTarget(ALPHA, BETA)).toBe(false);
        expect(sameCompareTarget(ALPHA, { ...ALPHA })).toBe(true);
        expect(sameCompareTarget(CURRENT, CURRENT)).toBe(true);
        expect(sameCompareTarget(CURRENT, BETA)).toBe(false);
        expect(sameCompareTarget(CURRENT, BETA, 'beta')).toBe(true);
        expect(sameCompareTarget(ALPHA, CURRENT, 'beta')).toBe(false);
    });

    test('compares only plain new messages outside Round table', () => {
        const settings = { compareConnection: BETA };
        expect(activeCompareConnection(settings)).toEqual(BETA);
        expect(activeCompareConnection({ compareConnection: null })).toBeNull();
        expect(activeCompareConnection({ ...settings, roundTable: true })).toBeNull();
        expect(activeCompareConnection(settings, { regenerate: true })).toBeNull();
        expect(activeCompareConnection(settings, { discuss: true })).toBeNull();
        expect(activeCompareConnection(settings, { rehearsal: true })).toBeNull();
    });
});

describe('Scratchpad compared replies', () => {
    const user = { id: 'u1', role: 'user', text: 'Which ending works?' };
    const alpha = { id: 'a', role: 'assistant', assistant: 'miso', compareGroup: 'u1', state: 'done' };
    const beta = { id: 'b', role: 'assistant', assistant: 'miso', compareGroup: 'u1', state: 'done' };
    const later = { id: 'c', role: 'assistant', assistant: 'miso', compareGroup: 'u2', state: 'done' };

    test('finds the other reply in the same pair only', () => {
        const messages = [user, alpha, beta, later];
        expect(comparedSiblings(messages, alpha)).toEqual([beta]);
        expect(comparedSiblings(messages, beta)).toEqual([alpha]);
        expect(comparedSiblings(messages, later)).toEqual([]);
        expect(comparedSiblings(messages, user)).toEqual([]);
        expect(comparedSiblings(messages, { id: 'n', role: 'assistant', assistant: 'miso' })).toEqual([]);
        expect(comparedSiblings([user, alpha, { ...beta, assistant: 'taro' }], alpha)).toEqual([]);
    });

    test('treats a pair as running until both replies finish', () => {
        expect(comparingPending([user, { ...alpha, state: 'pending' }, { ...beta, state: 'pending' }])).toBe(true);
        expect(comparingPending([user, alpha, { ...beta, state: 'pending' }])).toBe(false);
        expect(comparingPending([user, alpha, beta])).toBe(false);
        expect(comparingPending([user, { id: 'r1', role: 'assistant', state: 'pending' }, { id: 'r2', role: 'assistant', state: 'pending' }])).toBe(false);
    });
});
