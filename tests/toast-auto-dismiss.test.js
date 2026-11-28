import { afterEach, beforeEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    MAX_VISIBLE_ALERT_TOASTS,
    MIN_AUTO_CLOSE_TOAST_MS,
    installToastMinimumDuration,
    withMinimumToastDuration,
} from '../public/scripts/toast-duration.js';

const readPublic = file => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const publicRoot = new URL('../public/', import.meta.url).pathname;

function sliceFunction(source, signature) {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf('\nfunction ', start + signature.length);
    return source.slice(start, next === -1 ? undefined : next);
}

function listFirstPartyScripts(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'third-party' || entry.name === 'lib' || entry.name === 'node_modules') continue;
            files.push(...listFirstPartyScripts(full));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

describe('auto-closing toasts stay for at least 5 seconds', () => {
    test('the minimum is 5 seconds and the app default matches it', () => {
        expect(MIN_AUTO_CLOSE_TOAST_MS).toBe(5000);
        const script = readPublic('script.js');
        const options = script.slice(script.indexOf('toastr.options = {'), script.indexOf('installToastMinimumDuration(toastr);'));
        expect(options).toMatch(/\n {4}timeOut: 5000,/);
        expect(script).toMatch(/import \{ installToastMinimumDuration \} from '\.\/scripts\/toast-duration\.js';/);
    });

    test('short delays are raised while sticky and longer toasts are left alone', () => {
        expect(withMinimumToastDuration({ timeOut: 2000, extendedTimeOut: 1500, preventDuplicates: true }))
            .toEqual({ timeOut: 5000, extendedTimeOut: 5000, preventDuplicates: true });
        const sticky = { timeOut: 0, extendedTimeOut: 0 };
        expect(withMinimumToastDuration(sticky)).toBe(sticky);
        const long = { timeOut: 10000 };
        expect(withMinimumToastDuration(long)).toBe(long);
        expect(withMinimumToastDuration(undefined)).toBeUndefined();
    });

    test('installing wraps every toast method once and forwards the raised options', () => {
        const calls = [];
        const record = name => jest.fn((...args) => { calls.push([name, ...args]); return name; });
        const api = {
            options: { timeOut: 4000, extendedTimeOut: 10000 },
            info: record('info'),
            success: record('success'),
            warning: record('warning'),
            error: record('error'),
        };

        installToastMinimumDuration(api);
        const wrappedInfo = api.info;
        installToastMinimumDuration(api);
        expect(api.info).toBe(wrappedInfo);
        expect(api.options.timeOut).toBe(5000);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(api.info('Copied!', '', { timeOut: 2000 })).toBe('info');
            api.success('Saved', 'Title', { timeOut: 1500 });
            expect(api.warning('Hold on', 'Title', { timeOut: 0 })).toBe('warning');
            expect(api.error('Oops')).toBe('error');
            expect(warn.mock.calls).toEqual([
                ['[Neconyan] Warning notice: Title - Hold on'],
                ['[Neconyan] Error notice: Oops'],
            ]);
        } finally {
            warn.mockRestore();
        }

        expect(calls).toEqual([
            ['info', 'Copied!', '', { timeOut: 5000 }],
            ['success', 'Saved', 'Title', { timeOut: 5000 }],
            ['warning', 'Hold on', 'Title', { timeOut: 0 }],
            ['error', 'Oops', undefined, undefined],
        ]);
    });

    test('no first-party toast asks for less than 5 seconds', () => {
        const offenders = [];
        const shortDelay = /\b(?:timeOut|extendedTimeOut)\s*:\s*([1-9]\d{0,3})\b/g;
        for (const file of [path.join(publicRoot, 'script.js'), ...listFirstPartyScripts(path.join(publicRoot, 'scripts'))]) {
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(shortDelay)) {
                if (Number(match[1]) < MIN_AUTO_CLOSE_TOAST_MS) {
                    offenders.push(`${path.relative(publicRoot, file)}: ${match[0]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('post-generation agent running toasts close after 5 seconds while intercept toasts stay', () => {
        const source = readPublic('scripts/extensions/in-chat-agents/agent-runner.js');
        expect(source).toMatch(/const POST_GEN_RUNNING_TOAST_TIMEOUT_MS = 5000;/);

        const body = sliceFunction(source, 'function showPromptTransformRunningToast');
        expect(body).toMatch(/const dismissDelay = kind === 'postGen' \? POST_GEN_RUNNING_TOAST_TIMEOUT_MS : 0;/);
        expect(body).toMatch(/timeOut: dismissDelay,/);
        expect(body).toMatch(/extendedTimeOut: dismissDelay,/);
        expect(body).toMatch(/onHidden\(\) \{[\s\S]*?activePromptTransformToasts\.delete\(toast\)/);
    });

    test('external media blocked toast closes after 5 seconds', () => {
        const source = readPublic('scripts/chats.js');
        const start = source.indexOf('t`External media has been blocked`');
        expect(start).toBeGreaterThan(-1);
        const options = source.slice(start, source.indexOf('accountStorage.setItem(warningShownKey', start));
        expect(options).toMatch(/timeOut: 5000,/);
        expect(options).toMatch(/extendedTimeOut: 5000,/);
        expect(options).not.toMatch(/timeOut: 0/);
    });
});

/**
 * A stand-in for toastr 2.1 that keeps its timing rules: a toast closes after timeOut, mouseenter
 * clears the close timer and shows the toast again, and mouseleave starts a new extendedTimeOut timer.
 */
function createFakeToastr() {
    const shown = [];
    const api = {
        options: { timeOut: 5000, extendedTimeOut: 10000, escapeHtml: true },
        clear: jest.fn(toast => {
            toast.close();
        }),
    };
    for (const type of ['info', 'success', 'warning', 'error']) {
        api[type] = jest.fn((message, title, override) => {
            const settings = { ...api.options, ...override };
            const element = {
                isConnected: true,
                hidden: false,
                hovered: false,
                matches: selector => selector === ':hover' && element.hovered,
                contains: () => false,
            };
            let timer = null;
            const toast = {
                0: element,
                type,
                message,
                title,
                close() {
                    clearTimeout(timer);
                    element.isConnected = false;
                },
                triggerHandler(event) {
                    if (event === 'mouseenter') {
                        clearTimeout(timer);
                        element.hidden = false;
                    }
                    if (event === 'mouseleave' && (settings.timeOut > 0 || settings.extendedTimeOut > 0)) {
                        timer = setTimeout(() => toast.close(), settings.extendedTimeOut);
                    }
                },
                stop: jest.fn(),
                hide: jest.fn(() => {
                    element.hidden = true;
                }),
            };
            if (settings.timeOut > 0) {
                timer = setTimeout(() => toast.close(), settings.timeOut);
            }
            shown.push(toast);
            return toast;
        });
    }
    installToastMinimumDuration(api);
    const onScreen = () => shown.filter(toast => toast[0].isConnected && !toast[0].hidden);
    const waiting = () => shown.filter(toast => toast[0].isConnected && toast[0].hidden);
    return { api, shown, onScreen, waiting };
}

describe('error and warning toast bursts', () => {
    let warn;

    beforeEach(() => {
        jest.useFakeTimers();
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
        jest.useRealTimers();
    });

    test('a burst of identical errors or warnings keeps one toast on screen and logs it once plus one repeat line', () => {
        const { api, shown, onScreen } = createFakeToastr();

        const first = api.error('Network down', 'Save failed');
        for (let index = 0; index < 19; index++) {
            expect(api.error('Network down', 'Save failed')).toBe(first);
        }
        const warning = api.warning('Still retrying', 'Sync');
        for (let index = 0; index < 9; index++) {
            expect(api.warning('Still retrying', 'Sync')).toBe(warning);
        }

        expect(shown).toHaveLength(2);
        expect(onScreen()).toEqual([first, warning]);
        expect(warn.mock.calls).toEqual([
            ['[Neconyan] Error notice: Save failed - Network down'],
            ['[Neconyan] Error notice (repeated, kept the one already on screen): Save failed - Network down'],
            ['[Neconyan] Warning notice: Sync - Still retrying'],
            ['[Neconyan] Warning notice (repeated, kept the one already on screen): Sync - Still retrying'],
        ]);
    });

    test('a repeat restarts the close timer with at least the minimum time, and a closed toast can show again', () => {
        const { api, shown } = createFakeToastr();

        const first = api.error('Network down', 'Save failed', { timeOut: 2000, extendedTimeOut: 1000 });
        jest.advanceTimersByTime(3000);
        expect(api.error('Network down', 'Save failed', { timeOut: 2000, extendedTimeOut: 1000 })).toBe(first);
        jest.advanceTimersByTime(MIN_AUTO_CLOSE_TOAST_MS - 1);
        expect(first[0].isConnected).toBe(true);
        jest.advanceTimersByTime(1);
        expect(first[0].isConnected).toBe(false);

        const again = api.error('Network down', 'Save failed');
        expect(again).not.toBe(first);
        expect(shown).toHaveLength(2);
        expect(warn.mock.calls.at(-1)).toEqual(['[Neconyan] Error notice: Save failed - Network down']);
    });

    test('notices that differ in type, title or text, carry callbacks or are built from elements are never merged', () => {
        const { api, shown } = createFakeToastr();

        api.error('Network down', 'Save failed');
        api.error('Network down', 'Upload failed');
        api.warning('Network down', 'Save failed');
        api.error('Disk full', 'Save failed');
        api.error('Network down', 'Save failed', { timeOut: 0, extendedTimeOut: 0 });
        expect(shown).toHaveLength(5);

        const other = createFakeToastr();
        const details = { onclick: () => {} };
        other.api.warning('Open details', 'Tool failed', details);
        other.api.warning('Open details', 'Tool failed', details);
        const element = { text: () => '  Chat file\n is   locked  ' };
        other.api.error(element, 'Busy');
        other.api.error(element, 'Busy');
        expect(other.shown).toHaveLength(4);
        expect(warn).toHaveBeenCalledWith('[Neconyan] Error notice: Busy - Chat file is locked');
    });

    test(`at most ${MAX_VISIBLE_ALERT_TOASTS} auto-closing alerts show at once; the rest wait their turn and none is dropped`, () => {
        expect(MAX_VISIBLE_ALERT_TOASTS).toBe(4);
        const { api, shown, onScreen, waiting } = createFakeToastr();

        const early = [1, 2, 3, 4].map(index => api.error(`Problem ${index}`, 'Failed', { timeOut: 20000 }));
        const late = [5, 6].map(index => api.warning(`Problem ${index}`, 'Failed'));

        expect(shown).toHaveLength(6);
        expect(onScreen()).toEqual(early);
        expect(waiting()).toEqual(late);
        expect(warn).toHaveBeenCalledWith('[Neconyan] Warning notice (waiting for space on screen): Failed - Problem 5');
        expect(warn).toHaveBeenCalledWith('[Neconyan] Warning notice (waiting for space on screen): Failed - Problem 6');

        // Nothing on screen is cut short before it has had the minimum time.
        jest.advanceTimersByTime(MIN_AUTO_CLOSE_TOAST_MS - 1);
        expect(onScreen()).toEqual(early);
        expect(api.clear).not.toHaveBeenCalled();

        jest.advanceTimersByTime(250);
        expect(api.clear.mock.calls).toEqual([[early[0], { force: true }], [early[1], { force: true }]]);
        expect(onScreen()).toEqual([early[2], early[3], ...late]);
        expect(waiting()).toEqual([]);

        // A toast let in late still gets its full minimum time.
        jest.advanceTimersByTime(MIN_AUTO_CLOSE_TOAST_MS - 251);
        expect(late.every(toast => toast[0].isConnected)).toBe(true);
    });

    test('a waiting alert shows as soon as a visible one closes by itself', () => {
        const { api, onScreen, waiting } = createFakeToastr();

        const early = [1, 2, 3, 4].map(index => api.error(`Problem ${index}`, 'Failed'));
        const late = api.error('Problem 5', 'Failed');
        expect(waiting()).toEqual([late]);

        jest.advanceTimersByTime(MIN_AUTO_CLOSE_TOAST_MS);
        expect(early.every(toast => !toast[0].isConnected)).toBe(true);
        expect(onScreen()).toEqual([late]);
        expect(api.clear).not.toHaveBeenCalled();
    });

    test('a toast under the pointer is not moved aside to make room', () => {
        const { api, onScreen } = createFakeToastr();

        const early = [1, 2, 3, 4].map(index => api.error(`Problem ${index}`, 'Failed', { timeOut: 20000 }));
        early[0][0].hovered = true;
        const late = api.error('Problem 5', 'Failed');

        jest.advanceTimersByTime(MIN_AUTO_CLOSE_TOAST_MS + 250);
        expect(api.clear.mock.calls).toEqual([[early[1], { force: true }]]);
        expect(onScreen()).toEqual([early[0], early[2], early[3], late]);
    });

    test('toasts that stay until dismissed always show at once and do not count towards the limit', () => {
        const { api, onScreen, waiting } = createFakeToastr();

        const autoClosing = [1, 2, 3, 4].map(index => api.error(`Problem ${index}`, 'Failed'));
        const sticky = [1, 2, 3].map(index => api.error(`Action needed ${index}`, 'Failed', { timeOut: 0, extendedTimeOut: 0 }));
        expect(onScreen()).toEqual([...autoClosing, ...sticky]);

        const next = api.error('Problem 5', 'Failed');
        expect(waiting()).toEqual([next]);
    });

    test('info and success toasts are not logged, and HTML notices are logged as plain text', () => {
        const { api } = createFakeToastr();

        api.info('Copied');
        api.success('Saved');
        expect(warn).not.toHaveBeenCalled();

        api.error('<b>Disk</b> full', 'Upload <i>failed</i>', { escapeHtml: false });
        api.warning('x'.repeat(700));
        expect(warn.mock.calls).toEqual([
            ['[Neconyan] Error notice: Upload failed - Disk full'],
            [`[Neconyan] Warning notice: ${'x'.repeat(600)}...`],
        ]);
    });
});
