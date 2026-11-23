import { describe, expect, test } from '@jest/globals';
import {
    linkPointsAt,
    planCardLinkRewrites,
    rewriteCharLore,
    rewriteChatLorebook,
    rewriteConversationOverrides,
    rewriteLorebookNames,
    runLorebookLinkSteps,
} from '../public/scripts/lorebook-link-rewrite.js';
import { findMissingLorebookLinks, listLorebookLinks } from '../public/scripts/lorebook-links.js';

const card = (world, avatar = 'Ada.png', name = 'Ada', extra = {}) => ({ avatar, name, data: { name, extensions: { world }, ...extra } });

describe('linkPointsAt', () => {
    test('matches the exact name only', () => {
        expect(linkPointsAt('Target Book', 'Target Book')).toBe(true);
        expect(linkPointsAt('target book', 'Target Book')).toBe(false);
        expect(linkPointsAt('Target Book Two', 'Target Book')).toBe(false);
        expect(linkPointsAt('Target', 'Target Book')).toBe(false);
        expect(linkPointsAt('Target Book', 'Target')).toBe(false);
    });

    test('follows the server, which drops trailing spaces and dots when it looks a name up', () => {
        expect(linkPointsAt('Target Book ', 'Target Book')).toBe(true);
        expect(linkPointsAt('Target Book..', 'Target Book')).toBe(true);
        expect(linkPointsAt(' Target Book', 'Target Book')).toBe(false);
    });

    test('never matches an empty name', () => {
        expect(linkPointsAt('', '')).toBe(false);
        expect(linkPointsAt('  ', ' ')).toBe(false);
        expect(linkPointsAt(undefined, 'Target Book')).toBe(false);
    });
});

describe('rewriteLorebookNames', () => {
    test('a rename keeps the place of the link', () => {
        expect(rewriteLorebookNames(['Other', 'Target Book', 'Target Book Two'], 'Target Book', 'New')).toEqual(['Other', 'New', 'Target Book Two']);
    });

    test('a rename never lists a name twice', () => {
        expect(rewriteLorebookNames(['Target Book', 'New'], 'Target Book', 'New')).toEqual(['New']);
        expect(rewriteLorebookNames(['New', 'Target Book'], 'Target Book', 'New')).toEqual(['New']);
        expect(rewriteLorebookNames(['Target Book', 'Target Book '], 'Target Book', 'New')).toEqual(['New']);
    });

    test('a delete removes the link and leaves the others in order', () => {
        expect(rewriteLorebookNames(['A', 'Target Book', 'B', 'target book'], 'Target Book', null)).toEqual(['A', 'B', 'target book']);
    });

    test('returns null when nothing links the book', () => {
        expect(rewriteLorebookNames(['A', 'B'], 'Target Book', null)).toBeNull();
        expect(rewriteLorebookNames(undefined, 'Target Book', null)).toBeNull();
        expect(rewriteLorebookNames([], 'Target Book', 'New')).toBeNull();
    });
});

describe('rewriteCharLore', () => {
    const charLore = [
        { name: 'Ada', extraBooks: ['Other', 'Target Book'] },
        { name: 'Bea', extraBooks: ['Target Book'] },
        { name: 'Cy', extraBooks: ['Target Book Two', 'Target'] },
        { name: 'Di', extraBooks: ['Other'], note: 'kept' },
    ];

    test('a delete removes the link and drops a card left with nothing', () => {
        const result = rewriteCharLore(charLore, 'Target Book', null);
        expect(result.cards).toEqual(['Ada', 'Bea']);
        expect(result.charLore).toEqual([
            { name: 'Ada', extraBooks: ['Other'] },
            { name: 'Cy', extraBooks: ['Target Book Two', 'Target'] },
            { name: 'Di', extraBooks: ['Other'], note: 'kept' },
        ]);
    });

    test('a rename moves the link in place and leaves similar names alone', () => {
        const result = rewriteCharLore(charLore, 'Target Book', 'Renamed');
        expect(result.cards).toEqual(['Ada', 'Bea']);
        expect(result.charLore).toEqual([
            { name: 'Ada', extraBooks: ['Other', 'Renamed'] },
            { name: 'Bea', extraBooks: ['Renamed'] },
            { name: 'Cy', extraBooks: ['Target Book Two', 'Target'] },
            { name: 'Di', extraBooks: ['Other'], note: 'kept' },
        ]);
    });

    test('does not change the list it was given', () => {
        const before = JSON.stringify(charLore);
        rewriteCharLore(charLore, 'Target Book', null);
        expect(JSON.stringify(charLore)).toBe(before);
    });

    test('copes with a missing list', () => {
        expect(rewriteCharLore(undefined, 'Target Book', null)).toEqual({ charLore: [], cards: [] });
    });
});

describe('planCardLinkRewrites', () => {
    const cards = [
        card('Target Book', 'Ada.png', 'Ada'),
        card('target book', 'Bea.png', 'Bea'),
        card('Target Book Two', 'Cy.png', 'Cy'),
        card('Target', 'Di.png', 'Di'),
        card('', 'Ed.png', 'Ed'),
        card('Target Book', 'Fay.png', 'Fay', { character_book: { name: 'Target Book', entries: [] } }),
    ];

    test('finds only the cards whose main lorebook is the book', () => {
        expect(planCardLinkRewrites(cards, 'Target Book', null).map(item => item.avatar)).toEqual(['Ada.png', 'Fay.png']);
    });

    test('writes only the link: an empty name for a delete, the new name for a rename', () => {
        expect(planCardLinkRewrites(cards, 'Target Book', null)[0]).toEqual({ avatar: 'Ada.png', owner: 'Ada', update: { extensions: { world: '' } } });
        expect(planCardLinkRewrites(cards, 'Target Book', 'Renamed')[1]).toEqual({ avatar: 'Fay.png', owner: 'Fay', update: { extensions: { world: 'Renamed' } } });
    });

    test('never asks for a change to the embedded copy', () => {
        for (const item of planCardLinkRewrites(cards, 'Target Book', 'Renamed')) expect(Object.keys(item.update)).toEqual(['extensions']);
    });
});

