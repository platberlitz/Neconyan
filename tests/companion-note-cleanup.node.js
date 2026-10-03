import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAutomaticCompanionNoteCleanup } from '../src/generation/companion-note-cleanup.js';

const note = content => ({ status: 'done', content });
const message = results => ({ extra: { inChatAgentCompanionResults: results } });

test('native cleanup is opt-in and preserves older notes after unsuccessful or suppressed runs', () => {
    for (const [policy, result] of [[undefined, note('new')], [{ enabled: false }, note('new')],
        [{ enabled: true }, { ...note('retained'), lastRunError: 'Failed' }],
        [{ enabled: true }, note('')], [{ enabled: true }, note('tracker-none')]]) {
        const messages = [message({ side: note('old') }), message({ side: result })];
        const before = structuredClone(messages);
        applyAutomaticCompanionNoteCleanup(messages, policy, { side: result }, 1);
        assert.deepEqual(messages, before);
    }
});

test('native cleanup counts readable messages, removes inactive copies and protects pending runs', () => {
    const messages = [message({ side: note('old'), other: note('other') }), message({ side: note('running copy') }),
        message({ side: note('older retained') }), message({ side: note('new') })];
    messages[0].swipe_info = [{ extra: { inChatAgentCompanionResults: { side: note('inactive') } } }];
    messages[1].swipe_info = [{ extra: { inChatAgentCompanionResults: { side: { status: 'pending' } } } }];
    applyAutomaticCompanionNoteCleanup(messages, { enabled: true, olderNotesToKeep: 1 }, { side: note('new') }, 3);
    assert.equal(messages[0].extra.inChatAgentCompanionResults.side, undefined);
    assert.equal(messages[0].swipe_info[0].extra.inChatAgentCompanionResults.side, undefined);
    assert.equal(messages[0].extra.inChatAgentCompanionResults.other.content, 'other');
    assert.equal(messages[1].extra.inChatAgentCompanionResults.side.content, 'running copy');
    assert.equal(messages[2].extra.inChatAgentCompanionResults.side.content, 'older retained');
    assert.equal(messages[3].extra.inChatAgentCompanionResults.side.content, 'new');
});

test('native cleanup preserves a historical rerun and the latest readable note', () => {
    const messages = [message({ side: note('rerun') }), message({ side: note('middle') }), message({ side: note('latest') })];
    applyAutomaticCompanionNoteCleanup(messages, { enabled: true, olderNotesToKeep: 0 }, { side: note('rerun') }, 0);
    assert.equal(messages[0].extra.inChatAgentCompanionResults.side.content, 'rerun');
    assert.equal(messages[1].extra.inChatAgentCompanionResults.side, undefined);
    assert.equal(messages[2].extra.inChatAgentCompanionResults.side.content, 'latest');
});
