/* global globalThis */
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

let wording;
let notices;
beforeAll(async () => {
    wording = await import('../public/scripts/save-failure-wording.js');
    notices = await import('../public/scripts/save-failure-notices.js');
});

const uncertain = reason => Object.assign(new Error('The save could not be confirmed. Keep a copy of your edits before reloading.'), { code: 'ROLEPLAY_SAVE_UNCERTAIN', reason });
const reply = (status, data) => ({ ok: false, status, data });
const blamesConnection = text => /connection|could not reach|internet/i.test(text);

describe('save failure kinds', () => {
    test('only a save that never reached Neconyan\'s server counts as unreachable', () => {
        const kind = wording.saveFailureKind;
        expect(kind(new TypeError('Failed to fetch'))).toBe('unreachable');
        expect(kind(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('unreachable');
        expect(kind(new TypeError('Load failed'))).toBe('unreachable');
        expect(kind(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe('unreachable');
        expect(kind(uncertain('unreachable'))).toBe('unreachable');
        expect(kind(null, reply(502, null))).toBe('unreachable');
        expect(kind(null, reply(504, '<html>Gateway Timeout</html>'))).toBe('unreachable');
        expect(kind(Object.assign(new Error('Failed to save settings: Bad Gateway'), { status: 503, data: null }))).toBe('unreachable');
    });

    test('a reply from the server is never blamed on the connection', () => {
        const kind = wording.saveFailureKind;
        expect(kind(null, reply(503, { error: 'roleplay_recovery_required', code: 'ELOCKED' }))).toBe('server');
        expect(kind(null, reply(500, { error: { message: 'disk full' } }))).toBe('server');
        expect(kind(null, reply(500, null))).toBe('server');
        expect(kind(null, reply(429, { error: 'busy' }))).toBe('server');
        expect(kind(uncertain('server'))).toBe('server');
        expect(kind(null, reply(400, { error: 'roleplay_invalid' }))).toBe('refused');
        expect(kind(null, reply(409, { error: 'destructive' }))).toBe('refused');
        expect(kind(null, reply(409, { error: 'account_changed' }))).toBe('stale');
        expect(kind(Object.assign(new Error('changed'), { code: 'ROLEPLAY_ACCOUNT_CHANGED' }))).toBe('stale');
        expect(kind(Object.assign(new Error('read'), { code: 'ROLEPLAY_READ_REQUIRED' }))).toBe('stale');
    });

    test('a blocked save chain says it is still checking, and local mistakes stay local', () => {
        const kind = wording.saveFailureKind;
        expect(kind(uncertain())).toBe('verifying');
        expect(kind(uncertain('verifying'))).toBe('verifying');
        expect(kind(new TypeError('Cannot read properties of undefined'))).toBe('local');
        expect(kind(new Error('Chat was not saved'))).toBe('local');
        expect(kind(Object.assign(new Error('wrapped'), { saveFailure: 'server' }))).toBe('server');
        expect(kind(Object.assign(new Error('wrapped'), { saveFailure: 'nonsense' }))).toBe('local');
    });

    test('an offline browser makes any thrown error an unreachable one', () => {
        const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
        try {
            expect(wording.saveFailureKind(new Error('anything'))).toBe('unreachable');
            expect(wording.saveFailureKind(null)).toBe('local');
        } finally {
            if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
            else delete globalThis.navigator;
        }
    });
});

describe('save failure wording', () => {
    test('each kind says what happened, and only unreachable mentions the connection', () => {
        for (const message of [wording.chatSaveFailureMessage, wording.settingsSaveFailureMessage, wording.deletionSaveFailureMessage]) {
            expect(blamesConnection(message('unreachable'))).toBe(true);
            for (const kind of ['verifying', 'server', 'refused', 'stale', 'changed', 'local']) {
                expect(blamesConnection(message(kind))).toBe(false);
            }
            for (const kind of wording.SAVE_FAILURE_KINDS) {
                expect(message(kind)).not.toMatch(/\u2014|Check your connection to Neconyan|Could not reach the server/);
                expect(message(kind)).toMatch(/\.$/);
            }
        }
    });

    test('chat notices keep the tab open while a retry is still possible', () => {
        for (const kind of ['unreachable', 'verifying', 'server']) {
            expect(wording.chatSaveFailureMessage(kind)).toMatch(/keep this tab open/i);
            expect(wording.chatSaveFailureMessage(kind)).not.toMatch(/reload/i);
        }
        expect(wording.chatSaveFailureMessage('verifying')).toMatch(/earlier save/);
        expect(wording.chatSaveFailureMessage('refused')).toMatch(/turned this save down/);
        expect(wording.deletionSaveFailureMessage('unreachable')).toMatch(/nothing was deleted/);
        expect(wording.deletionSaveFailureMessage('verifying')).toMatch(/still checking whether an earlier save went through, so nothing was deleted/);
        expect(wording.chatSaveFailureMessage('changed')).toMatch(/changed somewhere else, so Neconyan stopped saving here/);
        expect(wording.deletionSaveFailureMessage('changed')).toMatch(/changed somewhere else, so nothing was deleted/);
        expect(wording.saveFailureKind(uncertain('changed'))).toBe('changed');
    });
});

describe('reporting a chat save failure', () => {
    afterEach(() => {
        delete globalThis.toastr;
    });

    test('records the kind for the chat and shows one notice', () => {
        globalThis.toastr = { error: jest.fn() };
        const key = notices.chatSaveNoticeKey('Nova.png', 'Report');
        expect(wording.reportChatSaveFailure(key, 'Chat could not be saved', { error: uncertain('unreachable') })).toBe('unreachable');
        expect(wording.reportChatSaveFailure(key, 'Chat could not be saved', { error: uncertain('unreachable') })).toBe('unreachable');
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(wording.chatSaveFailureMessage('unreachable'), 'Chat could not be saved', expect.any(Object));
        expect(notices.lastSaveFailure(key)).toBe('unreachable');
        notices.clearSaveFailureNotice(key);
        expect(notices.lastSaveFailure(key)).toBeNull();
    });

    test('a quiet report only records the kind, and a server notice wins over the generic text', () => {
        globalThis.toastr = { error: jest.fn() };
        const key = notices.chatSaveNoticeKey('Nova.png', 'Quiet');
        expect(wording.reportChatSaveFailure(key, 'Chat could not be saved', { response: reply(503, { error: 'roleplay_recovery_required' }), quiet: true })).toBe('server');
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(notices.lastSaveFailure(key)).toBe('server');
        wording.reportChatSaveFailure(key, 'Chat could not be saved', { response: reply(507, { error: 'roleplay_store_full' }), notice: 'Neconyan ran out of room.' });
        expect(globalThis.toastr.error).toHaveBeenCalledWith('Neconyan ran out of room.', 'Chat could not be saved', expect.any(Object));
        notices.clearSaveFailureNotice(key);
    });

    test('an outage whose cause flips between attempts still shows one notice, but a lasting cause gets its own', () => {
        globalThis.toastr = { error: jest.fn() };
        const key = notices.chatSaveNoticeKey('Nova.png', 'Flipping');
        for (const error of [uncertain('unreachable'), uncertain('server'), uncertain('verifying'), uncertain('unreachable')]) {
            wording.reportChatSaveFailure(key, 'Chat could not be saved', { error });
        }
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(wording.chatSaveFailureMessage('unreachable'), 'Chat could not be saved', expect.any(Object));
        expect(notices.lastSaveFailure(key)).toBe('unreachable');
        wording.reportChatSaveFailure(key, 'Chat could not be saved', { error: uncertain('changed') });
        wording.reportChatSaveFailure(key, 'Chat could not be saved', { error: uncertain('changed') });
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(2);
        expect(globalThis.toastr.error).toHaveBeenLastCalledWith(wording.chatSaveFailureMessage('changed'), 'Chat could not be saved', expect.any(Object));
        notices.clearSaveFailureNotice(key);
    });

    test('a reported error carries its kind so outer catches do not report it twice', () => {
        const error = new Error('boom');
        expect(wording.markReportedSaveFailure(error, 'server')).toBe(error);
        expect(error).toMatchObject({ saveFailure: 'server', saveFailureReported: true });
        expect(wording.saveFailureKind(error)).toBe('server');
        const frozen = Object.freeze(new Error('frozen'));
        expect(wording.markReportedSaveFailure(frozen, 'server')).toBe(frozen);
        expect(wording.markReportedSaveFailure(null, 'server')).toBeNull();
    });
});
