import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const store = await import('../src/scratchpad/store.js');
const { acceptScratchpadReply, registerScratchpadJobs, normaliseReplyRequest } = await import('../src/scratchpad/jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { MAX_REHEARSAL_LABEL, REHEARSAL_INSTRUCTIONS, REHEARSAL_REQUEST } = await import('../public/scripts/scratchpad/rehearsal.js');
after(() => cancelAutoSaves());

let counter = 0;
function account(t, settings = {}) {
    const f = fixture(t, false, 'scratch-try-change');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const source = { kind: 'roleplay', key: 'character:Nova.png:Source' };
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const session = store.mutateBucket(base, source, bucket => store.createSession(bucket, {
        settings: { connection: { kind: 'profile', profileId: 'saved' }, ...settings },
    }));
    const read = () => store.withScratchpad(base, lease => store.findSession(store.readBucketLocked(lease, source), session.id));
    const accept = extra => {
        const body = { source, sessionId: session.id, submissionKey: `try-${++counter}`, rehearsal: true, text: '',
            context: '## Unsaved change under rehearsal\nChange: Change Nova\'s description\nNova is now a lighthouse keeper.', names: { user: 'Me', character: 'Nova' }, ...extra };
        return acceptScratchpadReply(request(body), body);
    };
    setDirectoriesResolver(() => directories);
    return { f, directories, source, session, read, accept };
}

const story = { source: { kind: 'roleplay', key: 'character:Nova.png:Source' }, sessionId: 'a'.repeat(24), submissionKey: 'one', rehearsal: true, text: '' };

test('rehearsal labels are cleaned, capped and only kept on rehearsals', () => {
    assert.equal(normaliseReplyRequest({ ...story, rehearsalLabel: ' Change\u0000 Nova\'s\n description ' }).rehearsalLabel, 'Change Nova\'s description');
    const long = normaliseReplyRequest({ ...story, rehearsalLabel: 'x'.repeat(500) }).rehearsalLabel;
    assert.equal(long.length, MAX_REHEARSAL_LABEL);
    assert.ok(long.endsWith('…'));
    assert.equal(Object.hasOwn(normaliseReplyRequest(story), 'rehearsalLabel'), false);
    assert.equal(Object.hasOwn(normaliseReplyRequest({ ...story, rehearsalLabel: '\u0000 \n' }), 'rehearsalLabel'), false);
    assert.equal(Object.hasOwn(normaliseReplyRequest({ ...story, rehearsalLabel: 42 }), 'rehearsalLabel'), false);
    const ordinary = normaliseReplyRequest({ ...story, rehearsal: false, text: 'Hello.', rehearsalLabel: 'Sneaky' });
    assert.equal(Object.hasOwn(ordinary, 'rehearsalLabel'), false);
    assert.equal(ordinary.rehearsal, false);
});

test('a labelled rehearsal still rejects non-story sources and discussion mode', () => {
    assert.throws(() => normaliseReplyRequest({ ...story, rehearsalLabel: 'Change it', source: { kind: 'general', key: 'general' } }), { code: 'SCRATCHPAD_REHEARSAL_INVALID' });
    assert.throws(() => normaliseReplyRequest({ ...story, rehearsalLabel: 'Change it', source: { kind: 'notebook', key: 'notebook:one' } }));
    assert.throws(() => normaliseReplyRequest({ ...story, rehearsalLabel: 'Change it', discuss: true }), { code: 'SCRATCHPAD_REHEARSAL_INVALID' });
});

test('a change trial is a tool-free rehearsal whose label is stored, kept on retries and omitted otherwise', async t => {
    const a = account(t);
    const original = fs.readFileSync(a.f.filename);
    const calls = [];
    registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: 'Nova trims the lamp.' }; } });
    const accepted = await a.accept({ text: 'Rehearse the next story reply using this unsaved change: Change Nova\'s description.', rehearsalLabel: 'Change Nova\'s description' });
    const prepared = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(prepared.rehearsal, true);
    assert.deepEqual(prepared.functionTools, []);
    assert.equal(prepared.webSearch ?? null, null);
    assert.equal(prepared.webPages ?? null, null);
    assert.equal(prepared.sourceLookup, undefined);
    await runJob(getJob(a.directories, accepted.job.id));
    const [user, reply] = a.read().messages;
    assert.equal(user.rehearsal, true);
    assert.equal(user.rehearsalLabel, 'Change Nova\'s description');
    assert.equal(reply.rehearsal, true);
    assert.equal(reply.rehearsalLabel, 'Change Nova\'s description');
    assert.ok(calls[0].messages[0].content.startsWith(REHEARSAL_INSTRUCTIONS));
    assert.ok(calls[0].messages.some(message => String(message.content).includes('Nova is now a lighthouse keeper.')));
    const retry = await a.accept({ regenerate: reply.id, rehearsal: false });
    await runJob(getJob(a.directories, retry.job.id));
    assert.equal(a.read().messages.at(-1).rehearsalLabel, 'Change Nova\'s description');
    assert.deepEqual(calls[1].functionTools, []);
    const plain = await a.accept();
    await runJob(getJob(a.directories, plain.job.id));
    const messages = a.read().messages;
    assert.equal(messages.at(-2).text, REHEARSAL_REQUEST);
    assert.equal(messages.at(-2).rehearsal, true);
    assert.equal(Object.hasOwn(messages.at(-2), 'rehearsalLabel'), false);
    assert.equal(Object.hasOwn(messages.at(-1), 'rehearsalLabel'), false);
    assert.deepEqual(fs.readFileSync(a.f.filename), original);
});

test('rehearsals skip web search and link reading even when both are on', async t => {
    const a = account(t, { webSearch: true, readLinks: true });
    registerScratchpadJobs({ generate: async () => ({ text: 'Nova listens.' }) });
    const accepted = await a.accept({ text: 'Rehearse with https://example.com/lighthouse in mind.', rehearsalLabel: 'Change Nova\'s description' });
    const prepared = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(prepared.webSearch ?? null, null);
    assert.equal(prepared.webPages ?? null, null);
    assert.deepEqual(prepared.functionTools, []);
    await runJob(getJob(a.directories, accepted.job.id));
    await assert.rejects(() => a.accept({ rehearsal: false, text: 'Search for lighthouses.' }), { code: 'SCRATCHPAD_WEB_SEARCH_UNCONFIGURED' });
});

test('stored labels are only kept on rehearsal messages, cleaned and capped', () => {
    const { normaliseMessage } = store.testExports;
    const base = { id: store.newScratchpadId(), role: 'user', text: 'Hi' };
    assert.equal(Object.hasOwn(normaliseMessage({ ...base, rehearsalLabel: 'Change' }), 'rehearsalLabel'), false);
    assert.equal(normaliseMessage({ ...base, rehearsal: true, rehearsalLabel: 'Edit\u0007 entry\n 2' }).rehearsalLabel, 'Edit entry 2');
    assert.equal(normaliseMessage({ ...base, rehearsal: true, rehearsalLabel: 'y'.repeat(300) }).rehearsalLabel.length, MAX_REHEARSAL_LABEL);
    assert.equal(Object.hasOwn(normaliseMessage({ ...base, rehearsal: true, rehearsalLabel: '   ' }), 'rehearsalLabel'), false);
    assert.equal(Object.hasOwn(normaliseMessage({ ...base, rehearsal: true }), 'rehearsalLabel'), false);
});