describe('rewriteChatLorebook', () => {
    test('moves or removes the chat link', () => {
        expect(rewriteChatLorebook({ world_info: 'Target Book' }, 'Target Book', 'New')).toEqual({ changed: true, value: 'New' });
        expect(rewriteChatLorebook({ world_info: 'Target Book' }, 'Target Book', null)).toEqual({ changed: true, value: null });
    });

    test('leaves another book alone', () => {
        expect(rewriteChatLorebook({ world_info: 'target book' }, 'Target Book', null)).toEqual({ changed: false, value: 'target book' });
        expect(rewriteChatLorebook({ world_info: 'Target Book Two' }, 'Target Book', 'New')).toEqual({ changed: false, value: 'Target Book Two' });
        expect(rewriteChatLorebook({}, 'Target Book', null)).toEqual({ changed: false, value: null });
        expect(rewriteChatLorebook(undefined, 'Target Book', null)).toEqual({ changed: false, value: null });
    });
});

describe('rewriteConversationOverrides', () => {
    const makeStore = () => ({
        characters: {
            'persona:p:Nova.png': { settings: { lorebook_override: 'Target Book' } },
            'persona:p:group:g1:Nova.png': { settings: { lorebook_override: 'Target Book' } },
            'persona:p:group:g1:Kai.png': { settings: { lorebook_override: 'Target Book Two' } },
            'persona:p:Kai.png': { settings: { lorebook_override: 'target book', tone: 'kept' } },
            'persona:p:Ed.png': { settings: { lorebook_override: '' } },
            'persona:p:Fay.png': {},
        },
    });

    test('a delete clears the override of every thread, DMs and group members alike', () => {
        const store = makeStore();
        expect(rewriteConversationOverrides(store, 'Target Book', null)).toEqual(['persona:p:Nova.png', 'persona:p:group:g1:Nova.png']);
        expect(store.characters['persona:p:Nova.png'].settings.lorebook_override).toBe('');
        expect(store.characters['persona:p:group:g1:Nova.png'].settings.lorebook_override).toBe('');
        expect(store.characters['persona:p:group:g1:Kai.png'].settings.lorebook_override).toBe('Target Book Two');
        expect(store.characters['persona:p:Kai.png'].settings).toEqual({ lorebook_override: 'target book', tone: 'kept' });
    });

    test('a rename moves the override', () => {
        const store = makeStore();
        rewriteConversationOverrides(store, 'Target Book', 'Renamed');
        expect(store.characters['persona:p:Nova.png'].settings.lorebook_override).toBe('Renamed');
        expect(store.characters['persona:p:group:g1:Nova.png'].settings.lorebook_override).toBe('Renamed');
    });

    test('reports nothing for a store without the book, or without threads', () => {
        expect(rewriteConversationOverrides({ characters: {} }, 'Target Book', null)).toEqual([]);
        expect(rewriteConversationOverrides(undefined, 'Target Book', null)).toEqual([]);
    });
});

describe('after a rewrite the missing-lorebook list has nothing to report', () => {
    test('every link place moves with a rename', () => {
        const known = ['Renamed', 'Other'];
        const cards = [card('Target Book', 'Ada.png', 'Ada')];
        const charLore = [{ name: 'Ada', extraBooks: ['Target Book'] }];
        const store = { characters: { 'persona:p:Ada.png': { settings: { lorebook_override: 'Target Book' } } } };
        const metadata = { world_info: 'Target Book' };

        const before = listLorebookLinks({ cards, charLore, chatLorebook: metadata.world_info, conversationOverrides: ['Target Book'] });
        expect(findMissingLorebookLinks(before, known)).toHaveLength(4);

        const plan = planCardLinkRewrites(cards, 'Target Book', 'Renamed');
        cards[0].data.extensions.world = plan[0].update.extensions.world;
        const lore = rewriteCharLore(charLore, 'Target Book', 'Renamed').charLore;
        rewriteConversationOverrides(store, 'Target Book', 'Renamed');
        const chat = rewriteChatLorebook(metadata, 'Target Book', 'Renamed').value;

        const after = listLorebookLinks({
            cards, charLore: lore, chatLorebook: chat,
            conversationOverrides: Object.values(store.characters).map(slot => slot.settings.lorebook_override),
        });
        expect(after).toHaveLength(4);
        expect(findMissingLorebookLinks(after, known)).toEqual([]);
    });
});

describe('runLorebookLinkSteps', () => {
    test('runs every step even when one fails, and names the failure', async () => {
        const ran = [];
        const result = await runLorebookLinkSteps([
            { label: 'first card', run: async () => { ran.push('first'); return 1; } },
            { label: 'second card', run: async () => { ran.push('second'); throw new Error('Card could not be saved'); } },
            { label: 'third card', run: async () => { ran.push('third'); return 2; } },
            { label: 'chat', run: () => { ran.push('chat'); throw 'plain text'; } },
            { label: 'settings', run: async () => { ran.push('settings'); } },
        ]);
        expect(ran).toEqual(['first', 'second', 'third', 'chat', 'settings']);
        expect(result.moved).toBe(3);
        expect(result.failed).toEqual([
            { label: 'second card', reason: 'Card could not be saved' },
            { label: 'chat', reason: 'plain text' },
        ]);
    });

    test('an empty plan is a clean result', async () => {
        expect(await runLorebookLinkSteps([])).toEqual({ moved: 0, failed: [] });
    });
});
