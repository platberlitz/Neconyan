import { describe, expect, test } from '@jest/globals';
import {
    LOREBOOK_LINK_KIND,
    cardLorebookLinks,
    clearLorebookNotice,
    dismissLorebookLinks,
    filterUntoldLorebookLinks,
    findMissingLorebookLinks,
    isKnownLorebook,
    listLorebookLinks,
    noteLorebookChatOpened,
    readConversationLorebooks,
    registerLorebookNotice,
    setConversationLorebookReader,
    takeUntoldLorebookLinks,
} from '../public/scripts/lorebook-links.js';
import { checkCharacterCard } from '../public/scripts/scratchpad/checks/card.js';

const card = (world, avatar = 'Ada.png', name = 'Ada') => ({ avatar, name, data: { name, extensions: { world } } });

describe('findMissingLorebookLinks', () => {
    test('finds nothing while the list of lorebooks is not known', () => {
        const links = listLorebookLinks({ cards: [card('Gone')], chatLorebook: 'Gone too' });
        expect(findMissingLorebookLinks(links, undefined)).toEqual([]);
        expect(findMissingLorebookLinks(links, null)).toEqual([]);
    });

    test('a known empty list means every link is missing', () => {
        const links = listLorebookLinks({ cards: [card('Gone')] });
        expect(findMissingLorebookLinks(links, [])).toHaveLength(1);
    });

    test('names each kind of link and says whose it is', () => {
        const links = listLorebookLinks({
            cards: [card('Main', 'Ada.png', 'Ada')],
            charLore: [{ name: 'Ada', extraBooks: ['Extra', 'Here'] }, { name: 'Other', extraBooks: ['Not Ada'] }],
            chatLorebook: 'Chat book',
            conversationOverrides: ['Override'],
        });
        const missing = findMissingLorebookLinks(links, ['Here']);
        expect(missing.map(link => [link.kind, link.name, link.owner ?? ''])).toEqual([
            [LOREBOOK_LINK_KIND.cardMain, 'Main', 'Ada'],
            [LOREBOOK_LINK_KIND.cardExtra, 'Extra', 'Ada'],
            [LOREBOOK_LINK_KIND.chat, 'Chat book', ''],
            [LOREBOOK_LINK_KIND.conversation, 'Override', ''],
        ]);
    });

    test('a lorebook that exists never counts as missing', () => {
        const names = ['Café déjà vu', 'A&B [draft] (2)', '日本語の本', 'O\'Brien "Notes"', 'with  double  space', '100%', 'Book.v2'];
        const links = listLorebookLinks({ cards: [card(names[0])], chatLorebook: names[1], conversationOverrides: [names[2]], charLore: [{ name: 'Ada', extraBooks: names.slice(3) }] });
        expect(findMissingLorebookLinks(links, names)).toEqual([]);
    });

    test('letter case counts, as it does in the lorebook list', () => {
        expect(isKnownLorebook(['Library'], 'library')).toBe(false);
        expect(isKnownLorebook(['Library'], 'Library')).toBe(true);
    });

    test('trailing spaces and dots are dropped as the server drops them, leading spaces are not', () => {
        expect(isKnownLorebook(['Library'], 'Library ')).toBe(true);
        expect(isKnownLorebook(['Library'], 'Library..')).toBe(true);
        expect(isKnownLorebook(['Library'], ' Library')).toBe(false);
        expect(isKnownLorebook(['Library'], '   ')).toBe(false);
    });

    test('blank links are not links', () => {
        expect(listLorebookLinks({ cards: [card('   ')], chatLorebook: ' ', conversationOverrides: [''] })).toEqual([]);
    });

    test('a group lists each member card and the same book once per card', () => {
        const links = listLorebookLinks({ cards: [card('Shared', 'A.png', 'A'), card('Shared', 'B.png', 'B')] });
        expect(links.map(link => link.owner)).toEqual(['A', 'B']);
    });

    test('accepts a list or the per-card record Scratchpad passes', () => {
        const ada = card('Main');
        expect(cardLorebookLinks(ada, ['One', ' ']).map(link => link.name)).toEqual(['Main', 'One']);
        expect(cardLorebookLinks(ada, { Ada: ['Two'], Other: ['No'] }).map(link => link.name)).toEqual(['Main', 'Two']);
    });
});

describe('the Scratchpad rule and the shared detection agree', () => {
    const rules = async (character, options) => (await checkCharacterCard(character, options)).findings
        .filter(item => item.rule === 'card-lorebook-missing').map(item => item.message);

    test('same links, same answer, wording kept', async () => {
        const character = card('Missing Book');
        const options = { knownLorebooks: ['Existing Book'], extraBooks: ['Also Missing', 'Existing Book'] };
        const messages = await rules(character, options);
        expect(messages).toEqual([
            'The linked lorebook Missing Book does not exist.',
            'The extra lorebook Also Missing does not exist.',
        ]);
        const shared = findMissingLorebookLinks(cardLorebookLinks(character, options.extraBooks), options.knownLorebooks);
        expect(shared.map(link => link.name)).toEqual(['Missing Book', 'Also Missing']);
    });

    test('silent while the list is unknown, warns when it is known and empty', async () => {
        const character = card('Missing Book');
        expect(await rules(character, {})).toEqual([]);
        expect(await rules(character, { knownLorebooks: null })).toEqual([]);
        expect(await rules(character, { knownLorebooks: [] })).toEqual(['The linked lorebook Missing Book does not exist.']);
    });
});

