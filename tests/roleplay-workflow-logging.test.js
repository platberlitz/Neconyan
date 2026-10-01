/* global globalThis */
/**
 * M6: the Roleplay workflow routing and refusal reasons are observable.
 *
 * Manual live check for criterion 7, to record in the PR body once performed: open a
 * single-character protected chat, open the browser devtools console, send one message,
 * and confirm exactly one 'Roleplay workflow ...' line appears for the tier that decided
 * the generation ('accepted' when the server took it, otherwise 'refused' naming the one
 * condition). Jest cannot import public/script.js, so this check plus the source-structure
 * assertions below are the tier-1 evidence; the tier-1.5 and tier-2 lines and both submit
 * seams are asserted directly here.
 */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resumableGenerationMiddleware, testExports } from '../src/resumable-generations.js';
import { createFinishReasonScan, forwardFetchResponse } from '../src/util.js';

let account = 'alice';
const chat = [];
let nativeEligible = true;
let accountStamp = { accountId: 'a-1', dataEpoch: 1 };
let settingsRevision = 4;
let submitHandler = null;
let receiptHandler = null;
let debugSpy = null;
const requests = [];
const observers = new Map();
const extensionPrompts = {};
const interceptors = [];

globalThis.dispatchEvent = jest.fn();

jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    activeGenerationInterceptors: () => interceptors,
    extension_settings: {},
}));

jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/extensions/vectors/native.js', () => ({ serviceVectorBrowserWork: async () => {} }));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hasPendingFileAttachment: () => false }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob: async () => ({}),
    listJobs: async () => [],
    observeJob: (id, options) => {
        observers.set(id, options);
        return () => options.onStop('stopped');
    },
    TERMINAL: new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']),
}));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({
    roleplayAccountStamp: () => {
        if (!accountStamp) throw new Error('ROLEPLAY_ACCOUNT_CHANGED');
        return { account: accountStamp };
    },
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({ getCurrentCharAvatar: () => 'nova.png' }));
jest.unstable_mockModule('../public/script.js', () => ({
    chat,
    extension_prompts: extensionPrompts,
    substituteParams: value => String(value),
    getCurrentChatId: () => 'roleplay',
    getRequestHeaders: () => ({ 'X-Csrf-Token': 'token' }),
    getActiveGenerationAcknowledgement: () => ({ account, settingsRevision }),
    saveChatConditional: async () => true,
    saveSettings: async () => true,
    reloadCurrentChat: async () => {},
    isGenerating: () => false,
    isChatSaving: false,
    deactivateSendButtons: () => {},
    activateSendButtons: () => {},
    willRunNativeRoleplayWorkflow: (type, options = {}) => nativeEligible && !options.skipNativeRoleplay,
}));

globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body, method: options.method || 'GET' });
    if (url.endsWith('/workflow/submit') || url.endsWith('/group/submit')) return submitHandler(body, requests.length);
    if (url.includes('/workflow/receipt')) return receiptHandler(requests.length);
    throw new Error(`unexpected fetch ${url}`);
};

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const workflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const refusalCalls = () => debugSpy.mock.calls.filter(([message]) => message === 'Roleplay workflow refused');
const acceptedCalls = () => debugSpy.mock.calls.filter(([message]) => message === 'Roleplay workflow accepted');

beforeEach(() => {
    account = 'alice';
    // The module holds this array, so the fixture edits it in place.
    chat.length = 0;
    chat.push(
        { name: 'User', is_user: true, mes: 'Original' },
        { name: 'Nova', mes: 'Answer', swipes: ['Answer', 'Other'], swipe_id: 0 },
    );
    nativeEligible = true;
    accountStamp = { accountId: 'a-1', dataEpoch: 1 };
    settingsRevision = 4;
    for (const key of Object.keys(extensionPrompts)) delete extensionPrompts[key];
    interceptors.length = 0;
    delete globalThis.DialogueColorsInterceptor;
    requests.length = 0;
    observers.clear();
    submitHandler = async body => response(202, { key: body.key ?? 'k', jobId: 'job-1', created: true });
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'job-1', result: {} });
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    testExports.generations.clear();
    testExports.setTotalBufferedBytes(0);
});

