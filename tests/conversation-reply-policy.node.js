import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    buildAvailabilityAutoResponderText, chooseGroupReplyCandidates, getConversationAvailabilityDecision,
    getInitialAvailabilityDelayMs, getReplyDelayMsForStatus, isBroadGroupAddress,
} = await import('../src/generation/conversation-participants.js');
const { acceptChildJobs, acceptJob, dismissJob, getJob, releaseChildJobs, requestCancellation, retryConversationFamily, updateJob } = await import('../src/jobs/store.js');
const { reconcileConversationJob } = await import('../src/generation/conversation-worker.js');

const candidate = (avatar, status = 'online', name = avatar) => ({ avatar, name, status });

test('group selection prefers mentions, then the previous speaker, and honours offline/force', () => {
    const messages = [
        { role: 'user', mes: 'hello' },
        { role: 'character', mes: 'hi', extra: {} },
    ];
    const candidates = [candidate('a.png'), candidate('b.png'), candidate('c.png', 'offline')];

    const mentioned = chooseGroupReplyCandidates({ candidates, threadAvatar: 'a.png', messages,
        latestUserText: 'hey @b.png what do you think', random: () => 0.5 });
    assert.deepEqual(mentioned.avatars, ['b.png']);

    const previous = chooseGroupReplyCandidates({ candidates, threadAvatar: 'a.png', messages,
        latestUserText: 'continue', random: () => 0 });
    assert.equal(previous.avatars[0], 'a.png');

    // Offline candidates are skipped when anyone is available, but the pool
    // falls back to everyone rather than answering nobody.
    const offlinePool = [candidate('a.png'), candidate('c.png', 'offline'), candidate('d.png', 'offline')];
    const preferOnline = chooseGroupReplyCandidates({ candidates: offlinePool, threadAvatar: 'a.png',
        messages: [], latestUserText: 'ping', random: () => 0 });
    assert.deepEqual(preferOnline.avatars, ['a.png']);
    const allOffline = chooseGroupReplyCandidates({ candidates: [candidate('c.png', 'offline')], threadAvatar: 'x',
        messages: [], latestUserText: 'ping', random: () => 0 });
    assert.deepEqual(allOffline.avatars, ['c.png']);
    const forced = chooseGroupReplyCandidates({ candidates: [candidate('c.png', 'offline')], threadAvatar: 'x',
        messages: [], latestUserText: 'ping', force: true, random: () => 0 });
    assert.deepEqual(forced.avatars, ['c.png']);
});

test('a broad address does not fall back to the previous speaker, and a second draw stays under one third', () => {
    const messages = [{ role: 'character', mes: 'hi' }, { role: 'user', mes: 'everyone?' }];
    const candidates = [candidate('a.png'), candidate('b.png')];
    const broad = chooseGroupReplyCandidates({ candidates, threadAvatar: 'a.png', messages,
        latestUserText: 'everyone?', random: () => 0 });
    // Two draws both at random 0 -> deterministic weighted picks, unique names.
    assert.equal(broad.avatars.length, 2);
    assert.deepEqual([...new Set(broad.avatars)].sort(), ['a.png', 'b.png']);

    const noSecond = chooseGroupReplyCandidates({ candidates, threadAvatar: 'a.png', messages: [],
        latestUserText: 'go', random: () => 0.5 });
    // 0.5 is above the 0.3 second-draw threshold, so only the first pick is returned.
    assert.equal(noSecond.avatars.length, 1);
    assert.equal(isBroadGroupAddress('hello everyone'), true);
    assert.equal(isBroadGroupAddress('hello eveyone'), false);
    assert.equal(isBroadGroupAddress('y’all around?'), true);
    assert.equal(isBroadGroupAddress('you  all there?'), true);

    // A mention of an offline member loses to an available one.
    const offlineMention = chooseGroupReplyCandidates({ candidates: [candidate('a.png'), candidate('c.png', 'offline')],
        threadAvatar: 'a.png', messages: [], latestUserText: '@c.png are you there?', random: () => 0.5 });
    assert.deepEqual(offlineMention.avatars, ['a.png']);
});

test('availability mirrors the browser order and coexists with force', () => {
    assert.deepEqual(getConversationAvailabilityDecision({ settings: { availability: 'offline' }, activity: { status: 'offline' } }), { action: 'skip', status: 'offline' });
    assert.deepEqual(getConversationAvailabilityDecision({ settings: { availability: 'offline' }, activity: { status: 'offline' }, force: true }), { action: 'reply', status: 'offline' });
    // Raw manual dnd triggers the autoresponder even when a schedule says online.
    assert.equal(getConversationAvailabilityDecision({ settings: { availability: 'dnd' }, activity: { status: 'online' }, solo: true }).action, 'autoresponder');
    // A group thread does not run the solo autoresponder.
    assert.equal(getConversationAvailabilityDecision({ settings: { availability: 'dnd' }, activity: { status: 'online' }, solo: false }).action, 'reply');
    assert.equal(getConversationAvailabilityDecision({ settings: { availability: 'online' }, activity: { status: 'idle' } }).action, 'delay');
    assert.equal(getInitialAvailabilityDelayMs('idle', () => 0), 1500);
    assert.equal(getInitialAvailabilityDelayMs('dnd', () => 0), 3000);
    assert.equal(getReplyDelayMsForStatus('hello', { reply_delay_multiplier: 0 }, 'online'), 0);
    assert.match(buildAvailabilityAutoResponderText({ offline_message: '[{{char}} is away for {{user}}]' }, 'Nova', 'Sam'), /Nova is away for Sam/);
});

