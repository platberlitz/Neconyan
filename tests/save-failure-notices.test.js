/* global globalThis */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, jest, test } from '@jest/globals';
import {
    SAVE_FAILURE_REMINDER_MS,
    chatSaveNoticeKey,
    clearSaveFailureNotice,
    groupChatSaveNoticeKey,
    showSaveFailureNotice,
    suppressedSaveFailureNotices,
} from '../public/scripts/save-failure-notices.js';

const MESSAGE = 'Check your connection to Neconyan, then reload the page to avoid losing changes.';
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

    test('a toast that fails to open does not hide the next attempt', () => {
        const key = chatSaveNoticeKey('Nova.png', 'Broken toast');
        const broken = jest.fn(() => { throw new Error('toast unavailable'); });
        expect(() => showSaveFailureNotice(key, MESSAGE, TITLE, broken, 0)).toThrow('toast unavailable');
        const show = jest.fn();
        expect(showSaveFailureNotice(key, MESSAGE, TITLE, show, 1)).toBe(true);
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
        expect(groupSave).toMatch(/try \{\n\s+response = await saveRoleplayChatRequest\(roleplaySave, \{[\s\S]+?\} catch \(error\) \{\n[^\n]*\n\s+console\.error\('Group chat could not be saved', error\);\n\s+showSaveFailureNotice\(saveNoticeKey, unsavedNotice\(\), t`Group Chat could not be saved`\);/);
        expect(groupSave).toContain('clearSaveFailureNotice(saveNoticeKey);');
        const chatSave = script.slice(script.indexOf('async function saveChatImmediately'),
            script.indexOf('async function read_avatar_load', script.indexOf('async function saveChatImmediately')));
        expect(chatSave).toContain('clearSaveFailureNotice(saveNoticeKey);');
        expect(chatSave).toContain('console.error(error);\n        showSaveFailureNotice(saveNoticeKey,');
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
