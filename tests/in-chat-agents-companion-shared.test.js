import { describe, test, expect } from '@jest/globals';
import {
    COMPANION_FAILURE_MESSAGES,
    COMPANION_RESULTS_EXTRA_KEY,
    classifyCompanionFailureMessage,
    getCompanionResultFailure,
    getCompanionResultStores,
    isRetryableCompanionFailure,
    planCompanionNoteCleanup,
} from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

function note(content, extra = {}) {
    return { status: 'done', content, agentName: extra.agentName ?? 'Scene', ...extra };
}

function reply(results, { swipes = null, swipeId = 0 } = {}) {
    const message = { is_user: false, mes: 'reply', extra: { [COMPANION_RESULTS_EXTRA_KEY]: results } };
    if (swipes) {
        message.swipe_id = swipeId;
        message.swipes = swipes.map((_, index) => `swipe ${index}`);
        message.swipe_info = swipes.map(swipeResults => ({ extra: { [COMPANION_RESULTS_EXTRA_KEY]: swipeResults } }));
    }
    return message;
}

function targetsOf(plan) {
    return plan.targets.map(target => [target.messageIndex, [...target.agentIds].sort()]);
}

describe('companion failure kinds', () => {
    test('the fixed failure messages name their own kind', () => {
        for (const [kind, message] of Object.entries(COMPANION_FAILURE_MESSAGES)) {
            expect(classifyCompanionFailureMessage(message)).toBe(kind);
            expect(classifyCompanionFailureMessage(`  ${message}  `)).toBe(kind);
        }
        expect(classifyCompanionFailureMessage('The reply reached its output limit.')).toBe('limit');
        expect(classifyCompanionFailureMessage('A required companion did not complete.')).toBe('dependency');
        expect(classifyCompanionFailureMessage('Companion dependencies form a cycle.')).toBe('cycle');
        expect(classifyCompanionFailureMessage('constructor')).toBe('');
        expect(classifyCompanionFailureMessage('Rate limit exceeded')).toBe('');
        expect(classifyCompanionFailureMessage(null)).toBe('');
    });

    test('a failed run without a note reports its stored kind first', () => {
        expect(getCompanionResultFailure({ status: 'error', error: 'Bad gateway', failureKind: 'api' }))
            .toEqual({ kind: 'api', message: 'Bad gateway', keptNote: false });
        expect(getCompanionResultFailure({ status: 'error', error: COMPANION_FAILURE_MESSAGES.empty, failureKind: 'limit' }).kind)
            .toBe('limit');
        expect(getCompanionResultFailure({ status: 'cancelled', error: '' }))
            .toEqual({ kind: 'cancelled', message: 'Cancelled.', keptNote: false });
    });

    test('failures saved before kinds existed are classified from their message', () => {
        expect(getCompanionResultFailure({ status: 'error', error: COMPANION_FAILURE_MESSAGES.empty }).kind).toBe('empty');
        expect(getCompanionResultFailure({ status: 'cancelled', error: COMPANION_FAILURE_MESSAGES.interrupted }).kind).toBe('interrupted');
        expect(getCompanionResultFailure({ status: 'error', error: '429 Too Many Requests' }).kind).toBe('api');
        expect(getCompanionResultFailure({ status: 'error', error: 'Odd value', failureKind: 'nonsense' }).kind).toBe('api');
    });

    test('a failed rerun that kept an older note is reported as such', () => {
        expect(getCompanionResultFailure(note('Old', { lastRunError: 'Server error', lastRunFailureKind: 'api' })))
            .toEqual({ kind: 'api', message: 'Server error', keptNote: true });
        expect(getCompanionResultFailure(note('Old', { lastRunError: COMPANION_FAILURE_MESSAGES.cancelled })).kind).toBe('cancelled');
        expect(getCompanionResultFailure(note('Old', { lastRunError: 'Timed out' })).kind).toBe('api');
    });

    test('healthy, running and missing results are not failures', () => {
        expect(getCompanionResultFailure(note('Fine'))).toBeNull();
        expect(getCompanionResultFailure({ status: 'pending', content: '' })).toBeNull();
        expect(getCompanionResultFailure(undefined)).toBeNull();
        expect(getCompanionResultFailure('error')).toBeNull();
    });

    test('only failures another attempt can fix are retryable', () => {
        const retryable = [
            { status: 'error', error: 'Bad gateway', failureKind: 'api' },
            { status: 'error', error: COMPANION_FAILURE_MESSAGES.empty },
            { status: 'cancelled', error: COMPANION_FAILURE_MESSAGES.interrupted },
            { status: 'error', error: COMPANION_FAILURE_MESSAGES.dependency },
            note('Old', { lastRunError: 'Connection reset' }),
        ];
        const notRetryable = [
            { status: 'cancelled', error: COMPANION_FAILURE_MESSAGES.cancelled },
            { status: 'error', error: COMPANION_FAILURE_MESSAGES.limit },
            { status: 'error', error: COMPANION_FAILURE_MESSAGES.cycle },
            { status: 'error', error: COMPANION_FAILURE_MESSAGES.invalid },
            { status: 'error', error: 'Something odd', failureKind: 'other' },
            note('Fine'),
        ];

        expect(retryable.map(isRetryableCompanionFailure)).toEqual(retryable.map(() => true));
        expect(notRetryable.map(isRetryableCompanionFailure)).toEqual(notRetryable.map(() => false));
    });
});