describe('telling the person once per chat open', () => {
    const link = { kind: LOREBOOK_LINK_KIND.chat, name: 'Gone' };

    test('the same link in the same open is told once', () => {
        noteLorebookChatOpened('chat-a');
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([link]);
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([]);
        expect(filterUntoldLorebookLinks('chat-a', [link])).toEqual([]);
        noteLorebookChatOpened('chat-a');
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([]);
    });

    test('opening the chat again after another one tells again', () => {
        noteLorebookChatOpened('');
        noteLorebookChatOpened('chat-a');
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([link]);
        noteLorebookChatOpened('chat-b');
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([]);
        noteLorebookChatOpened('chat-a');
        expect(takeUntoldLorebookLinks('chat-a', [link])).toEqual([link]);
    });
});

describe('the Conversation reader', () => {
    test('says nothing is open until a reader is registered, and survives a reader that throws', () => {
        setConversationLorebookReader(null);
        expect(readConversationLorebooks()).toBeNull();
        setConversationLorebookReader(() => { throw new Error('not ready'); });
        expect(readConversationLorebooks()).toBeNull();
        setConversationLorebookReader(() => null);
        expect(readConversationLorebooks()).toBeNull();
    });

    test('lists one override per member of a group Conversation, once each', () => {
        setConversationLorebookReader(() => ({ key: 'conversation:group:7', overrides: ['Shared', 'Shared', '', undefined, 'Other'] }));
        const state = readConversationLorebooks();
        expect(state.key).toBe('conversation:group:7');
        const links = listLorebookLinks({ conversationOverrides: state.overrides });
        expect(links.map(link => [link.kind, link.name])).toEqual([
            [LOREBOOK_LINK_KIND.conversation, 'Shared'],
            [LOREBOOK_LINK_KIND.conversation, 'Other'],
        ]);
        expect(findMissingLorebookLinks(links, ['Other']).map(link => link.name)).toEqual(['Shared']);
        setConversationLorebookReader(null);
    });
});

describe('a card that carries its own copy of the lorebook', () => {
    test('marks only the main link, and only when the card has an embedded book', () => {
        const plain = cardLorebookLinks(card('Main'), ['Extra']);
        expect(plain.map(link => link.embedded)).toEqual([false, undefined]);
        const embedded = cardLorebookLinks({ ...card('Main'), data: { name: 'Ada', extensions: { world: 'Main' }, character_book: { name: 'Main', entries: [] } } }, ['Extra']);
        expect(embedded.map(link => [link.kind, link.embedded])).toEqual([[LOREBOOK_LINK_KIND.cardMain, true], [LOREBOOK_LINK_KIND.cardExtra, undefined]]);
        expect(listLorebookLinks({ cards: [{ ...card('Main'), data: { extensions: { world: 'Main' }, character_book: {} } }] })[0].embedded).toBe(true);
    });
});

describe('what the person said no to', () => {
    const cardLink = { kind: LOREBOOK_LINK_KIND.cardMain, name: 'Gone', avatar: 'Ada.png' };
    const chatLink = { kind: LOREBOOK_LINK_KIND.chat, name: 'Gone chat' };

    test('a dismissed card link stays quiet in every chat of the card, a new link still warns', () => {
        noteLorebookChatOpened('');
        noteLorebookChatOpened('ada|one');
        const other = { kind: LOREBOOK_LINK_KIND.cardExtra, name: 'Other', avatar: 'Ada.png' };
        dismissLorebookLinks('ada|one', [cardLink]);
        expect(filterUntoldLorebookLinks('ada|one', [cardLink, other])).toEqual([other]);
        noteLorebookChatOpened('ada|two');
        expect(filterUntoldLorebookLinks('ada|two', [cardLink, other])).toEqual([other]);
        expect(takeUntoldLorebookLinks('ada|two', [cardLink, other])).toEqual([other]);
    });

    test('a dismissed chat link belongs to that chat only', () => {
        noteLorebookChatOpened('bea|one');
        dismissLorebookLinks('bea|one', [chatLink]);
        expect(filterUntoldLorebookLinks('bea|one', [chatLink])).toEqual([]);
        noteLorebookChatOpened('bea|two');
        expect(filterUntoldLorebookLinks('bea|two', [chatLink])).toEqual([chatLink]);
    });

    test('a notice cleared because the chat changed is not an answer', () => {
        const link = { kind: LOREBOOK_LINK_KIND.cardMain, name: 'Cleared', avatar: 'Cy.png' };
        noteLorebookChatOpened('cy|one');
        let cleared = 0;
        registerLorebookNotice({ links: [link], clear: () => { cleared++; } });
        expect(takeUntoldLorebookLinks('cy|one', [link])).toEqual([link]);
        noteLorebookChatOpened('cy|one');
        expect(cleared).toBe(0);
        noteLorebookChatOpened('cy|two');
        expect(cleared).toBe(1);
        noteLorebookChatOpened('cy|one');
        expect(filterUntoldLorebookLinks('cy|one', [link])).toEqual([link]);
    });

    test('clearing for one card leaves a notice about other links alone', () => {
        const mine = { kind: LOREBOOK_LINK_KIND.cardMain, name: 'A', avatar: 'Di.png' };
        let cleared = 0;
        registerLorebookNotice({ links: [mine], clear: () => { cleared++; } });
        expect(clearLorebookNotice(link => link.avatar === 'Other.png')).toBe(false);
        expect(cleared).toBe(0);
        expect(clearLorebookNotice(link => link.avatar === 'Di.png')).toBe(true);
        expect(cleared).toBe(1);
        expect(clearLorebookNotice()).toBe(false);
    });
});
