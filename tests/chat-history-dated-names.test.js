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

describe('background chat renames', () => {
    function loadRename(overrides = {}) {
        const pick = name => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '');
        const requests = [];
        const context = vm.createContext({
            console,
            JSON,
            DOMException,
            Error,
            String,
            Number,
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
            characters: [{ avatar: 'rowan.png', chat: 'Rowan - 2026-10-02 09-08-07', name: 'Rowan' }],
            this_chid: 0,
            selected_group: null,
            chat_metadata: {},
            chat: [{ mes: 'Hello.' }, { mes: 'Hi.', is_user: true }],
            chatGeneration: 4,
            isChatSaving: false,
            this_edit_mes_id: undefined,
            hasPendingChatSave: () => false,
            getCurrentChatId() { return context.characters[0].chat; },
            getStringHash: () => 1,
            equalsIgnoreCaseAndAccents: (a, b) => a.toLowerCase() === b.toLowerCase(),
            flushPendingChatSaves: jest.fn(async () => true),
            beginChatNameCommit: jest.fn(() => jest.fn()),
            uuidv4: () => 'operation',
            getRequestHeaders: () => ({}),
            sendRoleplayLifecycle: async (url, body) => {
                requests.push(body);
                return { ok: true, json: async () => ({ sanitizedFileName: body.renamed_file.replace(/\.jsonl$/, '') }) };
            },
            updateRemoteChatName: jest.fn(async (characterId, name) => { context.characters[characterId].chat = name; }),
            renameGroupChat: jest.fn(),
            $: () => ({ val: jest.fn() }),
            loader: { show: jest.fn() },
            reloadCurrentChat: jest.fn(async () => {}),
            refreshCurrentChatFromSaved: jest.fn(async () => {}),
            loadRoleplayChat: jest.fn(async () => ({ records: [{ chat_metadata: {} }, ...context.chat], evidence: { source: 'renamed' } })),
            rememberRoleplayRead: jest.fn(() => true),
            eventSource: { emit: jest.fn(async () => {}) },
            event_types: { CHAT_RENAMED: 'chat_renamed' },
            toastr: { warning: jest.fn() },
            delay: jest.fn(async () => {}),
            callGenericPopup: jest.fn(async () => {}),
            POPUP_TYPE: { TEXT: 1 },
            document: { createElement: () => ({ setAttribute() {}, append() {} }) },
            ...overrides,
        });
        vm.runInContext([pick('getChatBaseName'), pick('adoptRenamedChatRead'), pick('renameGroupOrCharacterChat')].join('\n'), context);
        return { context, requests };
    }

    const rename = (context, options) => context.renameGroupOrCharacterChat({
        characterId: 0, groupId: null, oldFileName: 'Rowan - 2026-10-02 09-08-07', newFileName: 'Rowan - Moonlit Escape', loader: false, ...options,
    });

    test('keeps the open chat on screen and adopts the renamed file so the next save still works', async () => {
        const { context, requests } = loadRename();
        await expect(rename(context, { reloadCurrent: 'saved', showErrorPopup: false })).resolves.toEqual({ oldFileName: 'Rowan - 2026-10-02 09-08-07', newFileName: 'Rowan - Moonlit Escape' });
        expect(requests).toHaveLength(1);
        expect(context.flushPendingChatSaves).toHaveBeenCalledWith({ silent: true });
        expect(context.loadRoleplayChat).toHaveBeenCalledWith({ group: false, avatar: 'rowan.png', chat: 'Rowan - Moonlit Escape' });
        expect(context.rememberRoleplayRead).toHaveBeenCalledWith({ group: false, avatar: 'rowan.png', chat: 'Rowan - Moonlit Escape' }, { source: 'renamed' });
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
        expect(context.refreshCurrentChatFromSaved).not.toHaveBeenCalled();
        expect(context.eventSource.emit).toHaveBeenCalledWith('chat_renamed', expect.objectContaining({ newFileName: 'Rowan - Moonlit Escape.jsonl' }));
    });

    test('uses a saved-chat refresh when needed without a destructive reload if that fails', async () => {
        const { context } = loadRename();
        context.loadRoleplayChat.mockResolvedValue({ records: [{}, { mes: 'Something the server added.' }], evidence: {} });
        await rename(context, { reloadCurrent: 'saved' });
        expect(context.rememberRoleplayRead).not.toHaveBeenCalled();
        expect(context.refreshCurrentChatFromSaved).toHaveBeenCalledTimes(1);
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();

        context.refreshCurrentChatFromSaved.mockRejectedValue(new Error('The chat is already being refreshed.'));
        context.characters[0].chat = 'Rowan - 2026-10-02 09-08-07';
        await rename(context, { reloadCurrent: 'saved' });
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
    });

    test('keeps unsaved messages when the renamed file cannot supply matching read evidence', async () => {
        const { context } = loadRename();
        context.loadRoleplayChat.mockImplementation(async () => {
            context.chat.push({ mes: 'Keep this unsaved message.', is_user: true });
            throw new Error('Connection lost');
        });
        await rename(context, { reloadCurrent: 'saved', showErrorPopup: false });
        expect(context.chat.at(-1).mes).toBe('Keep this unsaved message.');
        expect(context.refreshCurrentChatFromSaved).not.toHaveBeenCalled();
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
        expect(context.beginChatNameCommit.mock.results[0].value).toHaveBeenCalledTimes(1);
    });

    test('a manual rename still reloads the chat as before', async () => {
        const { context } = loadRename();
        await rename(context, {});
        expect(context.flushPendingChatSaves).toHaveBeenCalledWith({ silent: false });
        expect(context.reloadCurrentChat).toHaveBeenCalledTimes(1);
        expect(context.loadRoleplayChat).not.toHaveBeenCalled();
    });

    test('adopts the saved predecessor without replacing a new message typed during the rename', async () => {
        const { context } = loadRename();
        const saved = structuredClone(context.chat);
        context.loadRoleplayChat.mockImplementation(async () => {
            context.chat.push({ mes: 'Keep this new message.', is_user: true });
            return { records: [{}, ...saved], evidence: { source: 'renamed' } };
        });
        await rename(context, { reloadCurrent: 'saved', showErrorPopup: false });
        expect(context.chat.at(-1).mes).toBe('Keep this new message.');
        expect(context.rememberRoleplayRead).toHaveBeenCalledTimes(1);
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
        expect(context.refreshCurrentChatFromSaved).not.toHaveBeenCalled();
        const release = context.beginChatNameCommit.mock.results[0].value;
        expect(release).toHaveBeenCalledTimes(1);
    });

    test('a background rename that can no longer commit sends nothing and shows no popup', async () => {
        const { context, requests } = loadRename();
        const canCommit = jest.fn(() => false);
        await expect(rename(context, { reloadCurrent: 'saved', canCommit, showErrorPopup: false })).rejects.toMatchObject({ name: 'AbortError' });
        expect(canCommit).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(0);
        expect(context.characters[0].chat).toBe('Rowan - 2026-10-02 09-08-07');
        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(context.delay).not.toHaveBeenCalled();
    });

    test('a failed background rename stays quiet; a failed manual rename still explains itself', async () => {
        const failing = { sendRoleplayLifecycle: async () => ({ ok: false, json: async () => ({}) }) };
        const background = loadRename(failing).context;
        await expect(rename(background, { reloadCurrent: 'saved', showErrorPopup: false })).rejects.toThrow('Unsuccessful chat rename request.');
        expect(background.callGenericPopup).not.toHaveBeenCalled();
        const manual = loadRename(failing).context;
        await expect(rename(manual, {})).rejects.toThrow('Unsuccessful chat rename request.');
        expect(manual.callGenericPopup).toHaveBeenCalledWith('An error has occurred. Chat was not renamed.', 1);
    });
});