test('a root parks at waiting/children and its sibling participants dispatch, complete and cancel as one family', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-family-'));
    const directories = { root };
    const parent = acceptJob(directories, {
        owner: 'tester', type: 'conversation.reply', submissionKey: 'root', paused: true, intent: {}, config: {}, credentialRef: null,
        target: { kind: 'conversation', id: 'thread', branchId: 'main' },
    }).job;
    const children = acceptChildJobs(directories, parent.id, [
        { participantKey: 'a.png', intent: {}, target: { kind: 'conversation', id: 'thread', branchId: 'main' }, config: {}, credentialRef: null },
        { participantKey: 'b.png', intent: {}, target: { kind: 'conversation', id: 'thread', branchId: 'main' }, config: {}, credentialRef: null },
    ]);
    assert.equal(children.length, 2);
    assert.equal(getJob(directories, parent.id).children.length, 2);
    assert.ok(children.every(child => child.parentId === parent.id && child.state === 'waiting' && child.stage === 'preparing'));
    // Re-materialising the same keys returns the same children.
    const again = acceptChildJobs(directories, parent.id, [
        { participantKey: 'a.png', intent: {}, target: { kind: 'conversation', id: 'thread', branchId: 'main' } },
    ]);
    assert.equal(again[0].id, children[0].id);

    releaseChildJobs(directories, parent.id);
    assert.match(getJob(directories, parent.id).stage, /children/);
    assert.ok(children.every(child => getJob(directories, child.id).state === 'queued'));

    updateJob(directories, children[0].id, { state: 'completed' });
    updateJob(directories, children[1].id, { state: 'completed' });
    assert.equal(reconcileConversationJob(directories, getJob(directories, parent.id)), true);
    const finished = getJob(directories, parent.id);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.result.participants.length, 2);

    // Cancelling an unfinished family marks the child in the same write.
    const second = acceptJob(directories, {
        owner: 'tester', type: 'conversation.reply', submissionKey: 'root-2', paused: true, intent: {}, config: {}, credentialRef: null,
        target: { kind: 'conversation', id: 'thread2', branchId: 'main' },
    }).job;
    const cancelChildren = acceptChildJobs(directories, second.id, [
        { participantKey: 'a.png', intent: {}, target: { kind: 'conversation', id: 'thread2', branchId: 'main' } },
    ]);
    releaseChildJobs(directories, second.id);
    requestCancellation(directories, second.id, { reason: 'test' });
    assert.equal(getJob(directories, cancelChildren[0].id).state, 'cancelled');

    // A cancellation that lands during preparation must stop the children when
    // they are released rather than dispatch already-cancelled work.
    const third = acceptJob(directories, {
        owner: 'tester', type: 'conversation.reply', submissionKey: 'root-3', paused: true, intent: {}, config: {}, credentialRef: null,
        target: { kind: 'conversation', id: 'thread3', branchId: 'main' },
    }).job;
    const thirdChildren = acceptChildJobs(directories, third.id, [
        { participantKey: 'a.png', intent: {}, target: { kind: 'conversation', id: 'thread3', branchId: 'main' } },
    ]);
    requestCancellation(directories, third.id, { reason: 'race' });
    releaseChildJobs(directories, third.id);
    assert.equal(getJob(directories, thirdChildren[0].id).state, 'cancelled');
    assert.equal(getJob(directories, third.id).state, 'cancelled');

    // Retry requeues only the failed participant and reopens the root.
    const fourth = acceptJob(directories, {
        owner: 'tester', type: 'conversation.reply', submissionKey: 'root-4', paused: true, intent: {}, config: {}, credentialRef: null,
        target: { kind: 'conversation', id: 'thread4', branchId: 'main' },
    }).job;
    const fourthChildren = acceptChildJobs(directories, fourth.id, [
        { participantKey: 'a.png', intent: {}, target: { kind: 'conversation', id: 'thread4', branchId: 'main' } },
        { participantKey: 'b.png', intent: {}, target: { kind: 'conversation', id: 'thread4', branchId: 'main' } },
    ]);
    releaseChildJobs(directories, fourth.id);
    updateJob(directories, fourthChildren[0].id, { state: 'completed' });
    updateJob(directories, fourthChildren[1].id, { state: 'failed' });
    updateJob(directories, fourth.id, { state: 'failed' });
    retryConversationFamily(directories, fourth.id);
    assert.equal(getJob(directories, fourthChildren[0].id).state, 'completed');
    assert.equal(getJob(directories, fourthChildren[1].id).state, 'queued');
    assert.equal(getJob(directories, fourth.id).stage, 'children');

    // Dismissing the root also dismisses its participants so the family can prune.
    dismissJob(directories, fourth.id);
    assert.equal(getJob(directories, fourthChildren[1].id).dismissed, true);
    assert.ok(Number.isFinite(getJob(directories, parent.id).finishedAt));
    fs.rmSync(root, { recursive: true, force: true });
});
