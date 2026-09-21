/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';

let store = { characters: {} };
let activeAvatar = '';
let activeBranchId = '';
let visibilityState = 'visible';
let wonNarration = null;
let claimOk = true;
let fetchCalls = [];
let samePersona = true;
let groupId = '';
let group = null;

jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getConversationStore: () => store,
    getConversationThreadStore: avatar => store.characters[avatar],
    getConversationGroupById: () => group,
    isConversationThreadKeyForPersona: () => samePersona,
    parseConversationThreadKey: key => ({ avatar: key, groupId, personaId: 'p.png' }),
}));
const notify = jest.fn();
const indicators = jest.fn();
const renderRail = jest.fn();
jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ schedulePalsRailRender: renderRail }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    isConversationActiveThread: (avatar, _groupId, { branchId }) => avatar === activeAvatar && branchId === activeBranchId,
    notifyNewConversationMessage: notify,
    updateConversationNotificationIndicators: indicators,
}));
const playPrepared = jest.fn();
const narrateBrowser = jest.fn();
let playbackCurrent = true;
const endPlayback = jest.fn();
const beginNarration = jest.fn(() => ({ isCurrent: () => playbackCurrent, end: endPlayback }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/tts.js', () => ({
    beginConversationNarration: beginNarration,
    playConversationNarration: playPrepared,
    narrateConversationMessage: narrateBrowser,
}));

const presentation = await import('../public/scripts/neconyan-conversation/presentation.js');

function makeThread(id, at, narration = null, avatar = 'nova.png', branchId = 'main') {
    store = {
        characters: {
            [avatar]: {
                branches: {
                    [branchId]: {
                        createdAt: 123,
                        pendingPresentations: { [id]: { at, job: 'root-1', narration } },
                        messages: [{ id, role: 'assistant', name: 'Nova', mes: 'Hello there.' }],
                    },
                },
            },
        },
    };
    activeAvatar = avatar;
    activeBranchId = branchId;
}

beforeEach(() => {
    jest.clearAllMocks();
    playPrepared.mockReset().mockResolvedValue(true);
    narrateBrowser.mockReset().mockResolvedValue(true);
    playbackCurrent = true;
    store = { characters: {} };
    activeAvatar = '';
    activeBranchId = '';
    visibilityState = 'visible';
    wonNarration = null;
    claimOk = true;
    fetchCalls = [];
    samePersona = true;
    groupId = '';
    group = null;
    globalThis.document = { visibilityState };
    globalThis.toastr = { warning: jest.fn() };
    globalThis.fetch = jest.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push({ url, body, signal: options.signal });
        if (!claimOk) {
            return { ok: false, json: async () => null };
        }
        const won = {};
        for (const id of body.messageIds) {
            won[id] = wonNarration;
        }
        return { ok: true, json: async () => ({ won, version: 1, readThrough: body.readThrough, unread: 0 }) };
    });
});

test('a fresh visible active-thread entry is claimed as read and narrated', async () => {
    const record = { status: 'ready', job: 'job-9', artifact: 'narration:reply:0', mimeType: 'audio/mpeg' };
    makeThread('m-visible', Date.now(), record);
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0].body).toMatchObject({ target: { avatar: 'nova.png', branchId: 'main', createdAt: 123 }, messageIds: ['m-visible'], readThrough: 'm-visible' });
    expect(playPrepared).toHaveBeenCalledWith(record, expect.objectContaining({ id: 'm-visible' }), expect.any(Function), expect.any(Object));
    expect(narrateBrowser).not.toHaveBeenCalled();
    expect(indicators).toHaveBeenCalled();
});

test('a fresh active-thread entry stays put while the page is hidden', async () => {
    makeThread('m-hidden', Date.now(), { status: 'browser', provider: 'Kokoro' });
    visibilityState = 'hidden';
    globalThis.document = { visibilityState };
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(narrateBrowser).not.toHaveBeenCalled();
});

test('a fresh entry on a non-viewed thread is claimed and alerts without audio', async () => {
    makeThread('m-alert', Date.now(), { status: 'browser', provider: 'Kokoro' });
    activeAvatar = 'someone-else.png';
    await presentation.presentPendingConversationClaims('alice');
    expect(fetchCalls[0].body.readThrough).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('nova.png', expect.objectContaining({ id: 'm-alert' }), true, { branchId: 'main', groupId: '', personaId: 'p.png' });
    expect(narrateBrowser).not.toHaveBeenCalled();
});