describe('companion result stores', () => {
    test('lists the message copy and every swipe copy once', () => {
        const shared = { scene: note('Shared') };
        const message = reply(shared, { swipes: [{ scene: note('Swipe 0') }, { scene: note('Swipe 1') }] });
        message.swipe_info[0].extra[COMPANION_RESULTS_EXTRA_KEY] = shared;

        const stores = getCompanionResultStores(message);
        expect(stores).toHaveLength(2);
        expect(stores[0]).toBe(shared);
        expect(stores[1].scene.content).toBe('Swipe 1');
    });

    test('ignores user swipes and malformed stores', () => {
        const userMessage = { is_user: true, extra: {}, swipe_info: [{ extra: { [COMPANION_RESULTS_EXTRA_KEY]: { scene: note('x') } } }] };
        expect(getCompanionResultStores(userMessage)).toEqual([]);
        expect(getCompanionResultStores({ extra: { [COMPANION_RESULTS_EXTRA_KEY]: ['bad'] } })).toEqual([]);
        expect(getCompanionResultStores(null)).toEqual([]);
    });
});

describe('planning a companion note clean-up', () => {
    test('keeps each companion\'s newest note and removes older ones', () => {
        const messages = [
            reply({ scene: note('Scene 0'), mood: note('Mood 0', { agentName: 'Mood' }) }),
            { is_user: true, mes: 'hello', extra: {} },
            reply({ scene: note('Scene 2'), mood: note('Mood 2', { agentName: 'Mood' }) }),
            reply({ scene: note('Scene 3') }),
        ];

        const plan = planCompanionNoteCleanup(messages);
        expect(targetsOf(plan)).toEqual([[0, ['mood', 'scene']], [2, ['scene']]]);
        expect(plan.total).toBe(3);
        expect(plan.counts.get('scene')).toBe(2);
        expect(plan.counts.get('mood')).toBe(1);
        expect(plan.names.get('mood')).toBe('Mood');
    });

    test('a failed or empty latest result does not count as the note to keep', () => {
        const messages = [
            reply({ scene: note('Scene 0') }),
            reply({ scene: note('Scene 1') }),
            reply({ scene: { status: 'error', content: '', error: 'Bad gateway', agentName: 'Scene' } }),
            reply({ scene: note('tracker-none') }),
        ];

        const plan = planCompanionNoteCleanup(messages);
        expect(targetsOf(plan)).toEqual([[0, ['scene']]]);
    });

    test('keeps the configured older readable notes per companion, counting messages rather than swipes', () => {
        const messages = [
            reply({ scene: note('Scene 0'), mood: note('Mood 0') }),
            reply({ scene: note('Scene 1') }, { swipes: [{ scene: note('Scene 1') }, { scene: note('Alternative') }] }),
            reply({ scene: note('tracker-none'), mood: note('Mood 2') }),
            reply({ scene: note('Scene 3') }),
            reply({ scene: note('Scene 4'), mood: note('Mood 4') }),
        ];
        expect(targetsOf(planCompanionNoteCleanup(messages, { olderNotesToKeep: 1 }))).toEqual([[0, ['mood', 'scene']], [1, ['scene']], [2, ['scene']]]);
        expect(planCompanionNoteCleanup(messages, { olderNotesToKeep: 10 }).total).toBe(0);
        expect(targetsOf(planCompanionNoteCleanup(messages, { olderNotesToKeep: 1, protectedMessageIndex: 1 }))).toEqual([[0, ['mood', 'scene']], [2, ['scene']]]);
    });

    test('retention never deletes a running result on an inactive swipe', () => {
        const messages = [
            reply({ scene: note('Old') }, { swipes: [{ scene: note('Old') }, { scene: { status: 'pending', content: '' } }] }),
            reply({ scene: note('New') }),
        ];
        expect(planCompanionNoteCleanup(messages, { olderNotesToKeep: 0 }).total).toBe(0);
    });

    test('a companion without any readable note keeps everything', () => {
        const messages = [
            reply({ tracker: { status: 'error', content: '', error: 'Bad gateway' } }),
            reply({ tracker: note('tracker-none') }),
        ];

        expect(planCompanionNoteCleanup(messages).total).toBe(0);
        expect(planCompanionNoteCleanup(messages, { keepLatest: false }).total).toBe(2);
    });

    test('only the chosen companions are planned', () => {
        const messages = [
            reply({ scene: note('Scene 0'), mood: note('Mood 0') }),
            reply({ scene: note('Scene 1'), mood: note('Mood 1') }),
        ];

        expect(targetsOf(planCompanionNoteCleanup(messages, { agentIds: ['mood'] }))).toEqual([[0, ['mood']]]);
        expect(targetsOf(planCompanionNoteCleanup(messages, { agentIds: new Set(['scene']), keepLatest: false })))
            .toEqual([[0, ['scene']], [1, ['scene']]]);
        expect(planCompanionNoteCleanup(messages, { agentIds: [] }).total).toBe(0);
    });

    test('a companion still running on a message is left alone there', () => {
        const messages = [
            reply({ scene: note('Scene 0') }),
            reply({ scene: { status: 'pending', content: '', previousResult: note('Scene 1') } }),
        ];

        expect(targetsOf(planCompanionNoteCleanup(messages, { keepLatest: false }))).toEqual([[0, ['scene']]]);
    });

    test('notes kept on other swipes count once per message and anchor on the visible swipe', () => {
        const messages = [
            reply({ scene: note('Scene 0') }, { swipes: [{ scene: note('Scene 0') }, { scene: note('Scene 0 alt') }] }),
            reply({ mood: note('Mood 1') }, { swipes: [{ mood: note('Mood 1') }, { scene: note('Scene on hidden swipe') }] }),
        ];

        const keepLatest = planCompanionNoteCleanup(messages);
        expect(keepLatest.total).toBe(0);

        const everything = planCompanionNoteCleanup(messages, { keepLatest: false });
        expect(targetsOf(everything)).toEqual([[0, ['scene']], [1, ['mood', 'scene']]]);
        expect(everything.counts.get('scene')).toBe(2);
    });
});