describe('automatic chat naming wiring', () => {
    test('listens for finished replies and Agents, cancels on chat, model and user activity, and leaves its own renames alone', () => {
        const init = source.slice(source.indexOf('function initChatAutoNaming()'), source.indexOf('function getCleanupUnit()'));
        expect(init).toContain('event_types.MESSAGE_RECEIVED, event_types.GENERATION_ENDED, event_types.GROUP_WRAPPER_FINISHED');
        expect(init).toContain('\'neconyan:roleplay-workflow-finished\'');
        expect(init).toContain('if (!dryRun && !options?.isAuxiliaryGeneration) chatAutoNamer.cancel();');
        expect(init).toMatch(/event_types\.CHAT_CHANGED, event_types\.MAIN_API_CHANGED, event_types\.CHATCOMPLETION_SOURCE_CHANGED,\s+event_types\.CHATCOMPLETION_MODEL_CHANGED, event_types\.CONNECTION_PROFILE_LOADED/);
        expect(init).toContain('if (chatAutoNamer.isCommitting()) return;');
        expect(source).toContain('initChatAutoNaming();');
        expect(source).toContain('hasConnection: () => online_status !== \'no_connection\',');
        expect(source).toMatch(/reloadCurrent: 'saved',\s+canCommit,\s+showErrorPopup: false,/);
    });

    test('refreshes the top bar, chat bar and bottom bar titles after a rename', () => {
        const tabs = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        expect(tabs.match(/eventTypes\.CHAT_CHANGED,\n\s+eventTypes\.CHAT_RENAMED,/g)).toHaveLength(3);
    });
});