test('a stale entry is consumed silently', async () => {
    makeThread('m-stale', Date.now() - 10 * 60 * 1000, { status: 'browser', provider: 'Kokoro' });
    activeAvatar = 'someone-else.png';
    await presentation.presentPendingConversationClaims('alice');
    expect(fetchCalls[0].body.readThrough).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    expect(narrateBrowser).not.toHaveBeenCalled();
});

test('a browser-provider record narrates through the existing TTS path', async () => {
    makeThread('m-browser', Date.now(), { status: 'browser', provider: 'Kokoro' });
    await presentation.presentPendingConversationClaims('alice');
    expect(narrateBrowser).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-browser' }), { isStillVisible: expect.any(Function), token: expect.any(Object) });
    expect(playPrepared).not.toHaveBeenCalled();
});

test('a refused record warns once per provider while a failed record only logs', async () => {
    wonNarration = { status: 'refused', code: 'TTS_BROWSER_ONLY', provider: 'System' };
    makeThread('m-refused', Date.now());
    store.characters['nova.png'].branches.main.pendingPresentations['m-refused-2'] = { at: Date.now(), job: 'root-1', narration: wonNarration };
    store.characters['nova.png'].branches.main.messages.push({ id: 'm-refused-2', role: 'assistant', name: 'Nova', mes: 'And another.' });
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
    expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('System');
});

test('an id claimed once is not claimed again on the next readback', async () => {
    makeThread('m-once', Date.now(), { status: 'browser', provider: 'Kokoro' });
    await presentation.presentPendingConversationClaims('alice');
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test('a failed claim leaves the entry for the next readback', async () => {
    makeThread('m-retry', Date.now(), { status: 'browser', provider: 'Kokoro' });
    claimOk = false;
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(narrateBrowser).not.toHaveBeenCalled();
    claimOk = true;
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(narrateBrowser).toHaveBeenCalledTimes(1);
});

test('a concurrent readback is rerun so its newer bubble is not stranded', async () => {
    makeThread('m-first', Date.now(), { status: 'browser', provider: 'Kokoro' });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = jest.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push({ url, body });
        await gate;
        const won = {};
        for (const id of body.messageIds) {
            won[id] = wonNarration;
        }
        return { ok: true, json: async () => ({ won, version: 1 }) };
    });
    const first = presentation.presentPendingConversationClaims('alice');
    store.characters['nova.png'].branches.main.pendingPresentations['m-second'] = { at: Date.now(), job: 'root-2', narration: null };
    store.characters['nova.png'].branches.main.messages.push({ id: 'm-second', role: 'assistant', name: 'Nova', mes: 'And another.' });
    const second = presentation.presentPendingConversationClaims('alice');
    release();
    await Promise.all([first, second]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(fetchCalls[1].body.messageIds).toContain('m-second');
});

test('a thread switch during the claim suppresses prepared narration', async () => {
    const record = { status: 'ready', job: 'job-9', artifact: 'narration:reply:0', mimeType: 'audio/mpeg' };
    makeThread('m-switch', Date.now(), record);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = jest.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push({ url, body });
        await gate;
        const won = {};
        for (const id of body.messageIds) {
            won[id] = record;
        }
        return { ok: true, json: async () => ({ won, version: 1 }) };
    });
    const pending = presentation.presentPendingConversationClaims('alice');
    activeAvatar = 'someone-else.png';
    release();
    await pending;
    expect(playPrepared).not.toHaveBeenCalled();
});

test('a cancelled playback stops the rest of the claimed batch', async () => {
    const record = { status: 'ready', job: 'job-1', artifact: 'narration:reply:0', mimeType: 'audio/mpeg' };
    store = {
        characters: {
            'nova.png': {
                branches: {
                    main: {
                        pendingPresentations: {
                            'm-a': { at: Date.now(), job: 'root-1', narration: record },
                            'm-b': { at: Date.now() + 1, job: 'root-1', narration: record },
                        },
                        messages: [
                            { id: 'm-a', role: 'assistant', name: 'Nova', mes: 'A' },
                            { id: 'm-b', role: 'assistant', name: 'Nova', mes: 'B' },
                        ],
                    },
                },
            },
        },
    };
    activeAvatar = 'nova.png';
    activeBranchId = 'main';
    playPrepared.mockImplementationOnce(async () => { playbackCurrent = false; return false; });
    await presentation.presentPendingConversationClaims('alice');
    expect(playPrepared).toHaveBeenCalledTimes(1);
});

