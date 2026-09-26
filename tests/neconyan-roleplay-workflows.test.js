/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';

let account = 'alice';
const chat = [];
let nativeEligible = true;
let accountStamp = { accountId: 'a-1', dataEpoch: 1 };
let settingsRevision = 4;
let submitHandler = null;
let receiptHandler = null;
const requests = [];
const observers = new Map();
const saved = [];
const reloads = [];
const activations = [];
let settingsPending = false;
const saveSettings = jest.fn(async () => {
    settingsPending = false;
    settingsRevision += 1;
    return true;
});
const listJobs = jest.fn(async () => []);
const cancelJob = jest.fn(async () => ({}));
const extensionPrompts = {};
const extensionSettings = {};
const interceptors = [];

globalThis.dispatchEvent = jest.fn();

jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    activeGenerationInterceptors: () => interceptors,
    extension_settings: extensionSettings,
}));

jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hasPendingFileAttachment: () => false }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob,
    listJobs,
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
    substituteParams: value => String(value).replaceAll('{{user}}', 'Alice'),
    getCurrentChatId: () => 'roleplay',
    getRequestHeaders: () => ({ 'X-Csrf-Token': 'token' }),
    getActiveGenerationAcknowledgement: () => {
        if (settingsPending) throw new Error('Save the active connection settings before generating a reply.');
        return { account, settingsRevision };
    },
    saveChatConditional: async options => { saved.push(options); return true; },
    saveSettings,
    reloadCurrentChat: async () => { reloads.push(chat.length); },
    deactivateSendButtons: () => activations.push('busy'),
    activateSendButtons: () => activations.push('idle'),
    willRunNativeRoleplayWorkflow: (type, options = {}) => nativeEligible && !options.skipNativeRoleplay,
}));

globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body, method: options.method || 'GET' });
    if (url.endsWith('/workflow/submit')) return submitHandler(body, requests.length);
    if (url.includes('/workflow/receipt')) return receiptHandler(requests.length);
    throw new Error(`unexpected fetch ${url}`);
};

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const workflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');

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
    settingsPending = false;
    for (const key of Object.keys(extensionPrompts)) delete extensionPrompts[key];
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    interceptors.length = 0;
    delete globalThis.DialogueColorsInterceptor;
    requests.length = 0;
    saved.length = 0;
    reloads.length = 0;
    activations.length = 0;
    observers.clear();
    listJobs.mockClear();
    cancelJob.mockClear();
    saveSettings.mockClear();
    submitHandler = async () => response(202, { key: 'k', jobId: 'job-1', created: true });
    receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { appended: true } } });
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

test('a named continuation anchors the last block, saves the chat first and resolves from the receipt', async () => {
    const pending = workflows.runNativeRoleplayGeneration('continue', { maxOutputTokens: 240 });
    await settle();
    expect(saved).toHaveLength(1);
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body).toMatchObject({
        name: 'roleplay.continue', intent: {},
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        anchor: { messageIndex: 1, chosen: false },
        maxTokens: 240,
        // Settings are saved once before submitting, so the proof names that save.
        acknowledgement: { account: 'alice', settingsRevision: 5 },
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // The write is not durable yet, so the call is still waiting.
    expect(activations).toEqual(['busy']);
    await observers.get('job-1').onStop('done');
    const outcome = await pending;
    expect(outcome).toMatchObject({ native: true, name: 'roleplay.continue', jobId: 'job-1', state: 'closed' });
    expect(reloads).toEqual([2]);
    expect(activations).toEqual(['busy', 'idle']);
});

test('a reply anchors the whole chat, so the user message just written is the one the server answers', async () => {
    chat.push({ name: 'User', is_user: true, mes: 'Where are you?' });
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(requests.find(entry => entry.url.endsWith('/workflow/submit')).body).toMatchObject({
        name: 'roleplay.reply', anchor: { messageIndex: 2, chosen: false },
    });
    await observers.get('job-1').onStop('done');
    await pending;
});

test('a story passage carries the Story prompt the page is using, with its macros resolved', async () => {
    // Story Mode writes its rules as page extension prompts, not as saved chat injects.
    extensionPrompts.sbstory_rules = { value: 'Write one paragraph with {{user}}.', position: 1, depth: 1, scan: false, role: 0 };
    extensionPrompts.sbstory_direction = { value: 'Let the storm break.', position: 1, depth: 0, scan: false, role: 0 };
    const pending = workflows.runNativeRoleplayGeneration('continue');
    await settle();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.name).toBe('story.passage');
    // The Story prompts travel once, as the named prompt, and not again as page prompts.
    expect(submit.body.intent).toEqual({ prompt: { rules: 'Write one paragraph with Alice.', rulesDepth: 1,
        direction: 'Let the storm break.', directionDepth: 0 } });
    await observers.get('job-1').onStop('done');
    await pending;
});

test('page-only prompt additions travel resolved and sorted, and server-built prompts stay behind', async () => {
    interceptors.push({ name: 'third-party/sillytavern-character-colors', key: 'DialogueColorsInterceptor' });
    globalThis.DialogueColorsInterceptor = jest.fn(async () => {
        extensionPrompts['dialogue-colors'] = { value: 'Colour {{user}} in teal.', position: 1, depth: 1, scan: false, role: 0 };
    });
    extensionPrompts['2_floating_prompt'] = { value: 'Author note the server rebuilds.', position: 1, depth: 4, scan: false, role: 0 };
    extensionPrompts.customDepthWI_2_0 = { value: 'Lore the server rebuilds.', position: 1, depth: 2, scan: false, role: 0 };
    extensionPrompts['1_memory'] = { value: 'Summary so far.', position: 0, depth: 0, scan: false, role: 0 };
    extensionPrompts.script_inject_note = { value: 'Hidden note.', position: 1, depth: 3, scan: false, role: 1, filter: async () => false };
    extensionPrompts.script_inject_off = { value: 'Unused.', position: -1, depth: 0, scan: false, role: 0 };
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(globalThis.DialogueColorsInterceptor).toHaveBeenCalled();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.intent).toEqual({ page: [
        { key: '1_memory', content: 'Summary so far.', position: 0, depth: 0, role: 'system' },
        { key: 'dialogue-colors', content: 'Colour Alice in teal.', position: 1, depth: 1, role: 'system' },
    ] });
    await observers.get('job-1').onStop('done');
    await pending;
});

