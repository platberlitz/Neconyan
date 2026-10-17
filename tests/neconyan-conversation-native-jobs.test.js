/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let account = 'alice';
const observers = new Map();
const refresh = jest.fn();
const repaint = jest.fn();
const cancel = jest.fn();
const list = jest.fn();
const review = jest.fn();
const stopPreview = jest.fn();
const preview = jest.fn(() => stopPreview);
jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-preview.js', () => ({ observeNativeConversationPreview: preview }));
jest.unstable_mockModule('../public/scripts/neconyan-assistant-job-review.js', () => ({ reviewAssistantJobChildren: review }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob: cancel, listJobs: list,
    TERMINAL: new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']),
    observeJob: (id, options) => {
        observers.set(id, options);
        return () => options.onStop();
    },
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ refreshConversationStore: refresh }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: repaint }));
const present = jest.fn();
jest.unstable_mockModule('../public/scripts/neconyan-conversation/presentation.js', () => ({ presentPendingConversationClaims: present }));
const native = await import('../public/scripts/neconyan-conversation/native-jobs.js');

let dispatched;
let toastr;
beforeEach(() => {
    native.stopNativeConversationObservation();
    observers.clear();
    jest.clearAllMocks();
    account = 'alice';
    dispatched = jest.fn();
    globalThis.dispatchEvent = dispatched;
    toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };
    globalThis.toastr = toastr;
});

afterEach(() => {
    delete globalThis.dispatchEvent;
    delete globalThis.toastr;
});

const events = () => dispatched.mock.calls.map(([event]) => event).filter(event => event.type === 'neconyan:image-input-refused');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('active replies attach one preview and stop it when observation ends', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('stream');
    const observer = observers.get('stream');
    await observer.onSnapshot({ type: 'conversation.reply', state: 'running' });
    await observer.onSnapshot({ type: 'conversation.reply', state: 'running' });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('stream', 'alice');
    observer.onStop('done');
    expect(stopPreview).toHaveBeenCalledTimes(1);
});

test('discovery reads completions with no active observer and retries presentation on the next discovery', async () => {
    list.mockResolvedValue([{ id: 'finished', type: 'conversation.reply', state: 'completed' }]);
    refresh.mockResolvedValue({ conflict: false });
    await native.resumeNativeConversationObservation();
    expect(observers.size).toBe(0);
    expect(present).toHaveBeenCalledTimes(1);
    await native.resumeNativeConversationObservation();
    expect(present).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(repaint).not.toHaveBeenCalled();
    list.mockReset();
    refresh.mockReset();
});

test('concurrent observations await one follow-up read and retain account-bound cancellation', async () => {
    let releaseFirst;
    let releaseSecond;
    refresh.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }));
    for (const id of ['one', 'two', 'three']) native.observeNativeConversationJob(id);
    const promises = [...observers.values()].map(options => options.onSnapshot({}));
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseFirst({ conflict: false, changed: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(repaint).not.toHaveBeenCalled();
    releaseSecond({ conflict: false });
    await Promise.all(promises);
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls).toEqual([['alice'], ['alice']]);
    account = 'bob';
    await native.cancelNativeConversationJob('one');
    expect(cancel).toHaveBeenCalledWith('one', { reason: 'Cancelled from Conversation Mode.', account: 'alice' });
    expect(native.isObservingConversationJob('one')).toBe(false);
});

test('a successful readback hands pending presentations to the presenter', async () => {
    refresh.mockResolvedValueOnce({ conflict: false });
    native.observeNativeConversationJob('present');
    await observers.get('present').onSnapshot({});
    expect(present).toHaveBeenCalledWith('alice');
    present.mockClear();
    refresh.mockRejectedValueOnce(Object.assign(new Error('conflict'), { conflict: true }));
    await expect(observers.get('present').onSnapshot({})).rejects.toThrow('conflict');
    expect(present).not.toHaveBeenCalled();
});

