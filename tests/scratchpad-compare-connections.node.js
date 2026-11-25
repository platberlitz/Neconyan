import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const store = await import('../src/scratchpad/store.js');
const jobs = await import('../src/scratchpad/jobs.js');
const { acceptScratchpadReply, registerScratchpadJobs, connectionDisplayLabel, effectiveConnection, sameConnectionTarget } = jobs;
const { buildScratchpadMessages } = await import('../src/scratchpad/prompt.js');
const { contextSetupSettings, CONTEXT_SETUP_KEYS } = await import('../src/scratchpad/context-setups.js');
const { getJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { roundToDiscuss } = await import('../public/scripts/scratchpad/discuss.js');
const { replySwipes } = await import('../public/scripts/scratchpad/swipes.js');
const { portableSettings } = await import('../public/scripts/scratchpad/portable-settings.js');
const compare = await import('../public/scripts/scratchpad/compare.js');
after(() => cancelAutoSaves());

const SECRET_URL = 'https://alpha-private.invalid/v1';
const ALPHA = { kind: 'profile', profileId: 'alpha' };
const BETA = { kind: 'profile', profileId: 'beta' };
let counter = 0;

function account(t, { kind = 'roleplay', settings = {} } = {}) {
    const f = fixture(t, false, 'scratch-compare');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [
            { id: 'alpha', name: 'Alpha', api: 'openai', model: 'gpt-4o', 'api-url': SECRET_URL },
            { id: 'beta', name: 'Beta', api: 'openai', model: 'gpt-4o-mini' },
        ] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const source = { kind, key: kind === 'roleplay' ? 'character:Nova.png:Source' : 'conversation:test' };
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const session = store.mutateBucket(base, source, bucket => store.createSession(bucket, {
        settings: { connection: ALPHA, compareConnection: BETA, ...settings },
    }));
    const read = () => store.withScratchpad(base, lease => store.findSession(store.readBucketLocked(lease, source), session.id));
    const bucket = () => store.withScratchpad(base, lease => store.readBucketLocked(lease, source));
    const mutate = fn => store.mutateBucket(base, source, fn);
    const accept = extra => {
        const body = { source, sessionId: session.id, submissionKey: `compare-${++counter}`, text: 'Which ending works?',
            context: 'SHARED-STORY: Nova waits by the ferry.', names: { user: 'Me', character: 'Nova' }, ...extra };
        return acceptScratchpadReply(request(body), body);
    };
    setDirectoriesResolver(() => directories);
    return { directories, source, session, read, bucket, mutate, accept };
}

function recordingGenerator(calls) {
    registerScratchpadJobs({ generate: async options => {
        calls.push(options);
        return { text: `Answer from ${options.binding.profileId === 'alpha' ? 'Alpha' : 'Beta'}` };
    } });
}

test('a compared send runs one assistant on both connections in one durable job', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept();
    assert.match(accepted.job.label, /^Scratchpad compare from .+ \(Alpha vs Beta\)$/);
    const pending = a.read().messages;
    assert.equal(pending.length, 3);
    const [user, first, second] = pending;
    assert.equal(user.role, 'user');
    assert.deepEqual([first.state, second.state], ['pending', 'pending']);
    assert.equal(first.assistant, second.assistant);
    assert.equal(first.jobId, second.jobId);
    assert.deepEqual([first.compareGroup, second.compareGroup], [user.id, user.id]);
    assert.deepEqual([first.connectionLabel, second.connectionLabel], ['Alpha', 'Beta']);
    assert.deepEqual([first.connection, second.connection], [ALPHA, BETA]);
    const prepared = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(prepared.replies.length, 2);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.binding.profileId).sort(), ['alpha', 'beta']);
    assert.equal(calls[0].messages[0].content, calls[1].messages[0].content, 'both connections get the same system prompt');
    const done = a.read().messages;
    assert.deepEqual(done.slice(1).map(message => [message.state, message.text]), [['done', 'Answer from Alpha'], ['done', 'Answer from Beta']]);
    const visible = JSON.stringify(store.publicBucket(a.bucket()));
    assert.ok(!visible.includes(SECRET_URL), 'the public bucket never carries the profile URL');
    assert.ok(!visible.includes('api-url'));
    for (const message of done.slice(1)) assert.ok(!message.connectionLabel.includes('http'));
});

