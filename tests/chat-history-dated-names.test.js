import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const timestamp = '2026-10-02@09h08m07s006ms';
const simplifiedTimestamp = '2026-10-02 09-08-07';

function loadHistoryTools(overrides = {}) {
    const context = vm.createContext({
        escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        console,
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        ...overrides,
    });
    const functions = ['getChatBaseName', 'isDatedChatFileName', 'getExistingChatNameSet', 'autoLabelDatedChats', 'getChatCleanupCandidates']
        .map(name => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0]);
    vm.runInContext([
        source.match(/^const CHAT_LABEL_TIMESTAMP_PATTERN = .+;/m)[0],
        ...functions,
    ].join('\n'), context);
    return context;
}

describe('timestamp-named chat detection', () => {
    const { isDatedChatFileName } = loadHistoryTools();

    test.each([timestamp, simplifiedTimestamp])('recognises character, group and imported names using %s', date => {
        for (const name of [date, `${date} imported`, `${date}.JSONL`]) {
            expect(isDatedChatFileName(name, 'Rowan', true)).toBe(true);
        }
        for (const name of [`Rowan - ${date}`, `Old Character Name - ${date}`, `Rowan - ${date} imported.jsonl`]) {
            expect(isDatedChatFileName(name, 'Rowan')).toBe(true);
            expect(isDatedChatFileName(name, 'Rowan', true)).toBe(false);
        }
    });

    test.each([timestamp, simplifiedTimestamp])('recognises current and legacy branches using %s', date => {
        for (const name of [date, `${date} imported`, `Rowan - ${date}`, `Old Name - ${date} imported`]) {
            for (const branch of [`${name} - Branch #1`, `${name} - Branch #12.jsonl`, `Branch #3 - ${name}.jsonl`]) {
                expect(isDatedChatFileName(branch, 'Rowan')).toBe(true);
                expect(isDatedChatFileName(branch, 'Rowan', true)).toBe(!name.includes(' - '));
            }
        }
    });

    test.each([
        'Moonlit Escape', 'Moonlit Escape - Branch #1', 'Branch #2 - Moonlit Escape',
        '2026-10-02', 'Rowan - 2026-10-02', 'A trip on 2026-10-02 09-08-07',
        `Rowan - ${simplifiedTimestamp} notes`, `Rowan - ${timestamp} - Branch #one`,
        `Rowan - ${timestamp} - Branch #1 notes`, null, undefined, '',
    ])('leaves custom titles and non-matching names alone: %s', name => {
        expect(isDatedChatFileName(name, 'Rowan')).toBe(false);
        expect(isDatedChatFileName(name, 'Rowan', true)).toBe(false);
    });
});

describe('batch auto-labelling dated chats', () => {
    test.each([false, true])('offers every dated chat, including branches, without custom titles (group: %s)', async isGroupChat => {
        const prefix = isGroupChat ? '' : 'Rowan - ';
        const datedNames = [
            `${prefix}${timestamp}`, `${prefix}${simplifiedTimestamp}`,
            `${prefix}${timestamp} - Branch #1`, `${prefix}${simplifiedTimestamp} - Branch #12`,
            `Branch #2 - ${prefix}${simplifiedTimestamp}`, `${prefix}${simplifiedTimestamp} imported - Branch #3`,
        ];
        const customNames = ['Moonlit Escape', 'Moonlit Escape - Branch #1'];
        const popup = jest.fn(async () => 1);
        const autoLabelChatFile = jest.fn(async name => ({ status: 'renamed', newFileName: `Label ${datedNames.indexOf(name)}` }));
        const displayPastChats = jest.fn();
        const signal = new AbortController().signal;
        const activeChat = [{ mes: 'A message in the current dated chat.' }];
        const context = loadHistoryTools({
            searchPastChats: async () => [...datedNames, ...customNames].map(file_name => ({ file_name: `${file_name}.jsonl` })),
            getCurrentChatDetails: () => ({ sessionName: datedNames[1], characterName: 'Rowan' }),
            selected_group: isGroupChat ? 'group-id' : null,
            chat: activeChat,
            structuredClone,
            escapeHtml: String,
            callGenericPopup: popup,
            POPUP_TYPE: { CONFIRM: 1 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
            beginChatHistoryTool: () => signal,
            saveChatConditional: jest.fn(),
            throwIfChatHistoryToolAborted: jest.fn(),
            setChatHistoryStatus: jest.fn(),
            autoLabelChatFile,
            displayPastChats,
            endChatHistoryTool: jest.fn(),
            toastr: { info: jest.fn(), success: jest.fn(), error: jest.fn() },
        });

        await context.autoLabelDatedChats();

        expect(popup.mock.calls[0][0]).toContain('<p>6 chat(s)');
        expect(autoLabelChatFile.mock.calls.map(([name]) => name)).toEqual(datedNames);
        expect(autoLabelChatFile.mock.calls[1][1]).toMatchObject({ sourceChat: activeChat, force: true, reloadCurrent: false, signal });
        expect(displayPastChats).toHaveBeenCalledWith(['Label 5']);
        expect(context.toastr.success).toHaveBeenCalledWith('Auto-labeled 6/6 chat(s).', 'Auto-label Chat');
        expect(context.toastr.error).not.toHaveBeenCalled();
    });
});

describe('dated-chat cleanup safeguards', () => {
    test('still protects the active chat, kept chats, recent chats and custom titles', async () => {
        const names = [
            `Rowan - ${simplifiedTimestamp} - Branch #1`,
            `Rowan - ${simplifiedTimestamp}`,
            `Rowan - ${timestamp} - Branch #2`,
            `Branch #3 - Rowan - ${simplifiedTimestamp}`,
            `Rowan - ${timestamp}`,
            'Moonlit Escape - Branch #1',
            `Rowan - ${simplifiedTimestamp} imported - Branch #4`,
        ];
        const context = loadHistoryTools({
            searchPastChats: async () => names.map((file_name, index) => ({ file_name: `${file_name}.jsonl`, last_mes: index })),
            getCurrentChatDetails: () => ({ sessionName: names[1], characterName: 'Rowan' }),
            selected_group: null,
            getClampedChatToolInteger: selector => selector === '#chat_cleanup_age' ? 90 : 1,
            getCleanupUnit: () => 'days',
            $: () => ({ prop: () => true }),
            moment: () => ({ subtract: () => 'cutoff' }),
            timestampToMoment: index => ({ isValid: () => index !== 4, isBefore: () => index !== 2 }),
        });

        expect((await context.getChatCleanupCandidates()).map(chat => chat.file_name)).toEqual([names[3], names[6]]);
    });
});
