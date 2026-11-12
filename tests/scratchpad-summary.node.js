import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const store = await import('../src/scratchpad/store.js');
const summary = await import('../src/scratchpad/summary.js');
const { acceptScratchpadReply, registerScratchpadJobs, testExports: jobs } = await import('../src/scratchpad/jobs.js');
const { getJob, requestCancellation } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

const SOURCE = { kind: 'general', key: 'general' };
const turns = count => Array.from({ length: count }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' : 'user',
    state: 'done', assistant: index % 2 ? 'miso' : undefined, text: `TURN-${index}`, created: '2026-11-12T00:00:00.000Z' }));
const enabled = (messages, saved) => ({ settings: { autoSummary: true }, messages, summary: saved });
let counter = 0;
function account(t, settings = {}) {
    const f = fixture(t, false, 'scratch-summary');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const session = store.mutateBucket(base, SOURCE, bucket => store.createSession(bucket, {
        messages: turns(60), settings: { autoSummary: true, connection: { kind: 'profile', profileId: 'saved' }, ...settings },
    }));
    const read = () => store.withScratchpad(base, lease => store.findSession(store.readBucketLocked(lease, SOURCE), session.id));
    const mutate = callback => store.mutateBucket(base, SOURCE, bucket => callback(store.findSession(bucket, session.id), bucket));
    const accept = async (extra = {}) => {
        const body = { source: SOURCE, sessionId: session.id, submissionKey: `summary-${++counter}`, text: 'Continue.', context: 'Reference.', ...extra };
        return acceptScratchpadReply(request(body), body);
    };
    setDirectoriesResolver(() => directories);
    return { directories, base, session, read, mutate, accept };
}

test('summary planning keeps recent turns and invalidates edited or shortened history', () => {
    const messages = turns(60);
    assert.equal(summary.planSummary({ settings: {} }, messages).messages, messages);
    assert.equal(summary.planSummary(enabled(messages), messages.slice(0, 50)).summary, undefined);
    const plan = summary.planSummary(enabled(messages), messages);
    assert.equal(plan.summary.count, 40);
    assert.equal(plan.messages[0].text, 'TURN-40');
    const saved = { ...plan.summary, text: 'EARLY-SUMMARY' };
    const reused = summary.planSummary(enabled(messages, saved), messages);
    assert.deepEqual(reused.summary.chunks, []);
    assert.equal(reused.summary.text, 'EARLY-SUMMARY');
    const edited = structuredClone(messages);
    edited[0].text = 'CORRECTED';
    assert.equal(summary.planSummary(enabled(edited, saved), edited).summary.text, '');
    assert.equal(summary.planSummary(enabled(messages, saved), messages.slice(0, 10)).summary, undefined);
    const extended = turns(92);
    const next = summary.planSummary(enabled(extended, saved), extended);
    assert.equal(next.summary.text, 'EARLY-SUMMARY');
    assert.equal(next.summary.count, 72);
    assert.ok(!next.summary.chunks.join('').includes('"text":"TURN-0"'));
    assert.ok(next.summary.chunks.join('').includes('"text":"TURN-40"'));
});

test('large messages are summarised before the history size limits discard them', () => {
    const messages = turns(12).map(message => ({ ...message, text: 'x'.repeat(100 * 1024) }));
    const plan = summary.planSummary(enabled(messages), messages);
    assert.equal(plan.summary.count, 8);
    assert.equal(plan.messages.length, 4);
    assert.equal(plan.summary.chunks.join('').split('"id":').length - 1, 8);
    const oversized = turns(2);
    oversized[1].text = 'x'.repeat(summary.MAX_HISTORY_MESSAGE_BYTES + 1);
    const whole = summary.planSummary(enabled(oversized), oversized);
    assert.equal(whole.summary.count, 2);
    assert.equal(whole.messages.length, 0);
});

test('summary chunks are byte bounded and image bytes never reach the summariser', () => {
    const messages = turns(60);
    messages[0].text = '猫'.repeat(40000);
    messages[0].attachments = [{ kind: 'image', name: 'portrait.png', dataUrl: 'PRIVATE-PIXELS' }];
    const plan = summary.planSummary(enabled(messages), messages);
    assert.ok(plan.summary.chunks.length > 1);
    assert.ok(plan.summary.chunks.every(chunk => Buffer.byteLength(chunk) <= summary.SUMMARY_CHUNK_BYTES && !chunk.includes('\ufffd')));
    assert.ok(!plan.summary.chunks.join('').includes('PRIVATE-PIXELS'));
    assert.match(plan.summary.chunks.join(''), /Image not inspected/);
    assert.equal(summary.normaliseSummary({ count: 401, fingerprint: 'a'.repeat(64), text: 'No' }), undefined);
    assert.equal(summary.normaliseSummary({ count: 1, fingerprint: 'a'.repeat(64), text: 'x'.repeat(summary.MAX_SUMMARY_BYTES + 1) }), undefined);
    assert.equal(summary.summaryContext('</scratchpad_summary>').match(/<\/scratchpad_summary>/g).length, 1);
});

