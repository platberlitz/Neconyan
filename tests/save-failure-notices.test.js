/* global globalThis */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, jest, test } from '@jest/globals';
import {
    SAVE_FAILURE_REMINDER_MS,
    chatSaveNoticeKey,
    clearSaveFailureNotice,
    groupChatSaveNoticeKey,
    lastSaveFailure,
    noteSaveFailure,
    showSaveFailureNotice,
    showUndoneChangeNotice,
    suppressedSaveFailureNotices,
} from '../public/scripts/save-failure-notices.js';

const MESSAGE = 'Neconyan could not reach its server, so recent changes are not saved yet.';
const TITLE = 'Chat could not be saved';

describe('save failure notices', () => {
    test('repeated failures for one chat show one toast while it is on screen and for a while after', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Repeat');
        const show = jest.fn();
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1000)).toBe(true);
        for (let index = 1; index <= 20; index++) {
            expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1000 + index * 100)).toBe(false);
        }
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(MESSAGE, TITLE, { onHidden: expect.any(Function) });
        expect(suppressedSaveFailureNotices(key)).toBe(20);

        show.mock.calls[0][2].onHidden();
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1000 + SAVE_FAILURE_REMINDER_MS - 1)).toBe(false);
        expect(show).toHaveBeenCalledTimes(1);
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1000 + SAVE_FAILURE_REMINDER_MS)).toBe(true);
        expect(show).toHaveBeenCalledTimes(2);
        clearSaveFailureNotice(key);
    });

    test('a visible notice is never stacked, however long it stays open', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Hovered');
        const show = jest.fn();
        showSaveFailureNotice(key, MESSAGE, TITLE, show, 0);
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, SAVE_FAILURE_REMINDER_MS * 3)).toBe(false);
        expect(show).toHaveBeenCalledTimes(1);
        clearSaveFailureNotice(key);
    });

    test('a successful save resets the chat, so the next failure is shown at once', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Recovered');
        const show = jest.fn();
        showSaveFailureNotice(key, MESSAGE, TITLE, show, 0);
        clearSaveFailureNotice(key);
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1)).toBe(true);
        expect(show).toHaveBeenCalledTimes(2);
        clearSaveFailureNotice(key);
    });

    test('other chats and different notices are shown separately', () => {
        const show = jest.fn();
        const first = chatSaveNoticeKey('Nova.png', 'One');
        const second = chatSaveNoticeKey('Nova.png', 'Two');
        const group = groupChatSaveNoticeKey('One');
        expect(new Set([first, second, group]).size).toBe(3);
        expect(showSaveFailureNotice(first, MESSAGE, TITLE, show, 0)).toBe(true);
        expect(showSaveFailureNotice(second, MESSAGE, TITLE, show, 0)).toBe(true);
        expect(showSaveFailureNotice(group, MESSAGE, 'Group Chat could not be saved', show, 0)).toBe(true);
        expect(showSaveFailureNotice(first, 'Neconyan storage is full.', TITLE, show, 1)).toBe(true);
        expect(show).toHaveBeenCalledTimes(4);
        for (const key of [first, second, group]) clearSaveFailureNotice(key);
    });

    test('notices of one family stand in for each other, while other notices still show', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Family');
        const show = jest.fn();
        const family = { family: 'not-saved-yet' };
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 0, family)).toBe(true);
        expect(showSaveFailureNotice(key, 'Neconyan\'s server could not finish saving.', TITLE, show, 1, family)).toBe(false);
        expect(showSaveFailureNotice(key, 'Neconyan is still checking an earlier save.', TITLE, show, 2, family)).toBe(false);
        expect(showSaveFailureNotice(key, 'The saved copy changed somewhere else.', TITLE, show, 3)).toBe(true);
        expect(showSaveFailureNotice(key, MESSAGE, 'Group Chat could not be saved', show, 4, family)).toBe(true);
        expect(show).toHaveBeenCalledTimes(3);
        clearSaveFailureNotice(key);
    });

    test('a toast that fails to open does not hide the next attempt', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Broken toast');
        const broken = jest.fn(() => { throw new Error('toast unavailable'); });
        expect(() => showSaveFailureNotice(key, MESSAGE, TITLE, broken, 0)).toThrow('toast unavailable');
        const show = jest.fn();
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1)).toBe(true);
        clearSaveFailureNotice(key);
    });

    test('a chat remembers why its latest save failed until it saves again', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Remembered');
        expect(lastSaveFailure(key)).toBeNull();
        noteSaveFailure(key, 'unreachable');
        expect(lastSaveFailure(key)).toBe('unreachable');
        expect(lastSaveFailure(chatSaveNoticeKey('Nova.png', 'Other'))).toBeNull();
        noteSaveFailure(key, 'verifying');
        expect(lastSaveFailure(key)).toBe('verifying');
        clearSaveFailureNotice(key);
        expect(lastSaveFailure(key)).toBeNull();
    });

    test('a put-back change gets its own notice, repeated only once the previous one has gone', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Put back');
        const show = jest.fn();
        const message = 'Neconyan could not reach its server, so nothing was deleted.';
        showSaveFailureNotice(key, MESSAGE, TITLE, show, 0);
        expect(showUndoneChangeNotice(key, message, 'Message not deleted', show)).toBe(true);
        expect(showUndoneChangeNotice(key, message, 'Message not deleted', show)).toBe(false);
        expect(showUndoneChangeNotice(key, message, 'Messages not deleted', show)).toBe(true);
        show.mock.calls[2][2].onHidden();
        expect(showUndoneChangeNotice(key, message, 'Messages not deleted', show)).toBe(true);
        expect(show).toHaveBeenCalledTimes(4);
        clearSaveFailureNotice(key);
    });

    test('chat and group chat saves route every failure notice through the coalescer', async () => {
        const read = file => fs.readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
        const [script, groups] = await Promise.all([read('../public/script.js'), read('../public/scripts/group-chats.js')]);
        for (const source of [script, groups]) {
            expect(source).not.toMatch(/toastr\.error\([^\n]*`(?:Group )?Chat could not be saved`/);
        }
        const groupSave = groups.slice(groups.indexOf('async function saveGroupChatImmediately'),
            groups.indexOf('export async function', groups.indexOf('async function saveGroupChatImmediately')));
        // A thrown save (a dropped connection) used to escape to the debounced caller, which only logged it.
        expect(groupSave).toMatch(/try \{\n\s+response = await saveRoleplayChatRequest\(roleplaySave, \{[\s\S]+?\} catch \(error\) \{\n[^\n]*\n\s+console\.error\('Group chat could not be saved', error\);\n\s+const saveFailure = reportChatSaveFailure\(saveNoticeKey, t`Group Chat could not be saved`, \{ error, quiet: quietSaveFailure \}\);/);
        expect(groupSave).toContain('clearSaveFailureNotice(saveNoticeKey);');
        const chatSave = script.slice(script.indexOf('async function saveChatImmediately'),
            script.indexOf('async function read_avatar_load', script.indexOf('async function saveChatImmediately')));
        expect(chatSave).toContain('clearSaveFailureNotice(saveNoticeKey);');
        expect(chatSave).toContain('console.error(error);\n        if (!error?.saveFailureReported) {\n            markReportedSaveFailure(error, reportChatSaveFailure(saveNoticeKey,');
    });

    test('the default display uses the page toast library', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Default');
        const error = jest.fn();
        const previous = globalThis.toastr;
        globalThis.toastr = { error };
        try {
            expect(showSaveFailureNotice(key, MESSAGE, TITLE)).toBe(true);
            expect(error).toHaveBeenCalledWith(MESSAGE, TITLE, { onHidden: expect.any(Function) });
        } finally {
            globalThis.toastr = previous;
            clearSaveFailureNotice(key);
        }
    });
});