test('a pruned job stops observation and reads back its saved effects', async () => {
    let release;
    refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    native.observeNativeConversationJob('gone');
    observers.get('gone').onStop('missing');
    expect(refresh).toHaveBeenCalledWith('alice');
    expect(native.isObservingConversationJob('gone')).toBe(false);
    release({ conflict: false });
    await tick();
    await tick();
    expect(native.isObservingConversationJob('gone')).toBe(false);
    expect(present).toHaveBeenCalledWith('alice');
});

test('a failed pruned-job refresh can be retried by discovery', async () => {
    refresh.mockRejectedValueOnce(new Error('offline'));
    native.observeNativeConversationJob('gone');
    observers.get('gone').onStop('missing');
    await tick();
    await tick();
    expect(native.isObservingConversationJob('gone')).toBe(false);
    expect(present).not.toHaveBeenCalled();
    list.mockResolvedValueOnce([]);
    refresh.mockResolvedValueOnce({ conflict: false });
    await native.resumeNativeConversationObservation();
    expect(present).toHaveBeenCalledWith('alice');
});

test('late lists and readbacks are not adopted after an account change', async () => {
    list.mockImplementationOnce(async () => {
        account = 'bob';
        return [{ id: 'old', type: 'conversation.reply' }];
    });
    await native.resumeNativeConversationObservation();
    expect(observers.size).toBe(0);
    account = 'alice';
    native.observeNativeConversationJob('old');
    refresh.mockImplementationOnce(async () => { account = 'bob'; return { conflict: false }; });
    await expect(observers.get('old').onSnapshot({})).rejects.toThrow('account_changed');
    expect(repaint).not.toHaveBeenCalled();
    observers.get('old').onStop();
    expect(native.isObservingConversationJob('old')).toBe(false);
});

// A composer send is accepted; the reply job then fails if the server refuses an image. This observer is the only reader of that job, so it
// raises the one notice (D11). Any other failure is not reported by it, as before; the jobs that a caller waits for report themselves.
const refusedReply = (extra = {}) => ({ id: 'refused', type: 'conversation.reply', state: 'failed',
    error: { message: 'The image cannot be sent as it is. It stays in the gallery.', code: 'ROLEPLAY_IMAGE_INPUT', status: 409 }, ...extra });

test('a reply job refused for an image raises the one notice with the reason from the job, and no toast', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    await observers.get('refused').onSnapshot(refusedReply());
    expect(events()).toHaveLength(1);
    expect(events()[0].detail).toEqual({ message: 'The image cannot be sent as it is. It stays in the gallery.' });
    expect(toastr.error).not.toHaveBeenCalled();
    expect(toastr.warning).not.toHaveBeenCalled();
    // The readback of the saved messages still ran.
    expect(refresh).toHaveBeenCalledWith('alice');
});

test('the notice is raised once for one job, even when its terminal snapshot is read again after a failed readback', async () => {
    native.observeNativeConversationJob('refused');
    const observer = observers.get('refused');
    refresh.mockRejectedValueOnce(Object.assign(new Error('conflict'), { conflict: true }));
    await expect(observer.onSnapshot(refusedReply())).rejects.toThrow('conflict');
    expect(events()).toHaveLength(1);
    refresh.mockResolvedValue({ conflict: false });
    await observer.onSnapshot(refusedReply());
    await observer.onSnapshot(refusedReply());
    expect(events()).toHaveLength(1);
    // Another job that is refused gets its own notice.
    native.observeNativeConversationJob('refused-again');
    await observers.get('refused-again').onSnapshot(refusedReply({ id: 'refused-again' }));
    expect(events()).toHaveLength(2);
});

