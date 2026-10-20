/* global globalThis */
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { load } from 'cheerio';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { IMAGE_INPUT_SETTINGS_CHANGED } from '../public/scripts/prompt-media-policy.js';
import { assembleLocaleData } from '../public/scripts/locale-assembly.js';
import { createLifecycleScope } from '../public/scripts/extensions/quick-image-gen/lib/lifecycle.js';
import {
    bindImageInputRefreshEvents, bindImageInputRefreshPage, IMAGE_INPUT_REFRESH_EVENTS, INLINE_MEDIA_CHECKBOX_ID, WORKSPACE_STATE_CHANGED,
} from '../public/scripts/extensions/quick-image-gen/lib/image-input-refresh.js';

// Quick Image Gen is too large to load, so the functions under test are cut out of its source as they stand and run against stand-ins.
const dictionary = new Map();
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ translate: (text, key = null) => dictionary.get(key || text) ?? text }));
const { twoLineToastHtml } = await import('../public/scripts/toast-lines.js');

const source = fs.readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const cutFunction = name => {
    const found = syntax.body.find(row => row.id?.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};
const cutStatement = name => {
    const found = syntax.body.find(row => row.type === 'VariableDeclaration' && row.declarations.some(item => item.id.name === name));
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};
// Every call in the file whose callee is the given name (a plain name or the property of a member), so a check can look for a shape instead of counting text.
const callsTo = (name, node = syntax, found = []) => {
    if (node?.type === 'CallExpression' && (node.callee.name === name || node.callee.property?.name === name)) found.push(node);
    for (const value of Object.values(node ?? {})) {
        if (Array.isArray(value)) value.forEach(item => callsTo(name, item, found));
        else if (value && typeof value === 'object') callsTo(name, value, found);
    }
    return found;
};
const realLocaleFile = name => JSON.parse(fs.readFileSync(new URL(`../public/locales/${name}.json`, import.meta.url), 'utf8'));
const englishCatalogue = realLocaleFile('neconyan/en');
const portuguese = assembleLocaleData({ base: realLocaleFile('pt-pt'), supplement: realLocaleFile('neconyan/pt-pt'), catalogue: englishCatalogue }).dictionary;
// The stand-ins follow i18n.js: translate is one exact lookup, and t builds a ${0} key, translates it, then fills the holes.
const translateInPortuguese = (text, key = null) => portuguese[key || text] ?? text;
const tInPortuguese = (strings, ...values) => {
    const key = strings.reduce((result, string, index) => result + string + (values[index] !== undefined ? `\${${index}}` : ''), '');
    return translateInPortuguese(key).replace(/\$\{(\d+)\}/g, (match, index) => values[index]);
};
const qigToastCall = (severity, text) => callsTo(severity).find(call => call.callee.object?.name === 'qigToast'
    && call.arguments[0] && new RegExp(text).test(source.slice(call.arguments[0].start, call.arguments[0].end)));
const evaluateToastMessage = (call, err) => vm.runInNewContext(source.slice(call.arguments[0].start, call.arguments[0].end),
    { err, translate: translateInPortuguese, t: tInPortuguese });
const evaluateEnglishToastMessage = (call, err) => vm.runInNewContext(source.slice(call.arguments[0].start, call.arguments[0].end),
    { err, translate: text => text, t: (strings, ...values) => strings.reduce((text, string, index) => text + string + (values[index] !== undefined ? String(values[index]) : ''), '') });
const optionValue = (call, name) => call.arguments[2]?.properties?.find(property => (property.key.name ?? property.key.value) === name)?.value?.value;

beforeEach(() => { dictionary.clear(); });

// The page fetches toast-lines.js with one import() call, the first time a toast needs it. The helpers around it are cut from the page's
// source as they stand; only that one call is swapped for a stand-in whose arrival the test controls.
const IMPORT_TOAST_LINES = 'import("../../toast-lines.js")';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function makeToastHelpers({ importToastLines = async () => ({ twoLineToastHtml }), qigToast } = {}) {
    const toasts = [];
    const logged = [];
    const recorder = severity => (...args) => { toasts.push([severity, ...args]); return true; };
    const host = { importToastLines: jest.fn(importToastLines), log: message => logged.push(message), translate: (text, key = null) => dictionary.get(key || text) ?? text,
        qigToast: qigToast ?? { error: recorder('error'), warning: recorder('warning') } };
    const code = [cutStatement('toastLinesModule'), cutFunction('loadToastLines'), cutFunction('showTwoLineToast'), cutFunction('insertFailureLines'), cutFunction('showInsertFailure')].join('\n');
    expect(code.split(IMPORT_TOAST_LINES)).toHaveLength(2);
    const context = vm.createContext(host);
    vm.runInContext(code.replace(IMPORT_TOAST_LINES, 'importToastLines()'), context);
    return { host, toasts, logged, showTwoLineToast: context.showTwoLineToast, showInsertFailure: context.showInsertFailure, loadToastLines: context.loadToastLines };
}

describe('the Right now line is refreshed on every trigger, and never polled', () => {
    const types = { CHAT_CHANGED: 'chat_id_changed', MAIN_API_CHANGED: 'main_api_changed', OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after', CONNECTION_PROFILE_LOADED: 'connection_profile_loaded', MESSAGE_RECEIVED: 'message_received' };
    const makeEventSource = () => {
        const handlers = new Map();
        return {
            handlers,
            on: (type, handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
            off: (type, handler) => handlers.set(type, (handlers.get(type) ?? []).filter(item => item !== handler)),
            emit: type => (handlers.get(type) ?? []).forEach(handler => handler()),
        };
    };
    const inputEvent = id => {
        const event = new Event('input');
        Object.defineProperty(event, 'target', { value: id === undefined ? null : { id } });
        return event;
    };

    test('the app events that can change what is sent each cause one refresh', () => {
        const eventSource = makeEventSource();
        const refresh = jest.fn();
        const lifecycle = createLifecycleScope();
        bindImageInputRefreshEvents(lifecycle, eventSource, types, refresh);
        expect(IMAGE_INPUT_REFRESH_EVENTS).toEqual(['CHAT_CHANGED', 'MAIN_API_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_LOADED']);
        for (const [index, name] of IMAGE_INPUT_REFRESH_EVENTS.entries()) {
            eventSource.emit(types[name]);
            expect(refresh).toHaveBeenCalledTimes(index + 1);
        }
        // Events that cannot change it do not refresh.
        eventSource.emit(types.MESSAGE_RECEIVED);
        eventSource.emit('settings_updated');
        expect(refresh).toHaveBeenCalledTimes(4);
        // Disposing the scope removes every listener.
        lifecycle.dispose();
        for (const name of IMAGE_INPUT_REFRESH_EVENTS) eventSource.emit(types[name]);
        expect(refresh).toHaveBeenCalledTimes(4);
    });

    test('an app that lacks one of the events, or has no event source, does not break the others', () => {
        const eventSource = makeEventSource();
        const refresh = jest.fn();
        const fewer = Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'CONNECTION_PROFILE_LOADED'));
        bindImageInputRefreshEvents(createLifecycleScope(), eventSource, fewer, refresh);
        eventSource.emit(types.MAIN_API_CHANGED);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect([...eventSource.handlers.keys()].sort()).toEqual(['chat_id_changed', 'main_api_changed', 'oai_preset_changed_after']);
        expect(() => bindImageInputRefreshEvents(createLifecycleScope(), null, types, refresh)).not.toThrow();
        expect(() => bindImageInputRefreshEvents(createLifecycleScope(), eventSource, undefined, refresh)).not.toThrow();
    });

    test('Conversation opening or closing, a setting changed in a dialog or User Settings, and the Send inline media checkbox each refresh', () => {
        const page = { window: new EventTarget(), document: new EventTarget(), defer: jest.fn(callback => callback()) };
        const refresh = jest.fn();
        const lifecycle = createLifecycleScope();
        bindImageInputRefreshPage(lifecycle, page, refresh);
        page.window.dispatchEvent(new Event(WORKSPACE_STATE_CHANGED));
        expect(page.defer).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        page.window.dispatchEvent(new CustomEvent(IMAGE_INPUT_SETTINGS_CHANGED));
        expect(refresh).toHaveBeenCalledTimes(2);
        page.document.dispatchEvent(inputEvent(INLINE_MEDIA_CHECKBOX_ID));
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(INLINE_MEDIA_CHECKBOX_ID).toBe('openai_media_inlining');
        // Input anywhere else on the page does not.
        page.document.dispatchEvent(inputEvent('send_textarea'));
        page.document.dispatchEvent(inputEvent());
        page.window.dispatchEvent(new Event('resize'));
        expect(refresh).toHaveBeenCalledTimes(3);
        lifecycle.dispose();
        page.window.dispatchEvent(new CustomEvent(IMAGE_INPUT_SETTINGS_CHANGED));
        page.document.dispatchEvent(inputEvent(INLINE_MEDIA_CHECKBOX_ID));
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    test('a workspace change is deferred to the next frame by default, as it was before', () => {
        const frames = [];
        globalThis.requestAnimationFrame = callback => frames.push(callback);
        try {
            const page = { window: new EventTarget(), document: new EventTarget() };
            const refresh = jest.fn();
            bindImageInputRefreshPage(createLifecycleScope(), page, refresh);
            page.window.dispatchEvent(new Event(WORKSPACE_STATE_CHANGED));
            expect(refresh).not.toHaveBeenCalled();
            frames.shift()();
            expect(refresh).toHaveBeenCalledTimes(1);
            // The other signals refresh at once.
            page.window.dispatchEvent(new CustomEvent(IMAGE_INPUT_SETTINGS_CHANGED));
            expect(refresh).toHaveBeenCalledTimes(2);
            expect(frames).toHaveLength(0);
        } finally { delete globalThis.requestAnimationFrame; }
    });

    test('Quick Image Gen wires both binders to one refresh function that logs a failure instead of throwing', async () => {
        expect(source).toContain('bindImageInputRefreshPage(pageLifecycleScope, { window, document }, refreshPromptImageEffectiveStateSoon);');
        expect(source).toContain('bindImageInputRefreshEvents(lifecycle, eventSource, eventTypes, refreshPromptImageEffectiveStateSoon);');
        expect(source).toContain('lifecycle.subscribe(eventSource, eventTypes.CHAT_CHANGED, handleHostChatChanged);');
        // The refresh is never polled: no setInterval, however its callback is written, mentions either refresh function.
        expect(callsTo('setInterval').map(call => source.slice(call.start, call.end)).filter(text => /refreshPromptImageEffectiveState/.test(text))).toEqual([]);
        const logged = [];
        const host = { log: message => logged.push(message), refreshPromptImageEffectiveState: async () => { throw new Error('damaged'); } };
        const soon = vm.runInNewContext(`(${cutFunction('refreshPromptImageEffectiveStateSoon')})`, host);
        expect(soon()).toBeUndefined();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(logged).toEqual(['damaged']);
    });
});

describe('automatic insertion shows the reason of the first failure', () => {
    const failedSentence = count => `${count === 1 ? 'One image' : `${count} images`} could not be inserted and remain available in the result viewer.`;
    // The failure toast is built by the page's own showTwoLineToast once toast-lines.js has arrived, so a test waits for it with `shown()`.
    function makeReporter({ undo = false } = {}) {
        const toasts = { success: [], warning: [] };
        const qigToast = { success: (...args) => toasts.success.push(args), warning: (...args) => toasts.warning.push(args) };
        const host = {
            hasChatInsertUndo: () => undo, lastChatInsertUndo: { id: 'undo-1' }, runChatInsertUndo: jest.fn(),
            displayImage: jest.fn(), displayBatchResults: jest.fn(), showTwoLineToast: makeToastHelpers({ qigToast }).showTwoLineToast, qigToast,
        };
        const report = vm.runInNewContext(`(${cutFunction('reportAutoInsertOutcome')})`, host);
        return { report, host, toasts, shown: settle };
    }
    const lines = html => load(`<div class="toast-message">${html}</div>`, null, false)('.toast-message');

    test('one failure: the existing sentence on line 1, its reason on line 2, with the throttle key and the result viewer as before', async () => {
        const { report, host, toasts, shown } = makeReporter();
        const entry = { url: 'a' };
        report(0, [entry], 'The image cannot be sent as it is.');
        // The result viewer opens at once; the toast follows when toast-lines.js has arrived.
        expect(host.displayImage).toHaveBeenCalledWith(entry);
        await shown();
        expect(toasts.warning).toHaveLength(1);
        const [html, title, options] = toasts.warning[0];
        expect(title).toBe('');
        expect(options).toEqual({ throttleKey: 'auto-insert-failed', escapeHtml: false });
        const message = lines(html);
        expect(message.contents().get(0).data).toBe(failedSentence(1));
        expect(message.children('br')).toHaveLength(1);
        expect(message.children('span').text()).toBe('The image cannot be sent as it is.');
        expect(message.children('span').attr('data-i18n-ignore')).toBe('');
        // The sentence line is not marked, so the run-time localiser handles it exactly as it did.
        expect(message.attr('data-i18n-ignore')).toBeUndefined();
        expect(host.displayImage).toHaveBeenCalledWith(entry);
        expect(host.displayBatchResults).not.toHaveBeenCalled();
        expect(toasts.success).toHaveLength(0);
    });

    test('several failures: the plural sentence and the first reason only', async () => {
        const { report, host, toasts, shown } = makeReporter();
        const entries = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
        report(0, entries, 'First reason.');
        await shown();
        const message = lines(toasts.warning[0][0]);
        expect(message.contents().get(0).data).toBe(failedSentence(3));
        expect(message.children('span').text()).toBe('First reason.');
        expect(host.displayBatchResults).toHaveBeenCalledWith(entries);
        expect(host.displayImage).not.toHaveBeenCalled();
    });

    test('no reason: exactly the sentence, as before, whatever shape the missing reason takes', async () => {
        for (const missing of [undefined, null, '', '   ']) {
            const { report, toasts, shown } = makeReporter();
            report(0, [{}], missing);
            await shown();
            expect(toasts.warning[0][0]).toBe(failedSentence(1));
            expect(toasts.warning[0][0]).not.toContain('<br>');
        }
        const { report, toasts, shown } = makeReporter();
        report(0, [{}]);
        await shown();
        expect(toasts.warning[0][0]).toBe(failedSentence(1));
        report(0, [{}, {}]);
        await shown();
        expect(toasts.warning[1][0]).toBe(failedSentence(2));
    });

    test('the reason is looked up by its exact text and escaped; a reason with markup shows literally', async () => {
        dictionary.set('Disk is full.', 'O disco está cheio.');
        const { report, toasts, shown } = makeReporter();
        report(0, [{}], 'Disk is full.');
        await shown();
        expect(lines(toasts.warning[0][0]).children('span').text()).toBe('O disco está cheio.');
        report(0, [{}], 'Bad <b>image</b> & <img src=x onerror=alert(1)>');
        await shown();
        const message = lines(toasts.warning[1][0]);
        expect(message.find('b, img')).toHaveLength(0);
        expect(message.children('span').text()).toBe('Bad <b>image</b> & <img src=x onerror=alert(1)>');
    });

    test('a two-part image refusal keeps both parts in the reason, so it says what to choose', async () => {
        const { report, toasts, shown } = makeReporter();
        report(0, [{}], 'The image cannot be sent as it is. It stays in the gallery; to insert it now, choose Show only or Use a description.\nThis image needs a compatible copy before it can be sent.');
        await shown();
        const text = lines(toasts.warning[0][0]).children('span').text();
        expect(text).toContain('choose Show only or Use a description');
        expect(text).toContain('compatible copy');
    });

    test('inserted images are reported as before, alongside a failure', async () => {
        const { report, host, toasts, shown } = makeReporter({ undo: true });
        report(1, [{}], 'Reason.');
        await shown();
        expect(toasts.success).toHaveLength(1);
        expect(toasts.success[0][0]).toBe('Image inserted into the chat. Click here to undo.');
        expect(toasts.success[0][2]).toMatchObject({ timeOut: 8000 });
        expect(toasts.warning).toHaveLength(1);
        const quiet = makeReporter();
        quiet.report(3, [], 'Ignored.');
        await quiet.shown();
        expect(quiet.toasts.success[0]).toEqual(['3 images inserted into the chat.', 'Quick Image Gen', { throttleKey: 'auto-insert-ok' }]);
        expect(quiet.toasts.warning).toHaveLength(0);
        expect(host.runChatInsertUndo).not.toHaveBeenCalled();
    });

    describe('the call sites carry the first failure\'s reason', () => {
        test('the Inject path passes the first error message, and an abort still stops it', async () => {
            const reports = [];
            const make = failure => {
                const host = { addToGallery: async () => {}, autoInsertInjectImage: async () => { if (failure) throw failure; }, log: () => {},
                    reportAutoInsertOutcome: (...args) => reports.push(args), assertGenerationCanCommit: () => {} };
                return vm.runInNewContext(`(${cutFunction('deliverInjectResultsSingle')})`, host);
            };
            const entry = { url: 'a' };
            const failing = make(new Error('Reason A.'));
            await expect(failing(entry, { settings: { injectInsertMode: 'replace' } })).resolves.toEqual({ inserted: 0, failed: [entry] });
            expect(reports.at(-1)).toEqual([0, [entry], 'Reason A.']);
            await make(null)(entry, { settings: { injectInsertMode: 'replace' } });
            expect(reports.at(-1)).toEqual([1, [], '']);
            const aborted = Object.assign(new Error('Stopped.'), { name: 'AbortError' });
            await expect(make(aborted)(entry, { settings: {} })).rejects.toBe(aborted);
        });

        test('the other two paths record the first message too, and report with it', () => {
            expect(source).toContain('firstReason ||= err.message;');
            expect(source).toContain('reportAutoInsertOutcome(insertedCount, failedResults, firstReason);');
            expect(source).toContain('reportAutoInsertOutcome(inserted, failed, firstReason);');
            // Every call passes a reason (a value, not a literal), and the throttle key is unchanged.
            const calls = callsTo('reportAutoInsertOutcome');
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.filter(call => call.arguments.length < 3 || call.arguments[2].type === 'Literal').map(call => source.slice(call.start, call.end))).toEqual([]);
            expect(source).toContain('throttleKey: "auto-insert-failed", escapeHtml: false');
        });
    });
});

describe('toast-lines.js is fetched the first time a refusal toast needs it', () => {
    const lines = html => load(`<div class="toast-message">${html}</div>`, null, false)('.toast-message');
    // An import that stays pending until the test lets it arrive, as a slow request would.
    const slowImport = () => {
        const pending = { arrive: null, fail: null };
        pending.importToastLines = () => new Promise((resolve, reject) => { pending.arrive = () => resolve({ twoLineToastHtml }); pending.fail = reject; });
        return pending;
    };

    test('the page has no static import of it, and its one dynamic import names a file that exists', () => {
        expect(syntax.body.filter(row => row.type === 'ImportDeclaration' && /toast-lines/.test(row.source.value))).toEqual([]);
        expect(source.split(IMPORT_TOAST_LINES)).toHaveLength(2);
        expect(fs.existsSync(new URL('../../toast-lines.js', new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url)))).toBe(true);
    });

    test('the first refusal shows its toast after the import, with its own sentence and reason', async () => {
        const slow = slowImport();
        const { showInsertFailure, toasts, host } = makeToastHelpers({ importToastLines: slow.importToastLines });
        showInsertFailure({ message: 'x', sentence: 'The image cannot be sent as it is.', reason: 'The file is too large.' });
        await settle();
        expect(host.importToastLines).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([]);
        slow.arrive();
        await settle();
        expect(toasts).toHaveLength(1);
        const [severity, html, title, options] = toasts[0];
        expect([severity, title, options]).toEqual(['error', '', { finalText: true, escapeHtml: false }]);
        const message = lines(html);
        expect(message.contents().get(0).data).toBe('The image cannot be sent as it is.');
        expect(message.children('span').text()).toBe('The file is too large.');
        expect(message.children('span').attr('data-i18n-ignore')).toBe('');
    });

    test('a second one reuses the module, whether it arrives while the first is loading or after', async () => {
        const slow = slowImport();
        const { showInsertFailure, toasts, host } = makeToastHelpers({ importToastLines: slow.importToastLines });
        showInsertFailure({ message: 'x', sentence: 'First.', reason: 'One.' });
        showInsertFailure({ message: 'x', sentence: 'Second.', reason: 'Two.' });
        slow.arrive();
        await settle();
        showInsertFailure({ message: 'x', sentence: 'Third.', reason: 'Three.' });
        await settle();
        expect(host.importToastLines).toHaveBeenCalledTimes(1);
        expect(toasts.map(toast => lines(toast[1]).contents().get(0).data)).toEqual(['First.', 'Second.', 'Third.']);
    });

    test('refusals raised while it loads keep their own words and their order, even if the error objects change afterwards', async () => {
        const slow = slowImport();
        const { showInsertFailure, toasts } = makeToastHelpers({ importToastLines: slow.importToastLines });
        const first = { message: 'first', sentence: 'Sentence A.', reason: 'Reason A.' };
        const second = { message: 'second detail' };
        showInsertFailure(first);
        showInsertFailure(second);
        Object.assign(first, { sentence: 'changed', reason: 'changed' });
        second.message = 'changed';
        slow.arrive();
        await settle();
        const shown = toasts.map(toast => lines(toast[1]));
        expect(shown[0].contents().get(0).data).toBe('Sentence A.');
        expect(shown[0].children('span').text()).toBe('Reason A.');
        expect(shown[1].text()).toBe('Could not insert the image: second detail');
    });

    test('an import failure is logged, not thrown; the refusal is still told in plain text, and the next refusal tries again', async () => {
        const slow = slowImport();
        const { showTwoLineToast, toasts, logged, host } = makeToastHelpers({ importToastLines: slow.importToastLines });
        dictionary.set('The file is too large.', 'O ficheiro é grande demais.');
        const shown = showTwoLineToast('error', 'The image cannot be sent as it is.', 'The file is too large.', { finalText: true, escapeHtml: false });
        slow.fail(new Error('Failed to fetch dynamically imported module'));
        await expect(shown).resolves.toBeUndefined();
        expect(logged.join('\n')).toContain('Failed to fetch dynamically imported module');
        expect(toasts).toEqual([['error', 'The image cannot be sent as it is. O ficheiro é grande demais.', '', { finalText: true, escapeHtml: true }]]);
        // The failed load is not kept: the next refusal asks again.
        const retry = showTwoLineToast('warning', 'Sentence.', 'Reason.', { throttleKey: 'auto-insert-failed', escapeHtml: false });
        slow.arrive();
        await retry;
        expect(host.importToastLines).toHaveBeenCalledTimes(2);
        expect(toasts[1][0]).toBe('warning');
        expect(lines(toasts[1][1]).children('span').text()).toBe('Reason.');
        expect(toasts[1][3]).toEqual({ throttleKey: 'auto-insert-failed', escapeHtml: false });
    });
});

describe('the two gallery toasts are translated where they are built', () => {
    const insertKey = 'Insert all stopped: ${0} Images inserted before the failure were kept; the remaining images are still available in the batch viewer.';
    const importPrefix = 'Failed to import image URL:';
    const insertCall = () => qigToastCall('warning', 'Insert all stopped:');
    const importCall = () => qigToastCall('error', 'Failed to import image URL');
    const assertTranslateHole = hole => {
        expect(hole.type).toBe('CallExpression');
        expect(hole.callee.name).toBe('translate');
        expect(hole.arguments[0].type).toBe('CallExpression');
        expect(hole.arguments[0].callee.name).toBe('String');
        expect(hole.arguments[0].arguments[0].type).toBe('MemberExpression');
    };

    test('the insert-all message is a t-tagged template with a translated hole and its final marker', () => {
        const call = insertCall();
        expect(call).toBeTruthy();
        const message = call.arguments[0];
        expect(message.type).toBe('TaggedTemplateExpression');
        expect(message.tag.name).toBe('t');
        expect(message.quasi.expressions).toHaveLength(1);
        assertTranslateHole(message.quasi.expressions[0]);
        const key = message.quasi.quasis.reduce((text, quasi, index) => text + quasi.value.cooked + (index < message.quasi.expressions.length ? '${0}' : ''), '');
        expect(key).toBe(insertKey);
        expect(englishCatalogue[insertKey]).toBe(insertKey);
        expect(optionValue(call, 'finalText')).toBe(true);
    });

    test('the import message is one template literal: the existing prefix key, then the translated hole', () => {
        const call = importCall();
        expect(call).toBeTruthy();
        const message = call.arguments[0];
        expect(message.type).toBe('TemplateLiteral');
        expect(message.quasis.map(quasi => quasi.value.cooked)).toEqual(['', ' ', '']);
        expect(message.expressions).toHaveLength(2);
        const [prefix, hole] = message.expressions;
        expect(prefix.type).toBe('TaggedTemplateExpression');
        expect(prefix.tag.name).toBe('t');
        expect(prefix.quasi.expressions).toHaveLength(0);
        expect(prefix.quasi.quasis[0].value.cooked).toBe(importPrefix);
        assertTranslateHole(hole);
        expect(englishCatalogue[importPrefix]).toBe(importPrefix);
        expect(Object.hasOwn(englishCatalogue, `${importPrefix} \${0}`)).toBe(false);
        expect(source).not.toContain(`${importPrefix} \${0}`);
        expect(optionValue(call, 'finalText')).toBe(true);
        expect(optionValue(call, 'escapeHtml')).toBe(true);
        expect(call.arguments[1].value).toBe('Quick Image Gen');
    });

    test('the English text of both toasts is unchanged', () => {
        expect(evaluateEnglishToastMessage(insertCall(), new Error('X')))
            .toBe('Insert all stopped: X Images inserted before the failure were kept; the remaining images are still available in the batch viewer.');
        expect(evaluateEnglishToastMessage(importCall(), new Error('X'))).toBe('Failed to import image URL: X');
    });

    test('the Portuguese import toast translates its frame and its hole, leaving the English text untouched', () => {
        expect(evaluateToastMessage(importCall(), new Error('X'))).toBe('Falha ao importar URL da imagem: X');
        expect(portuguese[importPrefix]).toBe('Falha ao importar URL da imagem:');
    });

    test('the Portuguese insert-all toast is the sentence the base localiser already showed', () => {
        expect(evaluateToastMessage(insertCall(), new Error('X')))
            .toBe('Inserir tudo foi interrompido: X As imagens inseridas antes da falha foram mantidas; as imagens restantes ainda estão disponíveis no visualizador de lote.');
    });

    test('an inner message that is an exact key is still translated in the hole', () => {
        expect(evaluateToastMessage(importCall(), new Error('Image unavailable'))).toBe('Falha ao importar URL da imagem: Imagem indisponível');
        expect(portuguese['Image unavailable']).toBe('Imagem indisponível');
    });
});