// MARK: tier 2, the six capturePagePrompts refusal sites

const TIER_TWO_CASES = [
    ['an interceptor the page cannot replay', () => { interceptors.push({ key: 'otherInterceptor' }); }, 'interceptor'],
    ['a policy prompt the server writes itself', () => { extensionPrompts.inchat_agent_scribe = { value: 'Agent text.', position: 1, depth: 0, scan: false, role: 0 }; }, 'policy-prefix'],
    ['a prompt marked for World Info scanning', () => { extensionPrompts.script_inject_scan = { value: 'Scan me.', position: 1, depth: 0, scan: true, role: 0 }; }, 'scan'],
    ['a filter that threw', () => { extensionPrompts.script_inject_throw = { value: 'Boom.', position: 1, depth: 0, scan: false, role: 0, filter: async () => { throw new Error('nope'); } }; }, 'filter-error'],
    ['a macro the page cannot resolve', () => { extensionPrompts.script_inject_macro = { value: 'Roll {{roll:d6}}.', position: 1, depth: 0, scan: false, role: 0 }; }, 'macro'],
    ['a key the server cannot name', () => { extensionPrompts['script_inject_a b'] = { value: 'Spaced.', position: 1, depth: 0, scan: false, role: 0 }; }, 'key'],
    ['a position outside the named set', () => { extensionPrompts.script_inject_position = { value: 'Wrong place.', position: 3, depth: 0, scan: false, role: 0 }; }, 'position'],
    ['a depth that is not a safe non-negative integer', () => { extensionPrompts.script_inject_depth = { value: 'Wrong depth.', position: 1, depth: 1.5, scan: false, role: 0 }; }, 'depth'],
    ['a role the server cannot place', () => { extensionPrompts.script_inject_role = { value: 'Wrong role.', position: 1, depth: 0, scan: false, role: 9 }; }, 'role'],
    ['a page larger than the byte limit', () => { extensionPrompts.script_inject_size = { value: 'a'.repeat(120 * 1024 + 1), position: 1, depth: 0, scan: false, role: 0 }; }, 'size'],
];

test.each(TIER_TWO_CASES)('a tier-2 refusal from %s logs the workflow and its label', async (_name, arrange, reason) => {
    arrange();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0][1]).toEqual({ name: 'roleplay.reply', reason });
});

const COMBINED_CASES = [
    ['macro wins over every later check', { key: 'script_inject_a b', content: 'Roll {{roll:d6}}.', position: 3, depth: 1.5, role: 9 }, 'macro'],
    ['key is named before position', { key: 'script_inject_a b', content: 'Fine.', position: 3, depth: 0, role: 0 }, 'key'],
    ['position is named before depth', { key: 'script_inject_position', content: 'Fine.', position: 3, depth: 1.5, role: 0 }, 'position'],
    ['depth is named before role', { key: 'script_inject_depth', content: 'Fine.', position: 1, depth: 1.5, role: 9 }, 'depth'],
];

test.each(COMBINED_CASES)('the combined tier-2 site names the first failing sub-condition: %s', async (_name, fixture, reason) => {
    extensionPrompts[fixture.key] = { value: fixture.content, position: fixture.position, depth: fixture.depth, scan: false, role: fixture.role };
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0][1]).toEqual({ name: 'roleplay.reply', reason });
});

test('a probing collector takes the tier-2 reason instead of a log line', async () => {
    extensionPrompts.script_inject_scan = { value: 'Scan me.', position: 1, depth: 0, scan: true, role: 0 };
    const collected = [];
    expect(await workflows.capturePagePrompts('roleplay.reply', collecting => collected.push(collecting))).toBeNull();
    expect(collected).toEqual(['scan']);
    expect(debugSpy).not.toHaveBeenCalled();
});

// MARK: tier 1.5, the silent refusals on the same decision path

test('a generation whose chat is not ready logs the not-ready label', async () => {
    accountStamp = null;
    const outcome = await workflows.runNativeRoleplayGeneration('normal', { committed: true });
    expect(outcome).toMatchObject({ native: true, state: 'refused', refused: true });
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0][1]).toEqual({ type: 'normal', reason: 'not-ready' });
    expect(requests).toHaveLength(0);
});

