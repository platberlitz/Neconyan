import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    isLorebookAgent,
    parseLorebookEntries,
    sendCompanionResultToLorebook,
} from '../public/scripts/extensions/in-chat-agents/companion/lorebook-sender.js';

function createContext({ attachedBook = '', existingTitles = [], auxiliaryBooks = [], confirmResult = 1, importedBook = false, saveFailures = 0 } = {}) {
    const names = attachedBook ? [attachedBook] : [];
    const books = {};
    let remainingSaveFailures = saveFailures;
    const worldInfoSettings = auxiliaryBooks.length > 0
        ? { charLore: [{ name: 'Scout', extraBooks: [...auxiliaryBooks] }] }
        : {};
    if (attachedBook) {
        books[attachedBook] = {
            entries: Object.fromEntries(existingTitles.map((comment, uid) => [uid, { uid, comment }])),
        };
        if (importedBook) {
            books[attachedBook].originalData = {
                entries: existingTitles.map((comment, id) => ({ id, comment })),
            };
            books[attachedBook].originalDataUidMap = Object.fromEntries(existingTitles.map((_, uid) => [uid, uid]));
        }
    }

    const context = {
        chatMetadata: attachedBook ? { world_info: attachedBook } : {},
        characters: [{ avatar: 'Scout.png' }],
        characterId: 0,
        groupId: null,
        groups: [],
        worldInfoSettings,
        POPUP_TYPE: { CONFIRM: 'confirm' },
        POPUP_RESULT: { AFFIRMATIVE: 1 },
        callGenericPopup: jest.fn(async () => confirmResult),
        getWorldInfoNames: jest.fn(() => [...names]),
        createNewWorldInfo: jest.fn(async name => {
            names.push(name);
            books[name] = { entries: {} };
            return true;
        }),
        updateChatMetadata: jest.fn(values => Object.assign(context.chatMetadata, values)),
        saveMetadata: jest.fn(async () => {}),
        loadWorldInfo: jest.fn(async name => books[name] ?? null),
        createWorldInfoEntry: jest.fn((_name, data) => {
            const uid = Object.keys(data.entries).length;
            const entry = {
                uid,
                key: [],
                keysecondary: [],
                comment: '',
                content: '',
                constant: false,
                selective: true,
                disable: false,
            };
            data.entries[uid] = entry;
            if (data.originalData && Array.isArray(data.originalData.entries)) {
                data.originalDataUidMap ??= {};
                data.originalDataUidMap[uid] = data.originalData.entries.length;
                data.originalData.entries.push({
                    id: uid,
                    keys: [],
                    secondary_keys: [],
                    comment: '',
                    content: '',
                    constant: false,
                    selective: true,
                    enabled: true,
                });
            }
            return entry;
        }),
        syncWIOriginalDataEntry: jest.fn((data, uid) => {
            const index = data.originalDataUidMap?.[uid];
            const entry = data.entries[uid];
            if (!Number.isInteger(index) || !entry) {
                return;
            }
            data.originalData.entries[index] = {
                ...data.originalData.entries[index],
                id: uid,
                keys: [...entry.key],
                secondary_keys: [...entry.keysecondary],
                comment: entry.comment,
                content: entry.content,
                constant: entry.constant,
                selective: entry.selective,
                enabled: !entry.disable,
            };
        }),
        // Real immediate saves resolve to the committed book name, or null when the host discards the write.
        saveWorldInfo: jest.fn(async (name, data) => {
            if (remainingSaveFailures > 0) {
                remainingSaveFailures--;
                throw new Error('Simulated lorebook save failure.');
            }
            books[name] = structuredClone(data);
            return name;
        }),
        charUpdateAddAuxWorld: jest.fn(async (avatar, name) => {
            const fileName = avatar.replace(/\.[^/.]+$/, '');
            worldInfoSettings.charLore ??= [];
            let characterLore = worldInfoSettings.charLore.find(entry => entry.name === fileName);
            if (!characterLore) {
                characterLore = { name: fileName, extraBooks: [] };
                worldInfoSettings.charLore.push(characterLore);
            }
            characterLore.extraBooks.push(name);
        }),
    };

    return { books, context };
}