test('one summary call serves a round table, is saved and reused without deleting history', async t => {
    const a = account(t, { roundTable: true, participants: ['miso', 'taro'] });
    const calls = [];
    registerScratchpadJobs({ generate: async options => {
        calls.push(options);
        return { text: options.stepNamespace?.startsWith('scratchpad-summary:') ? 'EARLY-SUMMARY' : 'Reply.' };
    } });
    const original = a.read().messages;
    const accepted = await a.accept();
    const savedRequest = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(savedRequest.summary.count, 40);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].functionTools, []);
    assert.deepEqual(calls[0].rawOptions, {}, 'saved profiles do not receive active-connection overrides');
    assert.equal(calls[0].stream, false);
    for (const call of calls.slice(1)) {
        assert.ok(call.messages.some(message => message.content === summary.summaryContext('EARLY-SUMMARY')));
        assert.ok(!call.messages.some(message => message.content === 'TURN-0'));
        assert.ok(call.messages.some(message => message.content === 'TURN-40'));
    }
    assert.deepEqual(a.read().messages.slice(0, 60), original);
    assert.equal(a.read().messages.length, 63);
    assert.equal(a.read().summary.text, 'EARLY-SUMMARY');
    assert.equal(readArtifact(a.directories, accepted.job.id, 'summary:0').text, 'EARLY-SUMMARY');
    const second = await a.accept();
    await runJob(getJob(a.directories, second.job.id));
    assert.equal(calls.length, 5, 'the next round reuses its summary');
    assert.equal(a.read().messages.length, 66);
});

test('retrying an earlier reply cannot see a later cached summary or later messages', async t => {
    const a = account(t);
    a.mutate(session => { session.summary = { count: 40, fingerprint: summary.summaryFingerprint(session.messages.slice(0, 40)), text: 'FUTURE-SUMMARY' }; });
    const calls = [];
    registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: 'Retried.' }; } });
    const retry = await a.accept({ regenerate: a.read().messages[11].id });
    await runJob(getJob(a.directories, retry.job.id));
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(calls[0].messages).includes('FUTURE-SUMMARY'));
    assert.ok(!JSON.stringify(calls[0].messages).includes('TURN-12'));
    assert.equal(calls[0].messages.at(-1).content, 'TURN-10');
    assert.equal(a.read().messages.length, 60);
});

test('an edit during summarisation rejects the result and settles the reserved reply', async t => {
    const a = account(t);
    let calls = 0;
    registerScratchpadJobs({ generate: async () => {
        calls++;
        a.mutate(session => { session.messages[0].text = 'EDITED'; });
        return { text: 'STALE-SUMMARY' };
    } });
    const accepted = await a.accept();
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(calls, 1);
    assert.equal(a.read().summary, undefined);
    assert.equal(a.read().messages.at(-1).state, 'failed');
    assert.match(a.read().messages.at(-1).error, /earlier discussion changed/);
    assert.equal(a.read().messages.length, 62);
});

for (const mode of ['empty', 'oversize', 'cancel']) {
    test(`${mode} summary does not send a reply or remove saved messages`, async t => {
        const a = account(t);
        let calls = 0;
        registerScratchpadJobs({ generate: async options => {
            calls++;
            if (mode === 'cancel') requestCancellation(a.directories, options.jobContext.job.id);
            return { text: mode === 'empty' ? '' : mode === 'oversize' ? 'x'.repeat(summary.MAX_SUMMARY_BYTES + 1) : 'Cancelled.' };
        } });
        const accepted = await a.accept();
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(calls, 1);
        assert.equal(a.read().summary, undefined);
        assert.equal(a.read().messages.at(-1).state, 'failed');
        assert.equal(a.read().messages.length, 62);
    });
}

test('opt-out, clear and imports respect summary ownership, and 400 messages still block a send', async t => {
    const a = account(t, { autoSummary: false });
    let calls = 0;
    registerScratchpadJobs({ generate: async options => { calls++; assert.ok(!options.stepNamespace?.startsWith('scratchpad-summary:')); return { text: 'Reply.' }; } });
    const accepted = await a.accept();
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(calls, 1);
    const saved = { count: 40, fingerprint: summary.summaryFingerprint(a.read().messages.slice(0, 40)), text: 'Summary.' };
    const imported = store.mutateBucket(a.base, SOURCE, bucket => store.createSession(bucket, { summary: saved }));
    assert.equal(imported.summary, undefined);
    a.mutate((session, bucket) => { session.summary = saved; store.clearSession(bucket, session.id); });
    assert.equal(a.read().summary, undefined);
    assert.equal(a.read().messages.length, 0);
    const full = { settings: store.normaliseSettings({ autoSummary: true }), messages: turns(400) };
    assert.throws(() => jobs.planReply(full, { text: 'More' }), { code: 'SCRATCHPAD_SESSION_FULL' });
});