test('the compared system prompt is byte-identical to an ordinary single reply', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const compared = await a.accept({ submissionKey: 'same-key-a' });
    await runJob(getJob(a.directories, compared.job.id));
    const plain = account(t, { settings: { compareConnection: null } });
    const single = await plain.accept({ submissionKey: 'same-key-b' });
    await runJob(getJob(plain.directories, single.job.id));
    assert.equal(calls.length, 3);
    assert.equal(plain.read().messages.length, 2);
    assert.equal(plain.read().messages[1].compareGroup, undefined);
    assert.equal(plain.read().messages[1].connectionLabel, undefined);
    assert.equal(calls[0].messages[0].content, calls[2].messages[0].content);
    assert.equal(single.job.label.startsWith('Scratchpad reply from '), true);
});

test('two choices that reach the same connection are refused before anything is saved', async t => {
    const a = account(t, { settings: { compareConnection: ALPHA } });
    await assert.rejects(a.accept(), error => error.code === 'SCRATCHPAD_COMPARE_SAME_CONNECTION' && error.status === 400
        && error.message === 'Choose two different connections to compare.');
    assert.equal(a.read().messages.length, 0);
    const current = { settings: store.normaliseSettings({ connection: { kind: 'current' }, compareConnection: { kind: 'current' } }), messages: [] };
    assert.throws(() => jobs.testExports.planReply(current, { text: 'Hi' }), error => error.code === 'SCRATCHPAD_COMPARE_SAME_CONNECTION');
    const chat = { settings: store.normaliseSettings({ connection: { kind: 'current' }, compareConnection: BETA }), messages: [] };
    assert.throws(() => jobs.testExports.planReply(chat, { text: 'Hi', chatProfileId: 'beta' }), error => error.code === 'SCRATCHPAD_COMPARE_SAME_CONNECTION');
    assert.equal(jobs.testExports.planReply(chat, { text: 'Hi', chatProfileId: 'alpha' }).compareConnection.profileId, 'beta');
});

test('Conversation compares the chat connection with a saved profile and names it', async t => {
    const a = account(t, { kind: 'conversation', settings: { connection: { kind: 'current' }, compareConnection: ALPHA } });
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept({ chatProfileId: 'beta' });
    const labels = a.read().messages.slice(1).map(message => message.connectionLabel);
    assert.deepEqual(labels, ['Chat connection (Beta)', 'Alpha']);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.deepEqual(calls.map(call => call.binding.profileId).sort(), ['alpha', 'beta']);
});

test('Round table ignores the compare setting', async t => {
    const a = account(t, { settings: { roundTable: true, participants: ['miso', 'taro'] } });
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept();
    await runJob(getJob(a.directories, accepted.job.id));
    const replies = a.read().messages.slice(1);
    assert.equal(replies.length, 2);
    assert.notEqual(replies[0].assistant, replies[1].assistant);
    assert.ok(replies.every(reply => reply.compareGroup === undefined && reply.connectionLabel === undefined));
    assert.match(accepted.job.label, /^Scratchpad round table from /);
});

test('Try again on a compared reply keeps that reply on its own connection', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept();
    await runJob(getJob(a.directories, accepted.job.id));
    const beta = a.read().messages[2];
    calls.length = 0;
    const retry = await a.accept({ regenerate: beta.id, text: '' });
    await runJob(getJob(a.directories, retry.job.id));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binding.profileId, 'beta');
    const messages = a.read().messages;
    assert.equal(messages.length, 3);
    const retried = messages[2];
    assert.equal(retried.connectionLabel, 'Beta');
    assert.equal(retried.compareGroup, messages[0].id);
    assert.equal(retried.text, 'Answer from Beta');
    assert.equal(replySwipes(retried).length, 2);
    assert.ok(replySwipes(retried).every(item => item.connectionLabel === 'Beta'));
    assert.equal(messages[1].text, 'Answer from Alpha', 'the Alpha reply is untouched');
});