test('a second generation while one is running logs the busy label', async () => {
    const first = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(requests.some(entry => entry.url.endsWith('/workflow/submit'))).toBe(true);
    const outcome = await workflows.runNativeRoleplayGeneration('swipe', { committed: true });
    expect(outcome).toMatchObject({ native: true, state: 'refused', refused: true });
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0][1]).toEqual({ type: 'swipe', reason: 'busy' });
    await observers.get('job-1').onStop('done');
    await first;
});

// MARK: the accepted line at both submit seams

test('a solo submission logs exactly one accepted line after the server accepts', async () => {
    submitHandler = async body => response(202, { key: body.key ?? 'k', jobId: 'solo-accepted', created: true });
    await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
    expect(acceptedCalls()).toHaveLength(1);
    expect(acceptedCalls()[0][1]).toEqual({ name: 'roleplay.reply' });
    // Stop the observed job so its preview poller does not outlive the suite.
    await observers.get('solo-accepted').onStop('done');
});

test('a direct extension-style caller logs its accepted workflow at the seam', async () => {
    submitHandler = async body => response(202, { key: body.key ?? 'k', jobId: 'guided-accepted', created: true });
    await workflows.submitRoleplayWorkflow({
        name: 'guided.response',
        intent: { prompt: { text: 'Guide the reply.' } },
        page: [{ key: 'guide', content: 'Guide.', position: 1, depth: 0, role: 'system' }],
    });
    expect(acceptedCalls()).toHaveLength(1);
    expect(acceptedCalls()[0][1]).toEqual({ name: 'guided.response' });
    await observers.get('guided-accepted').onStop('done');
});

test('a solo submission the server refuses logs no accepted line', async () => {
    submitHandler = async () => response(409, { error: 'The anchored message changed.', code: 'roleplay_workflow_anchor' });
    await expect(workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' })).rejects.toThrow('The anchored message changed.');
    expect(acceptedCalls()).toHaveLength(0);
});

test('a settings-proof retry still logs exactly one accepted line', async () => {
    let attempts = 0;
    submitHandler = async body => {
        attempts += 1;
        if (attempts === 1) return response(409, { error: 'Save first.', code: 'roleplay_settings_ack_required' });
        return response(202, { key: body.key, jobId: 'retry-accepted', created: true });
    };
    await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
    expect(requests.filter(entry => entry.url.endsWith('/workflow/submit'))).toHaveLength(2);
    expect(acceptedCalls()).toHaveLength(1);
    expect(acceptedCalls()[0][1]).toEqual({ name: 'roleplay.reply' });
    await observers.get('retry-accepted').onStop('done');
});

test('a group turn logs exactly one accepted line after the server accepts', async () => {
    submitHandler = async body => response(202, { key: body.key, jobId: 'group-accepted', created: true });
    const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-1' });
    await settle();
    expect(acceptedCalls()).toHaveLength(1);
    expect(acceptedCalls()[0][1]).toEqual({ name: 'group.reply' });
    await observers.get('group-accepted').onStop('done');
    await pending;
});

test('a group turn the server refuses logs no accepted line', async () => {
    submitHandler = async () => response(409, { error: 'Do not repeat this turn.', code: 'roleplay_workflow_anchor' });
    await expect(workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-2' }))
        .rejects.toThrow('Do not repeat this turn.');
    expect(acceptedCalls()).toHaveLength(0);
});

// MARK: the finish reason at both stream-end sites (src/util.js)

function createMockExpressResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';
    response.socket = {};
    response.getHeader = () => undefined;
    return response;
}

function createMockRequest(id) {
    const headers = { 'x-generation-id': id };
    return {
        headers,
        socket: new EventEmitter(),
        user: { profile: { handle: 'tester' } },
        get(name) {
            return headers[String(name).toLowerCase()];
        },
    };
}

function createFakeUpstreamBody() {
    return Object.assign(new EventEmitter(), { pipe: jest.fn(), destroy: jest.fn() });
}

// The finish-reason scan is created only for a response that declares an event stream.
const EVENT_STREAM_HEADERS = { get: () => 'text/event-stream' };
const EVENT_STREAM_RESPONSE = { headers: EVENT_STREAM_HEADERS };

// A real piped body, so forwarded bytes can be compared with the source bytes.
function createForwardingHarness() {
    const to = createMockExpressResponse();
    const forwarded = [];
    to.on('data', chunk => forwarded.push(chunk));
    const ended = new Promise(resolve => to.on('end', resolve));
    return { to, forwarded, ended };
}

function collectGeneration(generation, offset = 0) {
    return new Promise(resolve => {
        const chunks = [];
        generation.subscribe(offset, {
            onChunk: chunk => chunks.push(chunk),
            onEnd: () => resolve(Buffer.concat(chunks).toString('utf8')),
        });
    });
}

test('the resumable stream site logs the last finish reason, even split across chunks', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const request = createMockRequest('m6-resumable');
    const to = createMockExpressResponse();
    resumableGenerationMiddleware(request, to, () => {});
    const upstreamBody = createFakeUpstreamBody();
    await forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', headers: EVENT_STREAM_HEADERS, body: upstreamBody }, to, request);
    const collected = collectGeneration(request.resumableGeneration);
    const first = 'data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_re';
    const second = 'ason":"stop"}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    upstreamBody.emit('data', Buffer.from(first));
    upstreamBody.emit('data', Buffer.from(second));
    upstreamBody.emit('end');
    await expect(collected).resolves.toBe(first + second);
    expect(infoSpy).toHaveBeenCalledWith('Streaming request finished', { finishReason: 'length' });
});

