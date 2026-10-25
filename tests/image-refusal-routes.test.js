import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { assembleLocaleData } from '../public/scripts/locale-assembly.js';
import { isImageInputIssue, promptMediaError } from '../public/scripts/prompt-media-policy.js';
import { localizeString } from '../public/scripts/ui-localization.js';

// The group route shows its failure through a small function in group-chats.js. The module is too large to load, so the function is cut
// out of the source as it stands and run against stand-ins. The Roleplay and Conversation routes are tested in their own suites.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const groupSource = read('public/scripts/group-chats.js');
const syntax = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const cutFunction = (source, name) => {
    const found = syntax(source).body.find(row => row.id?.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};
// Every syntax node under one node, so a check can look for a shape (a catch that throws) instead of for the text that spells it.
const nodesOf = (node, found = []) => {
    if (typeof node?.type === 'string') found.push(node);
    for (const value of Object.values(node ?? {})) {
        if (Array.isArray(value)) value.forEach(item => nodesOf(item, found));
        else if (value && typeof value === 'object') nodesOf(value, found);
    }
    return found;
};
// The three shapes of an image refusal the routes receive: a client policy error, a server reply with the issue, and the code alone.
const imageRefusals = () => [
    promptMediaError('invalid-policy', -1, -1, 'Words.'),
    Object.assign(new Error('Words.'), { status: 409, body: { error: 'Words.', code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'unsupported-image', index: 0, mediaIndex: 0, actions: [] } } }),
    Object.assign(new Error('Words.'), { body: { error: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT' } }),
];

const realFile = name => JSON.parse(fs.readFileSync(new URL(`../public/locales/${name}.json`, import.meta.url), 'utf8'));
const portuguese = assembleLocaleData({ base: realFile('pt-pt'), supplement: realFile('neconyan/pt-pt'), catalogue: realFile('neconyan/en') }).dictionary;
// The old wording of GEN-C01 starts with a pattern verb, so the dictionary captures it when nothing protects it.
const captured = 'Reload the page, then try again.';

describe('the group route', () => {
    const marks = [];
    const toast = { find: selector => ({ attr: (name, value) => marks.push([selector, name, value]) }) };
    const toastr = { error: jest.fn(() => toast) };
    const consoleError = jest.fn();
    let report;
    // What the run-time localiser does to a shown toast: it looks every unmarked text up in the dictionary, and leaves a marked one alone.
    const onScreen = (message, marked) => marked ? message : localizeString(message, portuguese);

    beforeEach(() => {
        marks.length = 0;
        toastr.error.mockClear();
        consoleError.mockClear();
        const host = { console: { error: consoleError }, toastr, isImageInputIssue, t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), '') };
        report = vm.runInNewContext(`(${cutFunction(groupSource, 'reportGroupReplyFailure')})`, host);
    });

    test('the dictionary the checks use does hold the pattern that captures a leading verb', () => {
        expect(portuguese['Reload ${0}']).toBeTruthy();
        expect(localizeString(captured, portuguese)).not.toBe(captured);
    });

    test('an image refusal is logged and shows no generic toast, because the one notice was raised when the server refused', () => {
        const failures = imageRefusals();
        for (const failure of failures) report(failure);
        expect(toastr.error).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledTimes(3);
        expect(consoleError).toHaveBeenCalledWith('Group reply failed', failures[0]);
    });

    test('any other failure keeps today\'s toast, with its message and title, and nothing is marked', () => {
        report(new Error('The provider is busy.'));
        expect(toastr.error).toHaveBeenLastCalledWith('The provider is busy.', 'Group reply failed');
        report(Object.assign(new Error('Settings are out of date.'), { status: 409, body: { code: 'roleplay_settings_ack_required' } }));
        expect(toastr.error).toHaveBeenLastCalledWith('Settings are out of date.', 'Group reply failed');
        // Text of its own when the error has none.
        report({});
        expect(toastr.error).toHaveBeenLastCalledWith('The group reply could not start. Please try again.', 'Group reply failed');
        report(new Error(''));
        expect(toastr.error).toHaveBeenLastCalledWith('The group reply could not start. Please try again.', 'Group reply failed');
        expect(toastr.error).toHaveBeenCalledTimes(4);
        expect(marks).toEqual([]);
        expect(consoleError).toHaveBeenCalledTimes(4);
    });

    test('an error with an image-looking field that is not one (no code, no object) is an ordinary failure', () => {
        report(Object.assign(new Error('Odd.'), { body: { imageIssue: null, code: 'roleplay_settings_ack_required' } }));
        expect(toastr.error).toHaveBeenCalledWith('Odd.', 'Group reply failed');
    });

    test('a localized error is shown exactly as given and its toast is marked; the same words as an ordinary error are captured', () => {
        report(new Error(captured));
        const ordinary = toastr.error.mock.calls.at(-1)[0];
        expect(ordinary).toBe(captured);
        expect(marks).toEqual([]);
        // The ordinary path leaves it to the localiser, and with the real Portuguese dictionary that changes the words.
        expect(onScreen(ordinary, marks.length > 0)).not.toBe(captured);
        report(Object.assign(new Error(captured), { localized: true }));
        expect(toastr.error).toHaveBeenLastCalledWith(captured, 'Group reply failed');
        expect(marks).toEqual([['.toast-message, .toast-title', 'data-i18n-ignore', '']]);
        expect(onScreen(toastr.error.mock.calls.at(-1)[0], marks.length > 0)).toBe(captured);
    });

    test('every client copy-check message is localized, so the group toast shows each as given', () => {
        const client = read('public/scripts/prompt-media-client.js');
        expect(client).toMatch(/export const localizedError = [^;]*localized:\s*true/);
        // None of the three sentences is captured by the dictionary any more, in Portuguese, so they would also pass unmarked; the mark is the durable boundary.
        for (const text of ['This page is out of date. Reload it, then try again.', 'You switched accounts while images were being checked. Try again.',
            'Compatible copies could not be checked. Try again, or review them in Review chat images.']) {
            report(Object.assign(new Error(text), { localized: true }));
            expect(toastr.error).toHaveBeenLastCalledWith(text, 'Group reply failed');
            // The client builds each sentence inside localizedError(...), so the error that reaches this toast carries the mark. A sentence moved into a plain Error fails here.
            expect(client).toMatch(new RegExp('localizedError\\([^;]*' + text.replace(/\W/g, '\\$&')));
        }
    });

    test('the group wrapper reports a failure through this function and keeps rethrowing', () => {
        // Found by shape, not by text or count: the catch that calls the function must throw, and must not show a toast of its own (it is the only generic toast of this wrapper).
        const reporting = nodesOf(syntax(groupSource)).filter(node => node.type === 'CatchClause'
            && nodesOf(node.body).some(inner => inner.type === 'CallExpression' && inner.callee.name === 'reportGroupReplyFailure'));
        expect(reporting.length).toBeGreaterThan(0);
        for (const clause of reporting) {
            const inside = nodesOf(clause.body);
            expect(inside.some(node => node.type === 'ThrowStatement')).toBe(true);
            expect(inside.some(node => node.type === 'CallExpression' && node.callee.object?.name === 'toastr' && node.callee.property?.name === 'error')).toBe(false);
        }
    });
});

describe('the other routes that submit a named workflow', () => {
    // Guided Generations' own function, cut out of shared.js as it stands and run against stand-ins, as the group route's is above. Its dynamic
    // import of the workflow module is answered by a stand-in module whose submit call refuses with the failure given, so the real catch runs.
    const guidedSource = read('public/scripts/extensions/guided-generations/scripts/shared.js');
    const submitRefused = async failure => {
        const toasts = [];
        const logged = [];
        const context = { chat: [], chatId: 'chat-1', groupId: null };
        const workflows = {
            isNativeRoleplayWorkflowReady: () => true, resolvePageText: text => text, capturePagePrompts: async () => ({ prompts: [] }),
            prefersServerReplies: () => false, requiresServerReply: async () => false,
            submitRoleplayWorkflow: async () => { throw failure; },
        };
        const host = {
            console: { error: (...args) => logged.push(args) }, toastr: { error: (...args) => toasts.push(args) },
            isGroupChat: () => false, getContext: () => context, debugLog: () => {}, isImageInputIssue,
            mandatoryServerGuidedWorkflows: new Set(['guided.regenerate', 'guided.correction', 'roleplay.correct']),
            isNeconyanAssistant: () => false, currentCharacter: () => null,
        };
        const importModuleDynamically = async () => {
            const stand = new vm.SyntheticModule(Object.keys(workflows), function () { for (const [name, value] of Object.entries(workflows)) this.setExport(name, value); });
            await stand.link(() => {});
            await stand.evaluate();
            return stand;
        };
        const submit = vm.runInNewContext(`(${cutFunction(guidedSource, 'submitGuidedWorkflow')})`, host, { importModuleDynamically });
        const handled = await submit('guided.correction', { text: 'Correct this.' });
        return { handled, toasts, logged };
    };

    test('Guided Generations shows no generic toast for an image refusal, and keeps it for any other refusal', async () => {
        // A refusal is final either way: the function reports it handled, so no caller falls back into a second generation.
        for (const failure of imageRefusals()) {
            const { handled, toasts, logged } = await submitRefused(failure);
            expect(handled).toBe(true);
            expect(toasts).toEqual([]);
            expect(logged).toHaveLength(1);
            expect(logged[0][1]).toBe(failure);
        }
        const busy = await submitRefused(new Error('The provider is busy.'));
        expect(busy.handled).toBe(true);
        expect(busy.toasts).toEqual([['The provider is busy.', 'Nothing was generated']]);
        for (const empty of [new Error(''), {}]) {
            const { handled, toasts } = await submitRefused(empty);
            expect(handled).toBe(true);
            expect(toasts).toEqual([['The guided workflow could not be started.', 'Nothing was generated']]);
        }
    });

    test('Guided Generations takes the image check from the shared policy module', () => {
        // The run above is given its own isImageInputIssue, so this is the one check that the file imports the real one.
        const imports = syntax(guidedSource).body.filter(row => row.type === 'ImportDeclaration' && /prompt-media-policy\.js$/.test(row.source.value));
        expect(imports.some(row => row.specifiers.some(item => item.imported?.name === 'isImageInputIssue'))).toBe(true);
    });

    // Deep Swipe's workflow catch is guarded here; the rest of the extension stays parked for its own review.
});

describe('Deep Swipe', () => {
    // The extension's own submit function, cut out of its source as it stands and run against a workflow stand-in whose submit
    // refuses with the failure given, so the real catch runs.
    const deepSwipeSource = read('public/scripts/extensions/third-party/Neconyan-Deep-Swipe/deep-swipe.js');
    const submitRefused = async failure => {
        const toasts = [];
        const workflows = {
            isNativeRoleplayWorkflowReady: () => true, resolvePageText: text => text, capturePagePrompts: async () => ({ prompts: [] }),
            submitRoleplayWorkflow: async () => { throw failure; },
        };
        const host = { console: { warn: () => {} }, toastr: { error: (...args) => toasts.push(args) }, isImageInputIssue };
        const importModuleDynamically = async () => {
            const stand = new vm.SyntheticModule(Object.keys(workflows), function () { for (const [name, value] of Object.entries(workflows)) this.setExport(name, value); });
            await stand.link(() => {});
            await stand.evaluate();
            return stand;
        };
        const submit = vm.runInNewContext(`(${cutFunction(deepSwipeSource, 'submitDeepSwipeWorkflow')})`, host, { importModuleDynamically });
        const handled = await submit('Deep Swipe', { instruction: 'Write this.', messageId: 0 });
        return { handled, toasts };
    };

    test('an image refusal shows no second generic toast, and any other failure keeps exactly one', async () => {
        // A refusal is final either way: the function reports it handled, so no caller falls back into a second paid call.
        for (const failure of imageRefusals()) {
            const { handled, toasts } = await submitRefused(failure);
            expect(handled).toBe(true);
            expect(toasts).toEqual([]);
        }
        const expected = [['The provider is busy.'], ['Deep Swipe could not send this request. Try again.'], ['Deep Swipe could not send this request. Try again.'], ['account_changed']];
        const failures = [new Error('The provider is busy.'), {}, 'plain failure', new Error('account_changed')];
        for (const [index, failure] of failures.entries()) {
            const { handled, toasts } = await submitRefused(failure);
            expect(handled).toBe(true);
            expect(toasts).toEqual([[expected[index][0], 'Deep Swipe']]);
        }
    });

    test('Deep Swipe takes the image check from the shared policy module', () => {
        // The run above is given its own isImageInputIssue, so this is the one check that the file imports the real one.
        const imports = syntax(deepSwipeSource).body.filter(row => row.type === 'ImportDeclaration' && /prompt-media-policy\.js$/.test(row.source.value));
        expect(imports.some(row => row.specifiers.some(item => item.imported?.name === 'isImageInputIssue'))).toBe(true);
    });
});