test('follow-ups see both compared replies as one turn, then only the kept one', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const first = await a.accept();
    await runJob(getJob(a.directories, first.job.id));
    calls.length = 0;
    const follow = await a.accept({ text: 'Tell me more.' });
    await runJob(getJob(a.directories, follow.job.id));
    const prompt = calls[0].messages;
    for (let index = 1; index < prompt.length; index++) {
        assert.ok(!(prompt[index].role === 'assistant' && prompt[index - 1].role === 'assistant' && index > 2), 'no two assistant turns in a row');
    }
    const merged = prompt.find(message => String(message.content).includes('[Reply via Alpha]'));
    assert.ok(merged, 'the earlier pair is in the history');
    assert.equal(merged.role, 'assistant');
    assert.match(merged.content, /\[Reply via Alpha\]\n(?:.*\n)?Answer from Alpha\n\n---\n\n\[Reply via Beta\]\n(?:.*\n)?Answer from Beta/);

    const kept = a.read().messages[1];
    a.mutate(bucket => store.keepComparedReply(bucket, a.session.id, kept.id));
    const after = a.read().messages;
    assert.ok(!after.some(message => message.text === 'Answer from Beta' && message.compareGroup === kept.compareGroup));
    assert.equal(after.filter(message => message.compareGroup === kept.compareGroup).length, 1);
    const keptFollow = a.read().messages.at(-2);
    a.mutate(bucket => store.keepComparedReply(bucket, a.session.id, keptFollow.id));
    calls.length = 0;
    a.mutate(bucket => store.updateSession(bucket, a.session.id, { settings: { compareConnection: null } }));
    const later = await a.accept({ text: 'One more.' });
    await runJob(getJob(a.directories, later.job.id));
    assert.ok(calls[0].messages.every(message => !String(message.content).includes('[Reply via')));
    assert.ok(calls[0].messages.some(message => String(message.content).includes('Answer from Alpha')));
});

test('a lone compared reply builds the same messages as an ordinary reply', () => {
    const history = [
        { id: 'u1', role: 'user', text: 'Hi' },
        { id: 'r1', role: 'assistant', text: 'Hello', assistant: 'miso', assistantName: 'Miso' },
    ];
    const options = { system: 'System', context: 'Story', history, text: 'Next', userMessageId: 'u2', assistant: 'miso', assistantNames: { miso: 'Miso' } };
    const plain = buildScratchpadMessages(options);
    const marked = buildScratchpadMessages({ ...options, history: [history[0], { ...history[1], compareGroup: 'u1', connectionLabel: 'Alpha' }] });
    assert.deepEqual(marked, plain);
    const pair = buildScratchpadMessages({ ...options, history: [history[0],
        { ...history[1], compareGroup: 'u1', connectionLabel: 'Alpha' },
        { ...history[1], id: 'r2', text: 'Hey', compareGroup: 'u1', connectionLabel: 'Beta' }] });
    assert.equal(pair.length, plain.length);
    assert.equal(pair.filter(message => message.role === 'assistant').length, plain.filter(message => message.role === 'assistant').length);
});

test('Discuss these answers stays hidden for a same-assistant pair', () => {
    const session = { assistant: 'miso', settings: { ...store.defaultSettings(), roundTable: true, randomReply: false, participants: ['miso', 'taro'] }, messages: [
        { id: 'u1', role: 'user', text: 'Hi' },
        { id: 'r1', role: 'assistant', state: 'done', text: 'A', assistant: 'miso', compareGroup: 'u1' },
        { id: 'r2', role: 'assistant', state: 'done', text: 'B', assistant: 'miso', compareGroup: 'u1' },
    ] };
    assert.deepEqual(roundToDiscuss(session), []);
});

test('rehearsals stay a single reply on the main connection', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept({ rehearsal: true, text: '' });
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binding.profileId, 'alpha');
    assert.equal(a.read().messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(a.read().messages[1].compareGroup, undefined);
});