describe('Lorebook Scout sender', () => {
    let notifier;

    beforeEach(() => {
        notifier = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
    });

    test('recognises the opt-in tag case-insensitively', () => {
        expect(isLorebookAgent({ tags: ['notes', 'LoreBook'] })).toBe(true);
        expect(isLorebookAgent({ tags: ['notes', 'world info'] })).toBe(false);
    });

    test('parses multiple drafts and bold Keys labels', () => {
        const entries = parseLorebookEntries([
            '**The Ember Gate**',
            '**Keys:** Ember Gate, ash gate, Cinder Road',
            'The Ember Gate seals the Cinder Road whenever its braziers go dark.',
            '',
            '**Moon Well:**',
            'Keys: Moon Well, silver water',
            'The Moon Well reflects the sky of the next clear night.',
        ].join('\n'));

        expect(entries).toEqual([
            {
                title: 'The Ember Gate',
                keys: ['Ember Gate', 'ash gate', 'Cinder Road'],
                content: 'The Ember Gate seals the Cinder Road whenever its braziers go dark.',
            },
            {
                title: 'Moon Well',
                keys: ['Moon Well', 'silver water'],
                content: 'The Moon Well reflects the sky of the next clear night.',
            },
        ]);
        expect(parseLorebookEntries('Lorebook has nothing durable this turn.')).toEqual([]);
        expect(() => parseLorebookEntries('A plain paragraph without a title.')).toThrow('title');
        expect(() => parseLorebookEntries('**Gate**\nA gate.')).toThrow('Keys');
        expect(() => parseLorebookEntries('**Gate**\nKeys:\nA gate.')).toThrow('at least 2');
        expect(() => parseLorebookEntries('**Gate**\nKeys: gate\nA gate.')).toThrow('at least 2');
        expect(parseLorebookEntries('**Gate**\nKeys: one, two, three, four, five, six\nA gate.')[0].keys)
            .toEqual(['one', 'two', 'three', 'four', 'five']);
        expect(parseLorebookEntries('**Keys of the Vault**\n**Keys:** vault, keyring\nA hidden keyring.')[0].title)
            .toBe('Keys of the Vault');
    });

    test('writes new entries once and skips normalized duplicate titles on repeat sends', async () => {
        const { books, context } = createContext({
            attachedBook: 'Campaign Lore',
            existingTitles: ['  the   ember gate  '],
        });
        const content = [
            '**The Ember Gate**',
            'Keys: Ember Gate, Cinder Road',
            'The Ember Gate seals the Cinder Road.',
            '',
            '**Moon Well**',
            'Keys: Moon Well, silver water',
            'The Moon Well reflects tomorrow night\'s sky.',
        ].join('\n');

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Campaign Lore',
            created: 1,
            duplicates: 1,
        });
        expect(books['Campaign Lore'].entries[1]).toEqual(expect.objectContaining({
            comment: 'Moon Well',
            key: ['Moon Well', 'silver water'],
            content: 'The Moon Well reflects tomorrow night\'s sky.',
            selective: false,
            constant: false,
            disable: false,
        }));
        expect(context.saveWorldInfo).toHaveBeenCalledWith('Campaign Lore', books['Campaign Lore'], true, { conditional: true });

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Campaign Lore',
            created: 0,
            duplicates: 2,
        });
        expect(context.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(context.createNewWorldInfo).not.toHaveBeenCalled();
        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(notifier.success).toHaveBeenCalledWith('Added 1 lorebook entry to "Campaign Lore". Skipped 1 duplicate.');
        expect(notifier.info).toHaveBeenCalledWith('No new entries added to "Campaign Lore"; 2 already exist.');
    });

    test('synchronizes new entries into imported character-book data', async () => {
        const { books, context } = createContext({
            attachedBook: 'Imported Lore',
            importedBook: true,
        });

        await sendCompanionResultToLorebook(
            '**Moon Well**\nKeys: Moon Well, silver water\nThe Moon Well reflects tomorrow night\'s sky.',
            context,
            notifier,
        );

        expect(books['Imported Lore'].originalData.entries[0]).toEqual(expect.objectContaining({
            id: 0,
            keys: ['Moon Well', 'silver water'],
            secondary_keys: [],
            comment: 'Moon Well',
            content: 'The Moon Well reflects tomorrow night\'s sky.',
            constant: false,
            selective: false,
            enabled: true,
        }));
    });

    test('creates and attaches the fallback book when the chat has none', async () => {
        const { books, context } = createContext();

        await expect(sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        )).resolves.toEqual({ bookName: 'Lorebook Scout', created: 1, duplicates: 0 });

        expect(context.createNewWorldInfo).toHaveBeenCalledWith('Lorebook Scout');
        expect(context.updateChatMetadata).toHaveBeenCalledWith({ world_info: 'Lorebook Scout' });
        expect(context.saveMetadata).toHaveBeenCalledTimes(1);
        expect(context.saveWorldInfo.mock.invocationCallOrder[0])
            .toBeLessThan(context.updateChatMetadata.mock.invocationCallOrder[0]);
        expect(books['Lorebook Scout'].entries[0].key).toEqual(['Sun Dial', 'rain omen']);
        expect(context.callGenericPopup).toHaveBeenCalledWith(
            'Attach \'Lorebook Scout\' to this chat and these characters: Scout.png? Character attachments also apply in their other chats.',
            'confirm',
        );
        expect(context.charUpdateAddAuxWorld).toHaveBeenCalledWith('Scout.png', 'Lorebook Scout');

        await sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        );
        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.charUpdateAddAuxWorld).toHaveBeenCalledTimes(1);
    });

    test('keeps a declined fallback book detached from the current chat', async () => {
        const { books, context } = createContext({ confirmResult: 0 });

        await sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        );

        expect(books['Lorebook Scout'].entries[0].comment).toBe('Sun Dial');
        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.updateChatMetadata).not.toHaveBeenCalled();
        expect(context.saveMetadata).not.toHaveBeenCalled();
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
    });

    test('a failed fallback save leaves the cached book untouched and can be retried', async () => {
        const { books, context } = createContext({ saveFailures: 1 });
        const content = '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.';
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toBeNull();
        expect(consoleError).toHaveBeenCalled();
        expect(context.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(context.updateChatMetadata).not.toHaveBeenCalled();
        expect(books['Lorebook Scout'].entries).toEqual({});

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Lorebook Scout',
            created: 1,
            duplicates: 0,
        });
        expect(context.saveWorldInfo).toHaveBeenCalledTimes(2);
        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.updateChatMetadata).toHaveBeenCalledWith({ world_info: 'Lorebook Scout' });
        consoleError.mockRestore();
    });

    test('skips the confirmation when Lorebook Scout is already an auxiliary lorebook', async () => {
        const { context } = createContext({
            attachedBook: 'Lorebook Scout',
            auxiliaryBooks: ['Lorebook Scout'],
        });

        await sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        );

        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
    });

    test('adds Lorebook Scout only to group members that do not already use it', async () => {
        const { context } = createContext({
            attachedBook: 'Lorebook Scout',
            auxiliaryBooks: ['Lorebook Scout'],
        });
        context.characters.push({ avatar: 'Other.png' });
        context.groupId = 'group-1';
        context.groups = [{ id: 'group-1', members: ['Scout.png', 'Other.png'] }];

        await sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        );

        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.charUpdateAddAuxWorld).toHaveBeenCalledTimes(1);
        expect(context.charUpdateAddAuxWorld).toHaveBeenCalledWith('Other.png', 'Lorebook Scout');
    });

    test('keeps the entry when auxiliary lorebook confirmation is declined', async () => {
        const { books, context } = createContext({
            attachedBook: 'Lorebook Scout',
            confirmResult: 0,
        });

        await sendCompanionResultToLorebook(
            '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        );

        expect(books['Lorebook Scout'].entries[0].comment).toBe('Sun Dial');
        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
    });
});