test.each([
    ['an Agent prompt the server policy owns', () => { extensionPrompts.inchat_agent_scribe = { value: 'Agent text.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['a prompt that must be scanned for lore', () => { extensionPrompts.script_inject_scan = { value: 'Scan me.', position: 1, depth: 0, scan: true, role: 0 }; }],
    ['a macro the page cannot resolve', () => { extensionPrompts.script_inject_macro = { value: 'Roll {{roll:d6}}.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['a key the server cannot name', () => { extensionPrompts['script_inject_a b'] = { value: 'Spaced.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['enabled vector retrieval', () => { interceptors.push({ name: 'vectors', key: 'vectors_rearrangeChat' }); extensionSettings.vectors = { enabled_chats: true }; }],
    ['an unknown generation interceptor', () => { interceptors.push({ name: 'third-party/other', key: 'otherInterceptor' }); }],
])('%s keeps the browser path instead of generating without it', async (_label, arrange) => {
    arrange();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    // A replacement the host already kept undeleted is refused, never sent without it.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: true }))
        .toMatchObject({ state: 'refused', refused: true });
    expect(requests).toHaveLength(0);
});

test('page text a control hands over resolves its macros or keeps the browser path', () => {
    expect(workflows.resolvePageText(' Rewrite {{user}}\'s reply. ')).toBe('Rewrite Alice\'s reply.');
    expect(workflows.resolvePageText('Roll {{roll:d6}}')).toBeNull();
});

test('a refused submission never falls through to a browser generation', async () => {
    submitHandler = async () => response(409, { error: 'The anchored message changed.', code: 'roleplay_workflow_anchor' });
    const outcome = await workflows.runNativeRoleplayGeneration('regenerate');
    expect(outcome).toMatchObject({ native: true, state: 'refused', refused: true, key: null, jobId: null });
    expect(reloads).toEqual([]);
});

test('a stale settings proof is saved again and the same key is replayed', async () => {
    let attempts = 0;
    submitHandler = async (body) => {
        attempts += 1;
        if (attempts === 1) return response(409, { error: 'Save first.', code: 'roleplay_settings_ack_required' });
        return response(202, { key: body.key, jobId: 'job-2', created: true });
    };
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'job-2', result: { named: { index: 2, count: 3 } } });
    const pending = workflows.runNativeRoleplayGeneration('swipe');
    await settle();
    expect(saveSettings).toHaveBeenCalledTimes(2);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(2);
    expect(submits[1].body.key).toBe(submits[0].body.key);
    expect(submits[1].body.acknowledgement.settingsRevision).toBe(6);
    await observers.get('job-2').onStop('done');
    expect((await pending).result).toEqual({ named: { index: 2, count: 3 } });
});

test('a settings save still queued in the page is finished before the workflow is submitted', async () => {
    settingsPending = true;
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(1);
    expect(submits[0].body.acknowledgement).toEqual({ account: 'alice', settingsRevision: 5 });
    await observers.get('job-1').onStop('done');
    expect((await pending).state).toBe('closed');
});

test('a settings save the page cannot finish yet is tried again before the workflow is submitted', async () => {
    saveSettings.mockImplementationOnce(async () => false);
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await waitFor(() => requests.some(entry => entry.url.endsWith('/workflow/submit')));
    expect(saveSettings).toHaveBeenCalledTimes(2);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(1);
    await observers.get('job-1').onStop('done');
    expect((await pending).state).toBe('closed');
});

test('an accepted job the page never sees is read back from its receipt after a reopen', async () => {
    listJobs.mockResolvedValue([
        { id: 'other', type: 'conversation.reply', state: 'running' },
        { id: 'done', type: 'media.roleplay-workflow', state: 'completed',
            intent: { media: { operationKey: 'key-7' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
                request: { named: { name: 'story.passage' } } } },
    ]);
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'done', result: { named: { cut: 8, length: 24 } } });
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(reloads).toEqual([2]);
    expect(requests.filter(entry => entry.url.includes('/workflow/receipt'))[0].url).toContain('key=key-7');
});

test('a busy native lane keeps the browser path unless the host already committed the change', async () => {
    const first = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    // Nothing destructive was skipped for a plain send, so the browser path stays
    // available for a second intent.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: false })).toBeNull();
    // A swipe the host kept undeleted must never fall back to a second paid call.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: true }))
        .toMatchObject({ state: 'refused', refused: true });
    await observers.get('job-1').onStop('done');
    await first;
});

test('stopping the host generation cancels the accepted workflow instead of leaving it running', async () => {
    const controller = new AbortController();
    const pending = workflows.runNativeRoleplayGeneration('regenerate', { committed: true, signal: controller.signal });
    await settle();
    controller.abort();
    expect(cancelJob).toHaveBeenCalledWith('job-1', { reason: 'user_cancelled' });
    await observers.get('job-1').onStop('cancelled');
    await pending;
});

test('a call site the host will not serve keeps the browser path', async () => {
    nativeEligible = false;
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    nativeEligible = true;
    accountStamp = null;
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    expect(requests).toHaveLength(0);
});
