import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
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

        expect(api.info('Copied!', '', { timeOut: 2000 })).toBe('info');
        api.success('Saved', 'Title', { timeOut: 1500 });
        api.warning('Hold on', 'Title', { timeOut: 0 });
        api.error('Oops');

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