test('the ordinary stream site logs the provider finish reason', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const to = createMockExpressResponse();
    const upstreamBody = createFakeUpstreamBody();
    await forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', headers: EVENT_STREAM_HEADERS, body: upstreamBody }, to);
    upstreamBody.emit('data', Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
    upstreamBody.emit('data', Buffer.from('data: {"choices":[{"index":0,"delta":{},"finish_rea'));
    upstreamBody.emit('data', Buffer.from('son":null},{"index":1,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
    upstreamBody.emit('end');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Streaming request finished', { finishReason: 'length' });
    expect(to.writableEnded).toBe(true);
});

test('a stream with no provider finish reason logs no guessed reason and no error', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const to = createMockExpressResponse();
    const upstreamBody = createFakeUpstreamBody();
    await forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', headers: EVENT_STREAM_HEADERS, body: upstreamBody }, to);
    upstreamBody.emit('data', Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'));
    upstreamBody.emit('end');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Streaming request finished');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(to.writableEnded).toBe(true);
});

// MARK: the scan's gate, cap and incremental search (criteria 5b, 5c, 5d)

test('a 16 MiB octet-stream body is forwarded byte-identical and never scanned (criterion 5b)', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { to, forwarded, ended } = createForwardingHarness();
    const upstreamBody = new PassThrough();
    await forwardFetchResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/octet-stream' },
        body: upstreamBody,
    }, to);

    const body = Buffer.alloc(16 * 1024 * 1024, 0x61); // 'a' repeated: not a newline in sight
    const startedAt = process.hrtime.bigint();
    upstreamBody.end(body);
    await ended;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const collected = Buffer.concat(forwarded);
    expect(collected.length).toBe(body.length);
    expect(collected.equals(body)).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Streaming request finished');

    // Supplementary evidence only, never a verdict: machine load distorts wall clock.
    // References: baseline ~0 ms; the pre-fix branch measured ~4,094 ms for this body;
    // a surprising value warrants a local re-check, not a regression judgment.
    console.log(`[M6 5b] 16 MiB octet-stream forwarded in ${elapsedMs.toFixed(1)} ms (supplementary, not a verdict)`);
});

test('the scan is enabled by an event-stream content type, parameters and case included (criterion 5c)', () => {
    const parametrised = createFinishReasonScan({ headers: { get: () => 'text/event-stream; charset=utf-8' } });
    parametrised.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n');
    expect(parametrised.flush()).toBe('length');

    const upperCase = createFinishReasonScan({ headers: { get: () => 'TEXT/EVENT-STREAM' } });
    upperCase.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    expect(upperCase.flush()).toBe('stop');
});

