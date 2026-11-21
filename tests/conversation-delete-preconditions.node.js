// Facts the Conversation DM delete relies on, checked against modules that exist before the delete route does (green on the base by design).
import assert from 'node:assert/strict';
import test from 'node:test';
import { A, B, KEY, checkKeptScheduleRecord, openReplyJob, seedA0, writeKeptRecord } from './conversation-delete-helpers.js';

const { readConversationStoreForWrite, saveConversationStore, readUserSettingsWithStatus } = await import('../src/endpoints/conversation-store.js');
const { normalizeConversationGroupRecord } = await import('../src/endpoints/conversation-groups.js');
const { normalizeConversationSettings } = await import('../src/endpoints/conversation-generation.js');
const { getSettingsVersion } = await import('../src/settings-version.js');

test('a kept schedule-only record is selectable by nothing and still answers the schedule (A0 items 0, 3, 4, 5)', async t => {
    const readings = await checkKeptScheduleRecord(t, writeKeptRecord);
    t.diagnostic(`A0 readings: ${JSON.stringify(readings)}`);
    assert.deepEqual(readings.control, [KEY(A)]);
    assert.equal(readings.item3.status, 409);
});

test('a thread removed by a plain save is refused to a reply job that was not cancelled (in-flight case i)', async t => {
    const seed = seedA0(t);
    const job = await openReplyJob(seed);
    const version = getSettingsVersion(readUserSettingsWithStatus(seed.request).data);
    const context = readConversationStoreForWrite(seed.request, version, group => normalizeConversationGroupRecord(group, normalizeConversationSettings));
    assert.equal(context.ok, true);
    delete context.store.characters[A];
    const saved = await saveConversationStore(seed.request, context.store, version);
    assert.equal(saved.ok, true, JSON.stringify(saved.body ?? null));
    const refusal = await job.append();
    assert.ok(refusal, 'the late append must be refused');
    assert.equal(refusal.status, 409);
    assert.match(refusal.message, /no longer exists/);
    const store = seed.disk();
    assert.equal(Object.hasOwn(store.characters, A), false);
    assert.equal(Object.hasOwn(store.characters, B), true);
});
