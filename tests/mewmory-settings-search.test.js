import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_OPEN_FOLDS, ROLE_ONLY_SETTINGS, SETTINGS_FOLDS, matchesTerms, otherRoleMatches, readOpenFolds, searchTerms,
} from '../public/scripts/mewmory/settings-search.js';

const ROLES = {
    extractor: 'Facts and events',
    pawspective: 'Pawspective interviews',
    embedding: 'Embeddings',
    selector: 'Recall selector',
    fallback: 'Recall fallback',
};

describe('Mewmory settings search', () => {
    test('splits a search into lower-case words and ignores extra spaces', () => {
        expect(searchTerms('  Request   TIMEOUT ')).toEqual(['request', 'timeout']);
        expect(searchTerms('')).toEqual([]);
        expect(searchTerms(undefined)).toEqual([]);
    });

    test('needs every word, and accepts plurals, synonyms and curly quotes', () => {
        expect(matchesTerms('Request timeout, seconds', ['request', 'timeout'])).toBe(true);
        expect(matchesTerms('Request timeout, seconds', ['request', 'prefill'])).toBe(false);
        expect(matchesTerms('Add a fallback connection', ['backups'])).toBe(true);
        expect(matchesTerms('Backup connections', ['fallbacks'])).toBe(true);
        expect(matchesTerms('could not be reached or took too long', ['timeout'])).toBe(true);
        expect(matchesTerms('Save or restore this chat’s memories', ['chat\'s'])).toBe(true);
        expect(matchesTerms('Prefill, optional', ['class'])).toBe(false);
        expect(matchesTerms('anything at all', [])).toBe(true);
    });

    test('points a search to the model roles that have a setting the current role lacks', () => {
        expect(otherRoleMatches(searchTerms('prefill'), 'embedding', ROLES).map(match => match.role))
            .toEqual(['extractor', 'pawspective', 'selector', 'fallback']);
        expect(otherRoleMatches(searchTerms('prefill'), 'extractor', ROLES)).toEqual([]);
        expect(otherRoleMatches(searchTerms('document prefix'), 'extractor', ROLES))
            .toEqual([{ role: 'embedding', label: 'Embeddings', settings: ['Prefix preset', 'Document prefix, optional'] }]);
        expect(otherRoleMatches(searchTerms('decision protocol'), 'extractor', ROLES).map(match => match.label))
            .toEqual(['Recall selector', 'Recall fallback']);
        expect(otherRoleMatches(searchTerms('kimi selector'), 'embedding', ROLES))
            .toEqual([{ role: 'selector', label: 'Recall selector', settings: ['Partial prefill for Kimi K3, optional'] }]);
        expect(otherRoleMatches([], 'extractor', ROLES)).toEqual([]);
        expect(otherRoleMatches(searchTerms('temperature'), 'extractor', ROLES)).toEqual([]);
    });

    test('every role-only setting names roles the settings page knows', () => {
        for (const setting of ROLE_ONLY_SETTINGS) {
            expect(setting.roles.length).toBeGreaterThan(0);
            for (const role of setting.roles) expect(Object.keys(ROLES)).toContain(role);
        }
    });

    test('opens only the first section until a choice is saved, and drops unknown sections', () => {
        expect([...readOpenFolds(null)]).toEqual([...DEFAULT_OPEN_FOLDS]);
        expect([...readOpenFolds(undefined)]).toEqual(['automatic']);
        expect([...readOpenFolds('not json')]).toEqual(['automatic']);
        expect([...readOpenFolds('{"models":true}')]).toEqual(['automatic']);
        expect([...readOpenFolds('["models","gone","search"]')]).toEqual(['models', 'search']);
        expect([...readOpenFolds('[]')]).toEqual([]);
        expect(Object.keys(SETTINGS_FOLDS)).toEqual(['automatic', 'models', 'search', 'upkeep', 'transfers', 'lorebook', 'continue']);
    });
});