describe('automatic chat naming targets', () => {
    function loadTargets(overrides = {}) {
        const pick = name => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '');
        const context = vm.createContext({
            JSON,
            String,
            Boolean,
            Set,
            document: { body: { classList: { contains: () => false } } },
            roleplayAccountStamp: () => ({ owner: 'default-user' }),
            characters: [{ avatar: 'rowan.png', chat: 'Rowan - 2026-10-02 09-08-07' }, { avatar: 'nori.png', chat: 'x', data: { extensions: { neconyan_assistant: { id: 'nori' } } } }],
            this_chid: 0,
            selected_group: null,
            chat: [{ mes: 'Hello.' }],
            chat_metadata: {},
            chatGeneration: 2,
            getCurrentChatId() { return context.selected_group ? 'Group 2026-10-02 09-08-07' : context.characters[context.this_chid]?.chat; },
            getCurrentChatDetails: () => ({ characterName: 'Rowan' }),
            ...overrides,
        });
        vm.runInContext([
            source.match(/^const CHAT_AUTO_NAME_MANUAL_KEY = .+;/m)[0],
            source.match(/^const manuallyNamedChats = .+;/m)[0],
            ...['getChatBaseName', 'getChatAutoNameKey', 'getChatAutoNameTarget', 'rememberManualChatRename'].map(pick),
            'this.manuallyNamedChats = manuallyNamedChats;',
        ].join('\n'), context);
        return context;
    }

    test('describes the open character or group chat, and skips assistants, Conversation and temporary chats', () => {
        const context = loadTargets();
        expect(context.getChatAutoNameTarget()).toMatchObject({ fileName: 'Rowan - 2026-10-02 09-08-07', displayName: 'Rowan', isGroup: false, generation: 2, manual: false });
        context.selected_group = 'g1';
        expect(context.getChatAutoNameTarget()).toMatchObject({ fileName: 'Group 2026-10-02 09-08-07', isGroup: true });
        context.selected_group = null;
        context.this_chid = 1;
        expect(context.getChatAutoNameTarget()).toBeNull();
        context.this_chid = undefined;
        expect(context.getChatAutoNameTarget()).toBeNull();
        expect(loadTargets({ document: { body: { classList: { contains: name => name === 'neconyan-conversation-active' } } } }).getChatAutoNameTarget()).toBeNull();
        expect(loadTargets({ roleplayAccountStamp: () => { throw new Error('account changed'); } }).getChatAutoNameTarget()).toBeNull();
    });

    test('a manual rename protects only the chat that was renamed, even with a date-like name', () => {
        const context = loadTargets();
        context.rememberManualChatRename({ avatarId: 'rowan.png', groupId: undefined, newFileName: 'Rowan - 2026-01-01 01-01-01.jsonl' });
        expect(context.getChatAutoNameTarget().manual).toBe(false);
        expect(context.chat_metadata.neconyan_manual_chat_name).toBeUndefined();

        context.characters[0].chat = 'Rowan - 2026-01-01 01-01-01';
        expect(context.getChatAutoNameTarget().manual).toBe(true);

        context.rememberManualChatRename({ avatarId: 'rowan.png', newFileName: 'Rowan - 2026-01-01 01-01-01.jsonl' });
        expect(context.chat_metadata.neconyan_manual_chat_name).toBe(true);
        const reloaded = loadTargets({ chat_metadata: { neconyan_manual_chat_name: true } });
        expect(reloaded.getChatAutoNameTarget().manual).toBe(true);
    });
});
