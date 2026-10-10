import { beforeEach, expect, jest, test } from '@jest/globals';

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

beforeEach(() => {
    native.stopNativeConversationObservation();
    observers.clear();
    jest.clearAllMocks();
    account = 'alice';
});

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