test('the capacity guard counts both compared replies', () => {
    const messages = Array.from({ length: store.MAX_MESSAGES - 2 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: 'x', state: 'done' }));
    const settings = store.normaliseSettings({ connection: ALPHA, compareConnection: BETA });
    assert.throws(() => jobs.testExports.planReply({ settings, messages }, { text: 'Hi' }), error => error.code === 'SCRATCHPAD_SESSION_FULL');
    const single = store.normaliseSettings({ connection: ALPHA });
    assert.doesNotThrow(() => jobs.testExports.planReply({ settings: single, messages }, { text: 'Hi' }));
});

test('settings, messages and saved setups normalise the compare fields', () => {
    assert.equal(store.defaultSettings().compareConnection, null);
    assert.equal(store.normaliseSettings({}).compareConnection, null);
    for (const off of [null, '', { kind: 'none' }]) assert.equal(store.normaliseSettings({ compareConnection: off }).compareConnection, null);
    assert.deepEqual(store.normaliseSettings({ compareConnection: { kind: 'current' } }).compareConnection, { kind: 'current' });
    assert.deepEqual(store.normaliseSettings({ compareConnection: BETA }).compareConnection, BETA);
    assert.deepEqual(store.normaliseSettings({ compareConnection: { kind: 'profile', profileId: '' } }).compareConnection, { kind: 'current' });
    assert.deepEqual(store.normaliseSettings({ depth: 2 }, store.normaliseSettings({ compareConnection: BETA })).compareConnection, BETA, 'a patch keeps the saved choice');
    const message = store.testExports.normaliseMessage({ id: 'r1', role: 'assistant', text: 'A', compareGroup: 'u1', connection: BETA, connectionLabel: ` ${'B'.repeat(300)} ` }, { allowInternalKeys: true });
    assert.equal(message.compareGroup, 'u1');
    assert.deepEqual(message.connection, BETA);
    assert.equal(message.connectionLabel.length, 200);
    const plain = store.testExports.normaliseMessage({ id: 'r2', role: 'assistant', text: 'A', compareGroup: 'bad id!' }, { allowInternalKeys: true });
    assert.equal(plain.compareGroup, undefined);
    const untrusted = store.testExports.normaliseMessage({ id: 'r3', role: 'assistant', text: 'A', compareGroup: 'u1', connection: BETA, connectionLabel: 'Forged' });
    assert.equal(untrusted.compareGroup, undefined);
    assert.equal(untrusted.connection, undefined);
    assert.equal(untrusted.connectionLabel, undefined);
    assert.ok(CONTEXT_SETUP_KEYS.includes('compareConnection'));
    assert.equal(contextSetupSettings({ depth: 3 }).compareConnection, null, 'older saved setups keep compare off');
    assert.deepEqual(contextSetupSettings({ compareConnection: BETA }).compareConnection, BETA);
});

test('untrusted imports strip compare metadata while local branches keep it', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept();
    await runJob(getJob(a.directories, accepted.job.id));
    const replies = a.read().messages.filter(message => message.role === 'assistant');
    assert.equal(replies.length, 2);

    const originalSettings = a.read().settings;
    const imported = a.mutate(bucket => store.createSession(bucket, {
        name: 'Imported',
        settings: portableSettings(originalSettings),
        messages: [
            { role: 'user', text: 'Question' },
            {
                role: 'assistant',
                text: 'Answer',
                compareGroup: 'u1',
                connection: BETA,
                connectionLabel: 'Forged profile',
                swipeIndex: 0,
                swipes: [
                    null,
                    { role: 'assistant', text: 'Alt', compareGroup: 'u1', connection: ALPHA, connectionLabel: 'Forged swipe' },
                ],
            },
        ],
    }, { inheritSettings: false }));
    const importedReply = imported.messages[1];
    assert.equal(imported.settings.compareConnection, null);
    assert.equal(importedReply.compareGroup, undefined);
    assert.equal(importedReply.connection, undefined);
    assert.equal(importedReply.connectionLabel, undefined);
    assert.equal(importedReply.swipes[1].compareGroup, undefined);
    assert.equal(importedReply.swipes[1].connection, undefined);
    assert.equal(importedReply.swipes[1].connectionLabel, undefined);

    const branched = a.mutate(bucket => store.branchSession(bucket, a.session.id, replies[1].id));
    const branchedReplies = branched.session.messages.filter(message => message.role === 'assistant');
    assert.equal(branchedReplies.length, 2);
    assert.equal(branchedReplies[0].compareGroup, replies[0].compareGroup);
    assert.equal(branchedReplies[1].compareGroup, replies[1].compareGroup);
    assert.deepEqual(branchedReplies[0].connection, ALPHA);
    assert.deepEqual(branchedReplies[1].connection, BETA);
    assert.equal(branchedReplies[0].connectionLabel, 'Alpha');
    assert.equal(branchedReplies[1].connectionLabel, 'Beta');
});

