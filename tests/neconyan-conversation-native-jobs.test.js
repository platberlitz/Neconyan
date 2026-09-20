import { beforeEach, expect, jest, test } from '@jest/globals';

let account = 'alice';
const observers = new Map();
const refresh = jest.fn();
const repaint = jest.fn();
const cancel = jest.fn();
const list = jest.fn();
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob: cancel, listJobs: list,
    observeJob: (id, options) => {
        observers.set(id, options);
        return () => options.onStop();
    },
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ refreshConversationStore: refresh }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: repaint }));
const native = await import('../public/scripts/neconyan-conversation/native-jobs.js');

beforeEach(() => {
    native.stopNativeConversationObservation();
    observers.clear();
    jest.clearAllMocks();
    account = 'alice';
});

test('concurrent observations await one follow-up read and retain account-bound cancellation', async () => {
    let releaseFirst;
    let releaseSecond;
    refresh.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }));
    for (const id of ['one', 'two', 'three']) native.observeNativeConversationJob(id);
    const promises = [...observers.values()].map(options => options.onSnapshot());
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseFirst({ conflict: false });
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
    await expect(observers.get('old').onSnapshot()).rejects.toThrow('account_changed');
    expect(repaint).not.toHaveBeenCalled();
    observers.get('old').onStop();
    expect(native.isObservingConversationJob('old')).toBe(false);
});
