/* global globalThis */
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { promptMediaError } from '../public/scripts/prompt-media-policy.js';

// A browser Roleplay refusal must show its notice once and leave Send usable. These tests load the real startup module with
// stand-ins for everything it imports, then run the Send funnel as it is cut out of script.js. The source-shape checks pin where the
// report sits in Generate and the one second-toast gate this change touches.
const GEN_P14 = 'A message would send more than four images. Set some to Show only, or show them as a gallery so only one is sent.';
const REFUSED = 'neconyan:image-input-refused';
const tag = (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), '');

await jest.unstable_mockModule('../public/scripts/prompt-media-ui.js', () => ({ showImageChoiceNotice: async () => true,
    showPromptMediaReview: async () => {}, setAccountChoice: async () => {} }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState: {} }));
await jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ roleplayAccountStamp: () => ({ account: {} }) }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
await jest.unstable_mockModule('../public/lib.js', () => ({ sha256: value => `hash:${value}` }));
await jest.unstable_mockModule('../public/script.js', () => ({ chat_metadata: {}, main_api: 'openai', getRequestHeaders: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
// The one allowed mock line: the client imports oai_settings from openai.js, which this suite never reads.
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: tag, translate: text => text }));

const client = await import('../public/scripts/prompt-media-client.js');

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const syntax = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const nodesOf = (node, found = []) => {
    if (typeof node?.type === 'string') found.push(node);
    for (const value of Object.values(node ?? {})) {
        if (Array.isArray(value)) value.forEach(item => nodesOf(item, found));
        else if (value && typeof value === 'object') nodesOf(value, found);
    }
    return found;
};
const text = (source, node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
const serverRefusals = () => [
    Object.assign(new Error('Words.'), { status: 409, body: { error: 'Words.', code: 'ROLEPLAY_INVALID',
        imageIssue: { reason: 'unsupported-image', index: 0, mediaIndex: 0, actions: [] } } }),
    Object.assign(new Error('Words.'), { body: { error: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT' } }),
];
const soloLocator = { group: false, chat: 'Chat A.jsonl', avatar: 'nova.png' };
const groupLocator = { group: true, chat: 'Group chat' };

let target;
let events;
beforeEach(() => {
    target = new EventTarget();
    events = [];
    target.addEventListener(REFUSED, event => events.push(event.detail));
    globalThis.addEventListener = target.addEventListener.bind(target);
    globalThis.dispatchEvent = target.dispatchEvent.bind(target);
});
afterEach(() => {
    delete globalThis.addEventListener;
    delete globalThis.dispatchEvent;
});

describe('browser image refusal notice', () => {
    test('the helper reports a client refusal once, with the account and the chat it came from', () => {
        expect(typeof client.reportBrowserImageRefusal).toBe('function');
        expect(typeof client.isReportedImageRefusal).toBe('function');
        const error = promptMediaError('too-many-images', 1, -1, GEN_P14);
        expect(client.reportBrowserImageRefusal(error, soloLocator, 'alice')).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ reason: 'too-many-images', index: 1, mediaIndex: -1,
            actions: ['review', 'display-only', 'caption'], message: GEN_P14,
            origin: { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'Chat A', avatar: 'nova.png' } } });
        expect(client.reportBrowserImageRefusal(error, soloLocator, 'alice')).toBe(false);
        expect(events).toHaveLength(1);
        expect(client.isReportedImageRefusal(error)).toBe(true);
        expect(client.reportBrowserImageRefusal(promptMediaError('stale-policy', 0, 0, 'Stale.'), groupLocator, 'alice')).toBe(true);
        expect(events).toHaveLength(2);
        expect(events[1].origin).toEqual({ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'Group chat' } });
        expect(events[1].origin.locator).not.toHaveProperty('avatar');
    });

    test('only an error carrying its own code is reported, and no origin is invented for a nameless chat', () => {
        expect(typeof client.reportBrowserImageRefusal).toBe('function');
        expect(typeof client.isReportedImageRefusal).toBe('function');
        // A fresh client refusal has its own code, so the helper would report it; this checks it has not been reported yet.
        expect(client.isReportedImageRefusal(promptMediaError('too-many-images', 1, -1, GEN_P14))).toBe(false);
        const errors = [new Error('Other.'), ...serverRefusals(), null, undefined, 'x'];
        for (const error of errors) {
            expect(() => client.reportBrowserImageRefusal(error, soloLocator, 'alice')).not.toThrow();
            expect(client.reportBrowserImageRefusal(error, soloLocator, 'alice')).toBe(false);
            expect(client.isReportedImageRefusal(error)).toBe(false);
        }
        expect(events).toHaveLength(0);
        const noAvatar = promptMediaError('too-many-images', 1, -1, GEN_P14);
        expect(client.reportBrowserImageRefusal(noAvatar, { group: false, chat: 'Chat A' }, 'alice')).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).not.toHaveProperty('origin');
        expect(client.isReportedImageRefusal(noAvatar)).toBe(true);
    });

    // The Send funnel, cut from script.js as it stands (the export keyword is not part of the slice), with a test-owned set standing in for
    // the real helper: what a caller already reported is reported, everything else is rethrown as today.
    const scriptSource = read('public/script.js');
    const sendNode = syntax(scriptSource).body.map(row => row.declaration ?? row).find(row => row.id?.name === 'sendTextareaMessage');
    const sendSource = scriptSource.slice(sendNode.start, sendNode.end);
    const send = host => vm.runInNewContext(`(${sendSource})`, host);
    const reportedSet = () => {
        const set = new WeakSet();
        return { set, isReportedImageRefusal: error => error !== null && typeof error === 'object' && set.has(error) };
    };
    const host = (Generate, reported) => ({
        isExecutingCommandsFromChatInput: false,
        $: () => ({ val: () => '' }),
        isSlashCommandText: () => false,
        processCommands: jest.fn(),
        swipeState: 0,
        SWIPE_STATE: { NONE: 0, EDITING: 1 },
        toastr: { warning: jest.fn() },
        t: tag,
        isGenerating: () => false,
        hideSwipeButtons: jest.fn(),
        power_user: { continue_on_send: false },
        hasPendingFileAttachment: () => false,
        selected_group: null,
        chat: [],
        this_chid: 0,
        name2: 'User',
        neutralCharacterName: 'Assistant',
        newAssistantChat: jest.fn(),
        Generate,
        showSwipeButtons: jest.fn(),
        isReportedImageRefusal: reported.isReportedImageRefusal,
    });

    test('a reported refusal resolves and shows the swipe buttons again, any other error is rethrown untouched', async () => {
        // (a) The refusal the notice already covers.
        const reported = reportedSet();
        const refusal = promptMediaError('too-many-images', 1, -1, GEN_P14);
        reported.set.add(refusal);
        const covered = host(jest.fn(async () => { throw refusal; }), reported);
        await expect(send(covered)()).resolves.toBeUndefined();
        expect(covered.showSwipeButtons).toHaveBeenCalledTimes(1);

        // (b) An ordinary failure and (d) every image-shaped error nobody reported.
        const unreported = [new Error('Other.'), ...serverRefusals(), promptMediaError('too-many-images', 1, -1, GEN_P14)];
        for (const failure of unreported) {
            const still = reportedSet();
            const hostName = host(jest.fn(async () => { throw failure; }), still);
            await expect(send(hostName)()).rejects.toBe(failure);
            expect(hostName.showSwipeButtons).not.toHaveBeenCalled();
        }

        // (c) A successful generation keeps its result and shows the swipe buttons.
        const success = host(jest.fn(async () => 'done'), reportedSet());
        await expect(send(success)()).resolves.toBe('done');
        expect(success.showSwipeButtons).toHaveBeenCalledTimes(1);
    });

    test('Generate reports the refusal at its one releaseGenerationContext catch, from the locator taken at entry', () => {
        const generate = syntax(scriptSource).body.map(row => row.declaration ?? row).find(row => row.id?.name === 'Generate');
        expect(generate).toBeTruthy();
        const tries = nodesOf(generate).filter(node => node.type === 'TryStatement' && node.finalizer
            && nodesOf(node.finalizer).some(inner => inner.type === 'CallExpression' && inner.callee?.name === 'releaseGenerationContext'));
        expect(tries).toHaveLength(1);
        const handler = tries[0].handler;
        expect(handler).toBeTruthy();
        expect(handler.body.type).toBe('BlockStatement');
        expect(handler.body.body).toHaveLength(2);
        const [guard, rethrow] = handler.body.body;
        expect(guard.type).toBe('IfStatement');
        expect(text(scriptSource, guard.test)).toBe('!dryRun && type !== \'quiet\'');
        expect(guard.consequent.type).toBe('ExpressionStatement');
        const call = guard.consequent.expression;
        expect(call.type).toBe('CallExpression');
        expect(call.callee.name).toBe('reportBrowserImageRefusal');
        expect(call.arguments.map(argument => argument.name)).toEqual([handler.param.name, 'refusalLocator', 'refusalAccount']);
        expect(rethrow.type).toBe('ThrowStatement');
        expect(rethrow.argument.name).toBe(handler.param.name);

        // Both declarators sit directly after originChatId, before that try, in that order and with exactly the pinned values.
        const statements = generate.body.body;
        const origin = statements.findIndex(statement => statement.type === 'VariableDeclaration'
            && statement.declarations.some(declaration => declaration.id?.name === 'originChatId'));
        expect(origin).toBeGreaterThanOrEqual(0);
        const locator = statements[origin + 1], account = statements[origin + 2];
        expect(locator?.type).toBe('VariableDeclaration');
        expect(locator.declarations).toHaveLength(1);
        expect(locator.declarations[0].id.name).toBe('refusalLocator');
        expect(text(scriptSource, locator.declarations[0].init))
            .toBe('{ group: Boolean(selected_group), chat: String(originChatId ?? \'\'), ...(!selected_group ? { avatar: characters[this_chid]?.avatar } : {}) }');
        expect(account?.type).toBe('VariableDeclaration');
        expect(account.declarations).toHaveLength(1);
        expect(account.declarations[0].id.name).toBe('refusalAccount');
        expect(text(scriptSource, account.declarations[0].init)).toBe('getCurrentUserHandle()');
        expect(account.end).toBeLessThan(tries[0].start);

        // script.js imports both helpers from the client module it already uses.
        const imports = syntax(scriptSource).body.filter(row => row.type === 'ImportDeclaration' && row.source.value === './scripts/prompt-media-client.js');
        expect(imports).toHaveLength(1);
        const names = imports[0].specifiers.map(item => item.imported?.name);
        expect(names).toEqual(expect.arrayContaining(['reportBrowserImageRefusal', 'isReportedImageRefusal']));
    });
});

describe('guided correction second toast', () => {
    const guidedSource = read('public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');

    test('the Guided browser catch keeps its generic toast only for an unreported error', () => {
        const guarded = nodesOf(syntax(guidedSource)).filter(node => node.type === 'IfStatement'
            && text(guidedSource, node.test) === '!isReportedImageRefusal(error)');
        expect(guarded).toHaveLength(1);
        const calls = nodesOf(guarded[0].consequent).filter(node => node.type === 'CallExpression'
            && node.callee?.object?.name === 'toastr' && node.callee?.property?.name === 'error');
        expect(calls).toHaveLength(1);
        expect(text(guidedSource, calls[0].arguments[0])).toBe('String(error?.message || error)');
        expect(text(guidedSource, calls[0].arguments[1])).toBe('label');
        const imports = syntax(guidedSource).body.filter(row => row.type === 'ImportDeclaration' && /prompt-media-client\.js$/.test(row.source.value));
        expect(imports.some(row => row.specifiers.some(item => item.imported?.name === 'isReportedImageRefusal'))).toBe(true);
    });
});