test('a job error that carries the issue keeps its fields in the notice', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    const imageIssue = { reason: 'invalid-policy', index: -1, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] };
    await observers.get('refused').onSnapshot(refusedReply({ error: { message: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT', status: 409, imageIssue } }));
    expect(events().map(event => event.detail)).toEqual([{ ...imageIssue, message: 'Words.' }]);
});

test('a reply job that is still running or completed raises nothing', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    const observer = observers.get('refused');
    await observer.onSnapshot(refusedReply({ state: 'running' }));
    await observer.onSnapshot(refusedReply({ state: 'waiting' }));
    await observer.onSnapshot(refusedReply({ state: 'completed' }));
    expect(events()).toHaveLength(0);
});

test('any other reply job failure is still not reported by this observer', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    const observer = observers.get('refused');
    await observer.onSnapshot(refusedReply({ error: { message: 'The provider closed the connection.', code: 'JOB_FAILED', status: 502 } }));
    await observer.onSnapshot(refusedReply({ error: { message: 'Words.', code: 'ROLEPLAY_INVALID', status: 409 } }));
    await observer.onSnapshot(refusedReply({ state: 'interrupted', error: { message: 'The server restarted.', code: 'JOB_FAILED', status: 500 } }));
    await observer.onSnapshot(refusedReply({ error: undefined }));
    await observer.onSnapshot(refusedReply({ error: 'The reply failed.' }));
    expect(events()).toHaveLength(0);
    for (const method of ['error', 'warning', 'info', 'success']) expect(toastr[method]).not.toHaveBeenCalled();
});

test('the rewrite, selfie, schedule and summary jobs are not reported here, because the call that started them reports them', async () => {
    refresh.mockResolvedValue({ conflict: false });
    for (const type of ['conversation.rewrite', 'conversation.selfie', 'conversation.schedule', 'conversation.summary']) {
        native.observeNativeConversationJob(type);
        await observers.get(type).onSnapshot(refusedReply({ id: type, type }));
    }
    expect(events()).toHaveLength(0);
});

// The notice opens the review for the thread the job was for. The job record names it: the character, group, persona and branch of its
// intent.target, and the branch's createdAt on job.target (the record has no lifetimeSeed). Nothing is read from the page when the job fails.
const jobFor = (target, createdAt, extra = {}) => refusedReply({ intent: { mode: 'send', target }, target: { kind: 'conversation', id: 'thread-key', branchId: target.branchId, createdAt }, ...extra });

test('a refused reply job carries the thread and branch its record names, and the account that watches it', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    await observers.get('refused').onSnapshot(jobFor({ avatar: 'a.png', groupId: '', personaId: 'user-default.png', branchId: 'main' }, 111));
    expect(events().map(event => event.detail.origin)).toEqual([{ workspace: 'conversation', account: 'alice', avatar: 'a.png', groupId: '', personaId: 'user-default.png', branchId: 'main', createdAt: '111' }]);
});

test('a group thread keeps its group id, and a job record that names no group is a solo thread', async () => {
    refresh.mockResolvedValue({ conflict: false });
    native.observeNativeConversationJob('refused');
    await observers.get('refused').onSnapshot(jobFor({ avatar: 'a.png', groupId: 'group-7', personaId: 'user-default.png', branchId: 'br_1' }, 222));
    native.observeNativeConversationJob('refused-again');
    await observers.get('refused-again').onSnapshot(jobFor({ avatar: 'b.png', personaId: 'user-default.png', branchId: 'main' }, 333, { id: 'refused-again' }));
    expect(events().map(event => event.detail.origin)).toMatchObject([{ avatar: 'a.png', groupId: 'group-7', branchId: 'br_1' }, { avatar: 'b.png', groupId: '', branchId: 'main' }]);
});

test('the origin is the job\'s own: a job watched under another account carries that account, and a record with no thread carries no origin', async () => {
    refresh.mockResolvedValue({ conflict: false });
    account = 'bob';
    native.observeNativeConversationJob('refused', 'bob');
    await observers.get('refused').onSnapshot(jobFor({ avatar: 'a.png', groupId: '', personaId: 'p.png', branchId: 'main' }, 1));
    native.observeNativeConversationJob('bare', 'bob');
    await observers.get('bare').onSnapshot(refusedReply({ id: 'bare' }));
    expect(events().map(event => event.detail.origin?.account)).toEqual(['bob', undefined]);
    expect(events()[1].detail).not.toHaveProperty('origin');
});