test.each([
    ['an absent response', undefined],
    ['an absent headers object', {}],
    ['headers without get', { headers: {} }],
    ['a missing content type', { headers: { get: () => null } }],
    ['a non-event content type', { headers: { get: () => 'application/octet-stream' } }],
])('the scan is disabled by %s and retains nothing (criterion 5c)', (_name, from) => {
    const scan = createFinishReasonScan(from);
    scan.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n');
    scan.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    expect(scan.flush()).toBeNull();
});

test('a reason split across two pushes is completed and found (criterion 5c)', () => {
    const scan = createFinishReasonScan(EVENT_STREAM_RESPONSE);
    scan.push(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_re'));
    scan.push(Buffer.from('ason":"length"}]}\n\n'));
    expect(scan.flush()).toBe('length');
});

test('an unfinished line over the cap disables the scan, keeps the earlier reason and ignores later ones (criterion 5c)', () => {
    const scan = createFinishReasonScan(EVENT_STREAM_RESPONSE);
    scan.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    scan.push('data: {"choices":[{"index":0,"delta":{"content":"' + 'x'.repeat(64 * 1024) + '"}');
    // Both lines after the disable are valid and carry different reasons; both are ignored.
    scan.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n');
    scan.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    expect(scan.flush()).toBe('stop');
});

test('an event stream that overflows the cap keeps the earlier reason and forwards byte-identical (criterion 5d)', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { to, forwarded, ended } = createForwardingHarness();
    const upstreamBody = new PassThrough();
    await forwardFetchResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: EVENT_STREAM_HEADERS,
        body: upstreamBody,
    }, to);

    const early = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const overflow = 'data: {"choices":[{"index":0,"delta":{"content":"' + 'x'.repeat(70 * 1024);
    const later = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    upstreamBody.write(Buffer.from(early));
    upstreamBody.write(Buffer.from(overflow));
    upstreamBody.end(Buffer.from(later));
    await ended;

    const expected = Buffer.from(early + overflow + later);
    const collected = Buffer.concat(forwarded);
    expect(collected.length).toBe(expected.length);
    expect(collected.equals(expected)).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Streaming request finished', { finishReason: 'stop' });
});

// MARK: source-structure assertions (public/script.js cannot be imported by jest)

const TIER_ONE_LABELS = [
    'type', 'skip-flag', 'automatic-trigger', 'json-schema', 'force-chid', 'force-name2',
    'quiet-prompt', 'depth', 'cache-scope', 'suppress-user-message', 'preserve-last-message',
    'signal', 'group', 'assistant', 'stamp',
];

function tierOneBody() {
    const start = scriptSource.indexOf('export function willRunNativeRoleplayWorkflow');
    expect(start).toBeGreaterThan(-1);
    return scriptSource.slice(start, scriptSource.indexOf('\n}', start));
}

test.each(TIER_ONE_LABELS)('the tier-1 condition %s is named by its own label in the decision', label => {
    expect(tierOneBody()).toContain(`refuse('${label}')`);
});

test('the tier-1 decision keeps its boolean export, its optional collector and the pinned label order', () => {
    const body = tierOneBody();
    expect(body).toContain('export function willRunNativeRoleplayWorkflow(type, options = {}, collector = null)');
    expect(body).toContain('collector(reason)');
    expect(body).toContain('return true');
    // Every guard is split into its own condition, so the first true member of the
    // original disjunctions is always the one labelled and only it fires.
    expect(body).not.toContain('||');
    let cursor = -1;
    for (const label of TIER_ONE_LABELS) {
        const index = body.indexOf(`refuse('${label}')`);
        expect(index).toBeGreaterThan(cursor);
        cursor = index;
    }
});

test('only the Generate decision point emits the tier-1 refusal, the overswipe probe collects silently', () => {
    expect(scriptSource).toContain('await nativeRoleplayWorkflowFor(\'swipe\', generationOptions ?? {}, () => {})');
    const decision = scriptSource.match(/preparedNativeRoleplay \?\? await nativeRoleplayWorkflowFor\(type, \{[\s\S]*?\}\);/);
    expect(decision).not.toBeNull();
    expect(decision[0]).not.toContain('() => {}');
    expect(scriptSource).toContain('reason => console.debug(\'Roleplay workflow refused\', { type, reason })');
    expect(scriptSource).toContain('report(\'workflow-module\')');
});