test('changing persona during a claim suppresses the old persona notification', async () => {
    makeThread('m-persona', Date.now());
    activeAvatar = 'other.png';
    globalThis.fetch.mockImplementationOnce(async () => {
        samePersona = false;
        return { ok: true, json: async () => ({ won: { 'm-persona': null } }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(notify).not.toHaveBeenCalled();
});

test('opening a thread during a claim uses its current viewing state', async () => {
    const record = { status: 'ready', job: 'job', artifact: 'audio' };
    makeThread('m-open-during-claim', Date.now(), record);
    activeAvatar = '';
    globalThis.fetch.mockImplementationOnce(async () => {
        activeAvatar = 'nova.png';
        return { ok: true, json: async () => ({ won: { 'm-open-during-claim': record } }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(playPrepared).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
});

test.each(['expiry', 'kokoro-stop'])('%s while narrating prevents the next bubble', async reason => {
    const record = { status: 'browser', provider: 'Kokoro' };
    const first = `m-${reason}-1`;
    const second = `m-${reason}-2`;
    const now = Date.now();
    makeThread(first, now, record);
    const branch = store.characters['nova.png'].branches.main;
    branch.pendingPresentations[second] = { at: now, narration: record };
    branch.messages.push({ id: second, role: 'character', mes: 'Second' });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    narrateBrowser.mockImplementationOnce(async () => {
        clock.mockReturnValue(now + 6 * 60 * 1000);
        return reason !== 'kokoro-stop';
    });
    try {
        await presentation.presentPendingConversationClaims('alice');
        expect(narrateBrowser).toHaveBeenCalledTimes(1);
    } finally {
        clock.mockRestore();
    }
});

test('a disabled group speaker is excluded both initially and after playback waits', async () => {
    const record = { status: 'ready', job: 'job', artifact: 'audio' };
    makeThread('m-group', Date.now(), record);
    groupId = 'crew';
    group = { members: ['nova.png', 'kit.png'], disabled_members: [] };
    store.characters['nova.png'].branches.main.messages[0].extra = { partner_avatar: 'kit.png' };
    await presentation.presentPendingConversationClaims('alice');
    const stillVisible = playPrepared.mock.calls[0][2];
    expect(stillVisible()).toBe(true);
    group.disabled_members.push('kit.png');
    expect(stillVisible()).toBe(false);
    makeThread('m-disabled-group', Date.now(), record);
    store.characters['nova.png'].branches.main.messages[0].extra = { partner_avatar: 'kit.png' };
    await presentation.presentPendingConversationClaims('alice');
    expect(playPrepared).toHaveBeenCalledTimes(1);
});

test('explicit read acknowledges the observed boundary once without consuming presentations', async () => {
    makeThread('m-read', Date.now());
    await Promise.all([
        presentation.markConversationBranchRead('nova.png', { branchId: 'main' }),
        presentation.markConversationBranchRead('nova.png', { branchId: 'main' }),
    ]);
    await presentation.markConversationBranchRead('nova.png', { branchId: 'main' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0].body).toMatchObject({ messageIds: [], readThrough: 'm-read', target: { createdAt: 123 } });
});

test('discovery retries a failed read with no pending presentations and then stops posting', async () => {
    makeThread('m-read-retry', Date.now());
    const branch = store.characters['nova.png'].branches.main;
    delete branch.pendingPresentations;
    branch.unread = 1;
    branch.readThrough = '';
    claimOk = false;
    await presentation.presentPendingConversationClaims('alice');
    expect(branch.unread).toBe(1);
    claimOk = true;
    await presentation.presentPendingConversationClaims('alice');
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(fetchCalls[1].body).toMatchObject({ messageIds: [], readThrough: 'm-read-retry', target: { createdAt: 123 } });
    expect(branch.unread).toBe(0);
    expect(renderRail).toHaveBeenCalledTimes(1);
});

test.each([false, true])('a delayed acknowledgement preserves a newer unread message (pending: %s)', async pending => {
    makeThread(`m-late-read-${pending}`, Date.now());
    const branch = store.characters['nova.png'].branches.main;
    if (!pending) delete branch.pendingPresentations;
    globalThis.fetch.mockImplementationOnce(async (_url, options) => {
        const body = JSON.parse(options.body);
        activeAvatar = 'other.png';
        branch.messages.push({ id: 'new-unseen', role: 'character', mes: 'Unseen' });
        branch.unread = 1;
        return { ok: true, json: async () => ({ won: {}, readThrough: body.readThrough, unread: 0 }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(branch.unread).toBe(1);
});

test.each(['hidden', 'other-thread', 'other-persona', 'already-read'])('discovery does not acknowledge %s history without pending entries', async condition => {
    makeThread(`m-read-${condition}`, Date.now());
    const branch = store.characters['nova.png'].branches.main;
    delete branch.pendingPresentations;
    if (condition === 'hidden') globalThis.document.visibilityState = 'hidden';
    if (condition === 'other-thread') activeAvatar = 'other.png';
    if (condition === 'other-persona') samePersona = false;
    if (condition === 'already-read') branch.readThrough = branch.messages.at(-1).id;
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(['edit', 'delete', 'replacement'])('%s invalidates already-claimed audio during download', async change => {
    makeThread(`m-live-${change}`, Date.now(), { status: 'ready' });
    playPrepared.mockImplementationOnce(async (_record, _message, visible) => {
        const branch = store.characters['nova.png'].branches.main;
        expect(visible()).toBe(true);
        if (change === 'edit') branch.messages[0].mes = 'Changed';
        if (change === 'delete') branch.messages = [];
        if (change === 'replacement') branch.createdAt += 1;
        expect(visible()).toBe(false);
        return false;
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(playPrepared).toHaveBeenCalledTimes(1);
});

test('Stop during the claim cancels speech before download', async () => {
    makeThread('m-claim-stop', Date.now(), { status: 'ready' });
    globalThis.fetch.mockImplementationOnce(async () => {
        expect(beginNarration).toHaveBeenCalledTimes(1);
        playbackCurrent = false;
        return { ok: true, json: async () => ({ won: { 'm-claim-stop': { status: 'ready' } } }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(playPrepared).not.toHaveBeenCalled();
    expect(endPlayback).toHaveBeenCalledTimes(1);
});

test('recoverable generic conflicts are retried', async () => {
    makeThread('m-generic-retry', Date.now(), { status: 'ready' });
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'conversation_conflict', recoverable: true }) });
    await presentation.presentPendingConversationClaims('alice');
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(playPrepared).toHaveBeenCalledTimes(1);
});

test('a persona switch leaves later branches unclaimed', async () => {
    makeThread('m-persona-branch-1', Date.now());
    store.characters['nova.png'].branches.side = { createdAt: 124,
        messages: [{ id: 'm-persona-branch-2', mes: 'Second' }],
        pendingPresentations: { 'm-persona-branch-2': { at: Date.now() } } };
    globalThis.fetch.mockImplementationOnce(async () => {
        samePersona = false;
        return { ok: true, json: async () => ({ won: { 'm-persona-branch-1': null } }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test('a speaker disabled during a claim does not alert for a non-viewed group', async () => {
    makeThread('m-group-alert', Date.now());
    groupId = 'crew';
    group = { members: ['nova.png', 'kit.png'], disabled_members: [] };
    store.characters['nova.png'].branches.main.messages[0].extra = { partner_avatar: 'kit.png' };
    activeAvatar = 'other.png';
    globalThis.fetch.mockImplementationOnce(async () => {
        group.disabled_members.push('kit.png');
        return { ok: true, json: async () => ({ won: { 'm-group-alert': null } }) };
    });
    await presentation.presentPendingConversationClaims('alice');
    expect(notify).not.toHaveBeenCalled();
});

test('expiry during one download still allows a younger entry to play', async () => {
    const now = Date.now();
    makeThread('m-old-download', now - 290000, { status: 'ready' });
    const branch = store.characters['nova.png'].branches.main;
    branch.messages.push({ id: 'm-young-download', mes: 'New' });
    branch.pendingPresentations['m-young-download'] = { at: now, narration: { status: 'ready' } };
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    playPrepared.mockImplementationOnce(async (_record, _message, visible) => {
        clock.mockReturnValue(now + 11000);
        expect(visible()).toBe(false);
        return false;
    });
    try {
        await presentation.presentPendingConversationClaims('alice');
        expect(playPrepared).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
});

test('a stalled viewing download cannot block another thread notification', async () => {
    makeThread('m-stalled-thread', Date.now(), { status: 'ready' });
    let release;
    playPrepared.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = presentation.presentPendingConversationClaims('alice');
    await new Promise(resolve => setTimeout(resolve, 0));
    store.characters['kit.png'] = { branches: { main: { createdAt: 125,
        messages: [{ id: 'm-other-thread', mes: 'Hello' }],
        pendingPresentations: { 'm-other-thread': { at: Date.now() } } } } };
    await presentation.presentPendingConversationClaims('alice');
    expect(notify).toHaveBeenCalledWith('kit.png', expect.any(Object), true, expect.any(Object));
    release(true);
    await first;
});