test('Keep only this reply refuses single and unfinished replies', async t => {
    const a = account(t);
    const calls = [];
    recordingGenerator(calls);
    const accepted = await a.accept();
    const pending = a.read().messages[1];
    assert.throws(() => a.mutate(bucket => store.keepComparedReply(bucket, a.session.id, pending.id)), error => error.code === 'SCRATCHPAD_REPLY_PENDING');
    await runJob(getJob(a.directories, accepted.job.id));
    const user = a.read().messages[0];
    assert.throws(() => a.mutate(bucket => store.keepComparedReply(bucket, a.session.id, user.id)), error => error.code === 'SCRATCHPAD_COMPARE_MISSING');
    const betaId = a.read().messages[2].id;
    const kept = a.mutate(bucket => store.keepComparedReply(bucket, a.session.id, betaId));
    assert.equal(kept.connectionLabel, 'Beta');
    assert.deepEqual(a.read().messages.map(message => message.text), ['Which ending works?', 'Answer from Beta']);
});

test('connection helpers mirror each other on the server and in the browser', () => {
    assert.deepEqual(effectiveConnection({ kind: 'current' }, 'beta'), BETA);
    assert.deepEqual(effectiveConnection({ kind: 'current' }, ''), { kind: 'active' });
    assert.equal(sameConnectionTarget(effectiveConnection(ALPHA), effectiveConnection(ALPHA)), true);
    assert.equal(sameConnectionTarget(effectiveConnection(ALPHA), effectiveConnection(BETA)), false);
    assert.equal(connectionDisplayLabel(ALPHA, { profile: { name: 'Alpha', 'api-url': SECRET_URL } }), 'Alpha');
    assert.equal(connectionDisplayLabel(ALPHA, { profile: {} }), 'Saved profile');
    assert.equal(connectionDisplayLabel({ kind: 'current' }, { profile: { name: 'Beta' } }), 'Chat connection (Beta)');
    assert.equal(connectionDisplayLabel({ kind: 'current' }, { active: {} }), 'Current connection');
    assert.equal(compare.sameCompareTarget({ kind: 'current' }, { kind: 'current' }, ''), true);
    assert.equal(compare.sameCompareTarget({ kind: 'current' }, BETA, 'beta'), true);
    assert.equal(compare.sameCompareTarget(ALPHA, BETA, ''), false);
    assert.equal(compare.sameCompareTarget(ALPHA, null, ''), false);
    assert.equal(compare.compareChoiceValue(null), '');
    assert.equal(compare.compareChoiceValue({ kind: 'current' }), compare.CURRENT_CONNECTION_CHOICE);
    assert.equal(compare.compareChoiceValue(BETA), 'beta');
    assert.deepEqual(compare.compareConnectionFromChoice('beta'), BETA);
    assert.equal(compare.compareConnectionFromChoice(''), null);
    assert.equal(compare.activeCompareConnection({ compareConnection: BETA, roundTable: true }), null);
    assert.equal(compare.activeCompareConnection({ compareConnection: BETA }, { rehearsal: true }), null);
    assert.deepEqual(compare.activeCompareConnection({ compareConnection: BETA }), BETA);
});
