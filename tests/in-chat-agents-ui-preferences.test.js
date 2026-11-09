import { describe, expect, jest, test } from '@jest/globals';
import { createAgentUiPreferences, readCollapsedAgentCategories } from '../public/scripts/extensions/in-chat-agents/ui-preferences.js';

function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('Agents page preferences', () => {
    test('restores choices before a delayed account save reaches the server', () => {
        const local = storage();
        const account = storage();
        account.setItem('tab', 'all');
        const options = { accountStorage: account, getAccount: () => 'alice', getLocalStorage: () => local };
        createAgentUiPreferences(options).setItem('tab', 'quick');
        account.setItem('tab', 'all'); // The server still has the old settings on reload.
        expect(createAgentUiPreferences(options).getItem('tab')).toBe('quick');
        expect(account.getItem('tab')).toBe('quick');
    });

    test('uses existing account preferences on a new device', () => {
        const account = storage();
        account.setItem('tab', 'quick');
        const preferences = createAgentUiPreferences({ accountStorage: account, getAccount: () => 'alice', getLocalStorage: storage });
        expect(preferences.getItem('tab')).toBe('quick');
    });

    test('keeps browser and session choices separate for each account', () => {
        let account = 'alice';
        const local = storage();
        const options = { accountStorage: storage(), getAccount: () => account, getLocalStorage: () => local };
        const preferences = createAgentUiPreferences(options);
        preferences.setItem('tab', 'quick');
        account = 'bob';
        options.accountStorage.setItem('tab', 'all');
        expect(preferences.getItem('tab')).toBe('all');
        preferences.setItem('tab', 'on');
        account = 'alice';
        expect(createAgentUiPreferences(options).getItem('tab')).toBe('quick');
    });

    test('keeps session choices when both storage providers are unavailable', () => {
        const fail = jest.fn(() => { throw new Error('Unavailable'); });
        const preferences = createAgentUiPreferences({ accountStorage: { getItem: fail, setItem: fail }, getAccount: () => 'alice', getLocalStorage: fail });
        expect(preferences.getItem('tab')).toBeNull();
        preferences.setItem('tab', 'quick');
        expect(preferences.getItem('tab')).toBe('quick');
    });

    test('keeps browser choices when account settings cannot be saved', () => {
        const local = storage();
        const fail = () => { throw new Error('Unavailable'); };
        const options = { accountStorage: { getItem: fail, setItem: fail }, getAccount: () => 'alice', getLocalStorage: () => local };
        createAgentUiPreferences(options).setItem('tab', 'quick');
        expect(createAgentUiPreferences(options).getItem('tab')).toBe('quick');
    });

    test('falls back to account settings when browser storage is blocked', () => {
        const account = storage();
        const options = { accountStorage: account, getAccount: () => 'alice', getLocalStorage: () => { throw new Error('Blocked'); } };
        createAgentUiPreferences(options).setItem('tab', 'quick');
        expect(createAgentUiPreferences(options).getItem('tab')).toBe('quick');
    });

    test.each(['broken', '{}', 'null', '"custom"'])('ignores malformed collapsed categories: %s', saved => {
        expect([...readCollapsedAgentCategories({ getItem: () => saved }, 'collapsed', { custom: {} })]).toEqual([]);
    });

    test('restores only recognised categories and remembers expansion', () => {
        const local = storage();
        const options = { accountStorage: storage(), getAccount: () => 'alice', getLocalStorage: () => local };
        const preferences = createAgentUiPreferences(options);
        preferences.setItem('collapsed', '["custom","removed","custom",null,["custom"],42,{}]');
        expect([...readCollapsedAgentCategories(createAgentUiPreferences(options), 'collapsed', { custom: {} })]).toEqual(['custom']);
        preferences.setItem('collapsed', '[]');
        expect([...readCollapsedAgentCategories(createAgentUiPreferences(options), 'collapsed', { custom: {} })]).toEqual([]);
    });
});
