import { describe, expect, test } from '@jest/globals';
import {
    MAX_QUEUED_FOLLOW_UPS,
    clearFollowUps,
    clearHold,
    createFollowUp,
    createFollowUpQueues,
    dequeueFollowUp,
    enqueueFollowUp,
    followUpKey,
    followUpState,
    holdFollowUps,
    reconcilePendingTransition,
    removeFollowUp,
    restoreFollowUp,
    takeFollowUpForEdit,
} from '../public/scripts/scratchpad/follow-up-queue.js';

const source = { kind: 'general', key: 'general:miso', context: { avatar: 'miso.png' } };
const other = { kind: 'roleplay', key: 'roleplay:chat-2' };

function item(text, extra = {}) {
    return createFollowUp({ text, source, sourceKey: source.key, createdAt: 1, ...extra });
}

describe('Scratchpad follow-up queue', () => {
    test('keys queues by bucket and session', () => {
        expect(followUpKey(source, 's1')).toBe('["general","general:miso"]:s1');
        expect(followUpKey(source, 's1')).not.toBe(followUpKey(source, 's2'));
        expect(followUpKey(source, 's1')).not.toBe(followUpKey(other, 's1'));
    });

    test('creates items with the documented shape and copies attachments', () => {
        const attachments = [{ name: 'notes.txt' }];
        const queued = createFollowUp({ text: '<b>after</b>', attachments, source, sourceKey: 'general:miso', createdAt: 7 });
        attachments.push({ name: 'late.txt' });
        expect(queued).toEqual({ id: expect.stringMatching(/^follow-up-7-/), text: '<b>after</b>', attachments: [{ name: 'notes.txt' }], sourceKey: 'general:miso', source, createdAt: 7 });
        expect(createFollowUp({ createdAt: 7 }).id).not.toBe(queued.id);
    });

    test('runs first in, first out and stops at the cap', () => {
        const queues = createFollowUpQueues();
        const key = followUpKey(source, 's1');
        for (let index = 0; index < MAX_QUEUED_FOLLOW_UPS; index += 1) {
            expect(enqueueFollowUp(queues, key, item(`message ${index}`)).added).toBe(true);
        }
        expect(MAX_QUEUED_FOLLOW_UPS).toBe(5);
        const refused = enqueueFollowUp(queues, key, item('one too many'));
        expect(refused.added).toBe(false);
        expect(refused.state.items).toHaveLength(5);
        expect(followUpState(queues, key).items.map(entry => entry.text)).toEqual(['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
        expect(dequeueFollowUp(queues, key).item.text).toBe('message 0');
        expect(dequeueFollowUp(queues, key).item.text).toBe('message 1');
        expect(followUpState(queues, key).items).toHaveLength(3);
    });

    test('dequeues nothing from an empty queue and forgets emptied queues', () => {
        const queues = createFollowUpQueues();
        const key = followUpKey(source, 's1');
        expect(dequeueFollowUp(queues, key)).toEqual({ item: null, state: { items: [], held: null } });
        enqueueFollowUp(queues, key, item('only'));
        holdFollowUps(queues, key, 'stopped');
        expect(dequeueFollowUp(queues, key).state).toEqual({ items: [], held: null });
        expect(queues.size).toBe(0);
    });

    test('takes an item out for editing and removes items by id', () => {
        const queues = createFollowUpQueues();
        const key = followUpKey(source, 's1');
        const first = item('first');
        const second = item('second');
        const third = item('third');
        for (const entry of [first, second, third]) enqueueFollowUp(queues, key, entry);
        const edited = takeFollowUpForEdit(queues, key, second.id);
        expect(edited.item).toBe(second);
        expect(edited.state.items).toEqual([first, third]);
        expect(takeFollowUpForEdit(queues, key, 'missing')).toEqual({ item: null, state: followUpState(queues, key) });
        expect(removeFollowUp(queues, key, first.id).items).toEqual([third]);
        expect(removeFollowUp(queues, key, 'missing').items).toEqual([third]);
        holdFollowUps(queues, key, 'failed');
        expect(removeFollowUp(queues, key, third.id)).toEqual({ items: [], held: null });
    });

    test('puts a failed send back at the front without duplicating it', () => {
        const queues = createFollowUpQueues();
        const key = followUpKey(source, 's1');
        const first = item('first');
        const second = item('second');
        enqueueFollowUp(queues, key, first);
        enqueueFollowUp(queues, key, second);
        const { item: sent } = dequeueFollowUp(queues, key);
        expect(restoreFollowUp(queues, key, sent).items).toEqual([first, second]);
        expect(restoreFollowUp(queues, key, first).items).toEqual([first, second]);
    });

    test('keeps each session and bucket separate', () => {
        const queues = createFollowUpQueues();
        const one = followUpKey(source, 's1');
        const two = followUpKey(source, 's2');
        const roleplay = followUpKey(other, 's1');
        enqueueFollowUp(queues, one, item('for one'));
        enqueueFollowUp(queues, two, item('for two'));
        enqueueFollowUp(queues, roleplay, item('for roleplay'));
        holdFollowUps(queues, one, 'stopped');
        expect(followUpState(queues, one)).toMatchObject({ held: 'stopped', items: [{ text: 'for one' }] });
        expect(followUpState(queues, two)).toMatchObject({ held: null, items: [{ text: 'for two' }] });
        expect(dequeueFollowUp(queues, roleplay).item.text).toBe('for roleplay');
        expect(followUpState(queues, two).items).toHaveLength(1);
    });

    test('clears every queue when the account changes', () => {
        const queues = createFollowUpQueues();
        enqueueFollowUp(queues, followUpKey(source, 's1'), item('mine'));
        enqueueFollowUp(queues, followUpKey(other, 's9'), item('also mine'));
        clearFollowUps(queues);
        expect(queues.size).toBe(0);
        expect(followUpState(queues, followUpKey(source, 's1'))).toEqual({ items: [], held: null });
    });

    test('holds and releases only queues that have items', () => {
        const queues = createFollowUpQueues();
        const key = followUpKey(source, 's1');
        expect(holdFollowUps(queues, key, 'stopped')).toEqual({ items: [], held: null });
        enqueueFollowUp(queues, key, item('waiting'));
        for (const reason of ['stopped', 'failed', 'context', 'reopened']) {
            expect(holdFollowUps(queues, key, reason).held).toBe(reason);
        }
        expect(() => holdFollowUps(queues, key, 'bored')).toThrow(TypeError);
        expect(clearHold(queues, key).held).toBeNull();
        expect(clearHold(queues, followUpKey(source, 'empty'))).toEqual({ items: [], held: null });
    });
});

describe('reconcilePendingTransition', () => {
    const settled = (states, extra = {}) => reconcilePendingTransition({ wasPending: true, isPending: false, settledStates: states, visible: true, sameSource: true, ...extra });

    test('sends once the reply finishes cleanly', () => {
        expect(settled(['done'])).toBe('send');
    });

    test('waits for every Round Table reply', () => {
        expect(reconcilePendingTransition({ wasPending: true, isPending: true, settledStates: ['done', 'pending'] })).toBe('wait');
        expect(settled(['done', 'pending', 'done'])).toBe('wait');
        expect(settled(['done', 'done', 'done'])).toBe('send');
    });

    test('stays idle when nothing was pending', () => {
        expect(reconcilePendingTransition({ wasPending: false, isPending: false, settledStates: ['done'] })).toBe('idle');
        expect(reconcilePendingTransition()).toBe('idle');
    });

    test('holds when the reply was stopped, ahead of a failure', () => {
        expect(settled(['cancelled'])).toBe('hold-stopped');
        expect(settled(['done', 'cancelled', 'failed'])).toBe('hold-stopped');
    });

    test('holds when a reply failed', () => {
        expect(settled(['failed'])).toBe('hold-failed');
        expect(settled(['done', 'failed'])).toBe('hold-failed');
    });

    test('holds when the chat changed', () => {
        expect(settled(['done'], { sameSource: false })).toBe('hold-context');
    });

    test('holds when the panel was closed or another session was open', () => {
        expect(settled(['done'], { visible: false })).toBe('hold-reopened');
        expect(settled(['done'], { visible: false, sameSource: false })).toBe('hold-reopened');
        expect(settled(['failed'], { visible: false })).toBe('hold-failed');
    });
});
