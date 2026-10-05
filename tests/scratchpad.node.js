import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { SETTINGS_FILE } = await import('../src/constants.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getJob, requestCancellation } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { acceptScratchpadReply, finalizeScratchpadSubmission, registerScratchpadJobs, testExports: jobs } = await import('../src/scratchpad/jobs.js');
const store = await import('../src/scratchpad/store.js');
const { buildScratchpadMessages, buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');
const { readScratchpadPreview } = await import('../src/scratchpad/preview.js');
const { router } = await import('../src/endpoints/scratchpad.js');

after(() => cancelAutoSaves());

const SOURCE = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
const OTHER = { kind: 'conversation', key: 'Nova.png::main', label: 'Nova' };
let counter = 0;

function account(t) {
    const f = fixture(t, false, 'scratch');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    setDirectoriesResolver(() => directories);
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const mutate = (source, change) => store.mutateBucket(base, source, change);
    const read = source => store.withScratchpad(base, lease => store.readBucketLocked(lease, source));
    return { f, directories, request, base, mutate, read };
}

function startSession(a, settings = {}) {
    return a.mutate(SOURCE, bucket => store.createSession(bucket, {
        assistant: 'taro', settings: { connection: { kind: 'profile', profileId: 'saved' }, ...settings },
    }));
}

function sendBody(session, extra = {}) {
    return {
        submissionKey: `send-${++counter}`,
        source: SOURCE,
        sessionId: session.id,
        text: 'What is Nova hiding in this scene?',
        context: '#1 User: Original\n#2 Nova: Answer',
        capabilities: { lore: true, character: true, chat: true },
        names: { user: 'Kris', character: 'Nova' },
        ...extra,
    };
}

test('a reply runs as a server job, streams a preview and settles into the saved session', async t => {
    const a = account(t);
    const session = startSession(a);
    let seen;
    registerScratchpadJobs({ generate: async options => {
        seen = options;
        options.onStream({ text: 'Nova is', reasoning: 'thinking' });
        assert.equal(readScratchpadPreview(a.f.scope.owner, options.jobContext.job.id).text, 'Nova is');
        return { text: '  Nova is hiding the letter.  ', response: { choices: [{ message: { reasoning_content: 'thought it through' } }] } };
    } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(accepted.created, true);
    const pending = accepted.bucket.sessions[0].messages;
    assert.deepEqual(pending.map(message => [message.role, message.state ?? null]), [['user', null], ['assistant', 'pending']]);

    const again = await acceptScratchpadReply(a.request(body), body);
    assert.equal(again.created, false);
    assert.equal(again.job.id, accepted.job.id, 'a retried send returns the same job instead of sending twice');
    await assert.rejects(acceptScratchpadReply(a.request(sendBody(session)), sendBody(session)), error => error.code === 'SCRATCHPAD_REPLY_PENDING');

    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    const [user, reply] = a.read(SOURCE).sessions[0].messages;
    assert.equal(user.text, 'What is Nova hiding in this scene?');
    assert.equal(reply.state, 'done');
    assert.equal(reply.text, 'Nova is hiding the letter.');
    assert.equal(reply.reasoning, 'thought it through');
    assert.equal(reply.assistant, 'taro');
    assert.equal(seen.binding.kind, 'profile');
    assert.equal(seen.stream, true);
    assert.equal(seen.preparedMessages, true);
    assert.equal(seen.characterName, 'Taro');
    assert.match(seen.messages[0].content, /You are Taro/);
    assert.match(seen.messages[1].content, /<story_context>\n#1 User: Original/);
    assert.equal(seen.messages.at(-1).content, 'What is Nova hiding in this scene?');
    assert.deepEqual(readArtifact(a.directories, accepted.job.id, 'result'), { replyId: reply.id, sessionId: session.id });
});

test('regenerating replaces only the latest reply and keeps earlier turns as history', async t => {
    const a = account(t);
    const session = startSession(a);
    const replies = ['First answer.', 'Second answer.', 'Better second answer.'];
    const prompts = [];
    registerScratchpadJobs({ generate: async options => {
        prompts.push(options.messages.slice(3).map(message => `${message.role}:${message.content}`));
        return { text: replies.shift() };
    } });
    for (const text of ['One?', 'Two?']) {
        const body = sendBody(session, { text });
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
    }
    const before = a.read(SOURCE).sessions[0].messages;
    await assert.rejects(acceptScratchpadReply(a.request(sendBody(session, { regenerate: before[1].id })), sendBody(session, { regenerate: before[1].id })),
        error => error.code === 'SCRATCHPAD_REGENERATE_INVALID');
    const body = sendBody(session, { text: undefined, regenerate: before[3].id });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const after = a.read(SOURCE).sessions[0].messages;
    assert.deepEqual(after.map(message => message.text), ['One?', 'First answer.', 'Two?', 'Better second answer.']);
    assert.equal(after[3].id === before[3].id, false);
    assert.deepEqual(prompts.at(-1), ['user:One?', 'assistant:First answer.', 'user:Two?']);
});

test('a failed or stopped reply is saved as failed and no longer blocks the session', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async () => { throw Object.assign(new Error('Provider said no.'), { status: 400 }); } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const failed = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'Provider said no.');

    registerScratchpadJobs({ generate: async () => ({ text: 'never runs' }) });
    const queued = sendBody(session, { text: 'Second try' });
    const second = await acceptScratchpadReply(a.request(queued), queued);
    requestCancellation(a.directories, second.job.id, { reason: 'test' });
    const projected = store.projectPending(a.read(SOURCE), id => getJob(a.directories, id)).sessions[0].messages.at(-1);
    assert.deepEqual([projected.state, projected.error], ['failed', 'Stopped.']);
    const third = sendBody(session, { text: 'Third try' });
    const resumed = await acceptScratchpadReply(a.request(third), third);
    assert.equal(resumed.created, true, 'a cancelled reply is settled instead of blocking the next message');
});

test('sessions are kept per source chat and temporary sessions disappear when another opens', async t => {
    const a = account(t);
    const kept = startSession(a);
    const temporary = a.mutate(SOURCE, bucket => store.createSession(bucket, { assistant: 'nori', temporary: true }));
    assert.equal(a.read(SOURCE).sessions.length, 2);
    a.mutate(SOURCE, bucket => store.activateSession(bucket, kept.id));
    assert.deepEqual(a.read(SOURCE).sessions.map(session => session.id), [kept.id]);
    assert.notEqual(temporary.id, kept.id);
    assert.equal(a.read(OTHER).sessions.length, 0, 'another chat starts with an empty Scratchpad');
    a.mutate(OTHER, bucket => store.createSession(bucket, { assistant: 'miso' }));
    assert.equal(a.read(OTHER).sessions[0].assistant, 'miso');
    assert.equal(a.read(SOURCE).sessions[0].assistant, 'taro');
    assert.notEqual(store.scratchpadFile(a.directories.root, SOURCE), store.scratchpadFile(a.directories.root, OTHER));
});

test('Conversation uses its saved chat connection without changing the session default', async t => {
    const a = account(t);
    const session = a.mutate(OTHER, bucket => store.createSession(bucket, { assistant: 'miso' }));
    const body = sendBody(session, { source: OTHER, chatProfileId: 'saved' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(accepted.job.credentialRef.kind, 'profile');
    assert.equal(accepted.job.credentialRef.profileId, 'saved');
    assert.equal(a.read(OTHER).sessions[0].settings.connection.kind, 'current');
});

test('each assistant keeps its own connection when switching speakers and starting another session', async t => {
    const a = account(t);
    const file = path.join(a.directories.root, SETTINGS_FILE);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.extension_settings.connectionManager.profiles.push({ id: 'other', api: 'openai', model: 'gpt-4o-mini' });
    fs.writeFileSync(file, JSON.stringify(settings));
    const session = startSession(a);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { assistantConnections: { miso: { kind: 'profile', profileId: 'other' } } } }));
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { assistantConnections: { nori: { kind: 'current' } } } }));
    assert.equal(store.assistantConnection(a.read(SOURCE).sessions[0].settings, 'taro').profileId, 'saved', 'existing session choices remain the fallback');
    const used = [];
    registerScratchpadJobs({ generate: async options => {
        used.push([options.characterName, options.binding.profileId]);
        return { text: 'A reply.' };
    } });
    for (const assistant of ['miso', 'taro', 'miso']) {
        a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { assistant }));
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
    }
    assert.deepEqual(used, [['Miso', 'other'], ['Taro', 'saved'], ['Miso', 'other']]);
    const inherited = a.mutate(SOURCE, bucket => store.createSession(bucket, { assistant: 'nori' }));
    assert.deepEqual(inherited.settings.assistantConnections, { miso: { kind: 'profile', profileId: 'other' }, nori: { kind: 'current' } });
});