describe('Lorebook Scout sender honours the host save contract', () => {
    const content = '**Sun Dial**\nKeys: Sun Dial, rain omen\nThe Sun Dial rings at noon when rain is coming.';
    let notifier;

    beforeEach(() => {
        notifier = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
    });

    test('a discarded save is reported as a failure and can be retried from the original note', async () => {
        const { context } = createContext();
        context.saveWorldInfo.mockResolvedValueOnce(null);
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toBeNull();
        expect(notifier.success).not.toHaveBeenCalled();
        expect(notifier.error).toHaveBeenCalledTimes(1);
        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(context.updateChatMetadata).not.toHaveBeenCalled();

        // The failed private draft was never published into the cached book.
        await sendCompanionResultToLorebook(content, context, notifier);
        expect(context.saveWorldInfo).toHaveBeenCalledTimes(2);
        consoleError.mockRestore();
    });

    test('a renamed committed book is reported and attached under its new name', async () => {
        const { context } = createContext();
        context.saveWorldInfo.mockResolvedValueOnce('Lorebook Scout (1)');

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Lorebook Scout (1)',
            created: 1,
            duplicates: 0,
        });
        expect(notifier.success).toHaveBeenCalledWith(expect.stringContaining('"Lorebook Scout (1)"'));
        expect(context.updateChatMetadata).toHaveBeenCalledWith({ world_info: 'Lorebook Scout (1)' });
    });

    test('a failed attachment save rolls the attachment back and warns', async () => {
        const { context } = createContext();
        context.saveMetadata.mockResolvedValueOnce(false);

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Lorebook Scout',
            created: 1,
            duplicates: 0,
        });
        expect(context.chatMetadata.world_info).toBeUndefined();
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
        expect(notifier.warning).toHaveBeenCalledWith(expect.stringContaining('attaching it to the chat failed'));
    });

    test.each(['loadWorldInfo', 'saveWorldInfo', 'callGenericPopup'])('navigation during %s cannot attach to the next chat', async boundary => {
        const { context } = createContext();
        context.chatId = 'original';
        const oldCall = context[boundary].getMockImplementation();
        const nextMetadata = {};
        context[boundary].mockImplementationOnce(async (...args) => {
            const result = await oldCall(...args);
            context.chatId = 'next';
            context.chatMetadata = nextMetadata;
            return result;
        });
        await sendCompanionResultToLorebook(content, context, notifier);
        expect(context.updateChatMetadata).not.toHaveBeenCalled();
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
        expect(nextMetadata).toEqual({});
    });

    test('a failed attachment completing after navigation cannot roll back the next chat', async () => {
        const { context } = createContext();
        const originalMetadata = context.chatMetadata;
        const nextMetadata = { world_info: 'New chat lore' };
        context.saveMetadata.mockImplementationOnce(async () => {
            context.chatId = 'next';
            context.chatMetadata = nextMetadata;
            return false;
        });
        await sendCompanionResultToLorebook(content, context, notifier);
        expect(nextMetadata.world_info).toBe('New chat lore');
        expect(originalMetadata.world_info).toBeUndefined();
        expect(context.updateChatMetadata).toHaveBeenCalledTimes(1);
        expect(context.charUpdateAddAuxWorld).not.toHaveBeenCalled();
    });
});