test('changing session settings while a send is prepared refuses the stale request', async t => {
    const a = account(t);
    const session = startSession(a);
    const body = sendBody(session);
    const sending = acceptScratchpadReply(a.request(body), body);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { depth: 0 } }));
    await assert.rejects(sending, error => error.code === 'SCRATCHPAD_CHANGED');
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 0);
});

test('a provider response arriving after Stop is not saved as a completed reply', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async options => {
        requestCancellation(a.directories, options.jobContext.job.id, { reason: 'stopped-during-response' });
        return { text: 'This arrived too late.' };
    } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(reply.state, 'failed');
    assert.equal(reply.text, '');
    assert.equal(getJob(a.directories, accepted.job.id).state, 'cancelled');
    assert.equal(readArtifact(a.directories, accepted.job.id, 'result'), undefined);
});

test('a reply that never finished preparing is failed after a restart, and a saved one is released', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async () => ({ text: 'ok' }) });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(finalizeScratchpadSubmission({ directories: a.directories, job: getJob(a.directories, accepted.job.id) }), false, 'a released reply needs no recovery');
    const waiting = { ...getJob(a.directories, accepted.job.id), state: 'waiting', stage: 'preparing', createdAt: Date.now() - 120000 };
    assert.equal(finalizeScratchpadSubmission({ directories: a.directories, job: waiting }), true);
});

test('history keeps the newest turns that fit and always starts with a user turn', () => {
    const history = jobs.historyFrom([
        { role: 'assistant', state: 'done', text: 'orphan' },
        { role: 'user', text: 'a' },
        { role: 'assistant', state: 'failed', text: '' },
        { role: 'user', text: 'b' },
        { role: 'assistant', state: 'done', text: 'c' },
    ]);
    assert.deepEqual(history.map(item => item.text), ['a', 'b', 'c']);
    assert.throws(() => jobs.normaliseReplyRequest({ submissionKey: 'k', source: SOURCE, sessionId: 'abc', text: '   ' }), error => error.code === 'SCRATCHPAD_TEXT_REQUIRED');
    assert.throws(() => jobs.normaliseReplyRequest({ submissionKey: 'k', source: { kind: 'roleplay', key: '' }, sessionId: 'abc', text: 'x' }), error => error.code === 'SCRATCHPAD_SOURCE_INVALID');
});

test('the system prompt keeps each assistant identity and only offers the changes the page can apply', () => {
    for (const assistant of ['miso', 'taro', 'nori']) {
        const { text, persona } = buildScratchpadSystemPrompt({ assistant, gender: 'female', userName: 'Kris', characterName: 'Nova',
            capabilities: { lore: true, character: false, chat: false } });
        assert.match(text, new RegExp(`You are ${persona.name}`));
        assert.doesNotMatch(text, /\u2014/, 'no em dashes in the instructions');
        assert.match(text, /"type": ?"lorebook"/);
        assert.doesNotMatch(text, /"type": ?"chat"/);
    }
    const messages = buildScratchpadMessages({ system: 'S', context: '', history: [], text: 'Hi' });
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
});

test('the endpoint checks the account and answers with the saved Scratchpad', async t => {
    const a = account(t);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: a.f.scope.owner }, directories: a.directories };
        next();
    });
    app.use('/scratchpad', router);
    const server = await new Promise(resolve => {
        const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/scratchpad`;
    const post = (route, body, owner = a.f.scope.owner) => fetch(url + route, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': owner }, body: JSON.stringify(body) });

    const created = await post('/session/create', { source: SOURCE, assistant: 'nori', gender: 'male' });
    assert.equal(created.status, 200);
    const { bucket } = await created.json();
    assert.equal(bucket.sessions[0].assistant, 'nori');
    assert.equal(bucket.sessions[0].name, 'Nori\'s notes');
    const renamed = await post('/session/update', { source: SOURCE, sessionId: bucket.sessions[0].id, changes: { name: 'Plot holes' } });
    assert.equal((await renamed.json()).bucket.sessions[0].name, 'Plot holes');
    const wrong = await post('/bucket', { source: SOURCE }, 'someone-else');
    assert.equal(wrong.status, 409);
    const missing = await post('/session/delete', { source: SOURCE, sessionId: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'SCRATCHPAD_SESSION_MISSING');
    const preview = await fetch(`${url}/preview/not-a-job`, { headers: { Connection: 'close' } });
    assert.equal(preview.status, 404);
});
