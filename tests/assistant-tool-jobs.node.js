import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard, read: readCard } = await import('../src/character-card-parser.js');
const { roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { writeAgentRecordLocked } = await import('../src/in-chat-agent-storage.js');
const { acceptJob, getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { captureAssistantToolRequest, admitAssistantToolJob, runAssistantToolJob } = await import('../src/generation/assistant-tool-jobs.js');
const { decideJobApproval, readJobApproval, requireJobApproval } = await import('../src/generation/job-approvals.js');
const { router: agentRouter } = await import('../src/endpoints/in-chat-agents.js');
const { router: presetRouter } = await import('../src/endpoints/presets.js');
const { router: characterRouter } = await import('../src/endpoints/characters.js');
const { nativeAgentDefinition, agentNeedsModel } = await import('../src/generation/agent-definition.js');

async function authoringServer(t, f) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: f.dirs, profile: { handle: f.f.scope.owner } };
        next();
    });
    app.use('/agents', agentRouter);
    app.use('/presets', presetRouter);
    app.use('/characters', characterRouter);
    const server = await new Promise(resolve => {
        const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
    });
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function authoringPost(url, body, owner) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close',
        'X-Neconyan-Account': owner }, body: JSON.stringify(body) });
}

function prepared(t) {
    const f = fixture(t, false, 'assistant-tools');
    const dirs = f.scope.directories;
    dirs.worlds = path.join(dirs.root, 'worlds');
    dirs.inChatAgents = path.join(dirs.root, 'agents');
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    for (const folder of [dirs.worlds, dirs.inChatAgents, dirs.openAI_Settings]) fs.mkdirSync(folder, { recursive: true });
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(item => JSON.stringify(item)).join('\n'));
    const card = { name: 'Nova', description: 'Assistant', data: { name: 'Nova', description: 'Assistant',
        extensions: { neconyan_assistant: { id: 'miso-male' } } } };
    fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify(card)));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({ extension_settings: { connectionManager: { profiles: [] } } }));
    const book = { name: 'Manual', entries: { 12: { uid: 12, comment: 'Observatory', content: 'Old note',
        key: ['observatory'], disable: false } }, originalData: { entries: [{ id: 44, comment: 'Observatory', content: 'Old note', extensions: { private: true } }] },
    originalDataUidMap: { 12: 0 } };
    fs.writeFileSync(path.join(dirs.worlds, 'Manual.json'), JSON.stringify(book));
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Safe.json'), JSON.stringify({ temperature: 1, custom_key: 'do-not-disclose' }));
    const account = roleplayAccountStamp(f.scope);
    withRoleplayAccount(f.scope, account, lease => writeAgentRecordLocked(lease, 'agent',
        { id: 'tool-agent', name: 'Tools', prompt: 'Before', tags: ['safe'], favorite: false }));
    const source = f.source();
    const capture = (name, args = {}, callId = `call-${name}`) => captureAssistantToolRequest(f.scope, account, source,
        { avatar: 'Nova.png', name: `Neconyan_Assistant_${name}`, args, callId });
    const admit = (request, operationKey = `assistant:${request.callId}`) => {
        const { jobId } = admitAssistantToolJob(f.scope, account, { source, operationKey, request });
        releaseJob(dirs, jobId);
        updateJob(dirs, jobId, { state: 'running' });
        const context = () => ({ directories: dirs, owner: f.scope.owner, job: getJob(dirs, jobId), signal: new AbortController().signal });
        return { jobId, context };
    };
    return { f, dirs, account, source, capture, admit };
}

test('the assistant reads only named safe fields from bound saved resources', async t => {
    const f = prepared(t);
    const outputs = [
        ['ListLorebooks', {}, result => assert.deepEqual(result.books, [{ name: 'Manual' }])],
        ['ReadLorebookEntry', { book: 'Manual', uid: 12 }, result => assert.equal(result.entry.content, 'Old note')],
        ['ReadAgent', { id: 'tool-agent' }, result => assert.equal(result.agent.prompt, 'Before')],
        ['ReadModelPreset', { apiId: 'openai', name: 'Safe' }, result => {
            assert.equal(result.preset.temperature, 1);
            assert.equal(JSON.stringify(result).includes('do-not-disclose'), false);
        }],
        ['ReadCharacter', { avatar: 'Nova.png' }, result => assert.equal(result.character.name, 'Nova')],
    ];
    for (const [name, args, check] of outputs) {
        const request = f.capture(name, args);
        const { context } = f.admit(request);
        const completion = await runAssistantToolJob(context());
        check(completion.result.result);
    }
    assert.equal(f.f.records[2].mes, 'Answer');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.worlds, 'Manual.json'))).entries[12].content, 'Old note');
});

test('the assistant cannot treat model confirmation as approval for an Agent edit', async t => {
    const f = prepared(t);
    const args = { id: 'tool-agent', field: 'prompt', value: 'After', userConfirmed: true };
    const request = f.capture('EditAgent', args, 'edit-agent-1');
    const { context } = f.admit(request);
    const waiting = await runAssistantToolJob(context());
    assert.equal(waiting.waiting, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.inChatAgents, 'tool-agent.json'))).prompt, 'Before');
    assert.throws(() => decideJobApproval(context(), { id: waiting.approval.id, proposalHash: '0'.repeat(64), decision: 'allow' }), { status: 409 });
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'allow' });
    const finished = await runAssistantToolJob(context());
    assert.equal(finished.result.result.after, 'After');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.inChatAgents, 'tool-agent.json'))).prompt, 'After');
    const repeated = await runAssistantToolJob(context());
    assert.deepEqual(repeated, finished);
});

test('agent creation requires approval, survives a staged-write interruption and publishes once', async t => {
    const f = prepared(t);
    const args = { userConfirmed: true, agent: { name: 'Notes', prompt: 'Keep notes.', kind: 'companion' } };
    const request = f.capture('CreateAgent', args, 'create-agent');
    assert.deepEqual(f.capture('CreateAgent', args, 'create-agent'), request);
    const { context } = f.admit(request);
    const filename = path.join(f.dirs.root, request.resource.relative);
    const pending = await runAssistantToolJob(context());
    assert.equal(pending.waiting, true);
    assert.equal(fs.existsSync(filename), false);
    decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    await assert.rejects(runAssistantToolJob(context(), { beforePublish: () => { throw Error('Interrupted before publication'); } }), /Interrupted/);
    assert.equal(fs.existsSync(filename), false);
    const finished = await runAssistantToolJob(context());
    assert.equal(finished.result.result.id, request.resource.id);
    assert.equal(finished.result.result.committed, true);
    const saved = JSON.parse(fs.readFileSync(filename));
    assert.equal(saved.enabled, false);
    assert.equal(saved.execution, 'companion');
    assert.equal(saved.prompt, 'Keep notes.');
    const identity = fs.statSync(filename, { bigint: true }).ino;
    assert.deepEqual(await runAssistantToolJob(context()), finished);
    assert.equal(fs.statSync(filename, { bigint: true }).ino, identity);
    assert.equal(f.capture('ReadAgent', { id: saved.id }).response.agent.prompt, saved.prompt);
    assert.throws(() => f.capture('CreateAgent', args, 'create-agent'), /already uses/);
});

test('agent creation refuses invalid configuration, missing confirmation, decline and a competing file', async t => {
    const f = prepared(t);
    const agent = { name: 'Agent', prompt: 'Keep notes.', kind: 'after-reply', afterReplyMode: 'append' };
    for (const changes of [{ enabled: true }, { id: 'tool-agent' }, { connectionProfile: 'missing' }, { prompt: ' ' }, { kind: 'unknown' }]) {
        assert.throws(() => f.capture('CreateAgent', { userConfirmed: true, agent: { ...agent, ...changes } }), { code: 'ASSISTANT_TOOL_INVALID' });
    }
    const ask = f.admit(f.capture('CreateAgent', { agent }, 'ask-create'));
    assert.equal((await runAssistantToolJob(ask.context())).result.result.status, 'needs_confirmation');
    const declined = f.capture('CreateAgent', { userConfirmed: true, agent }, 'decline-create');
    const denied = f.admit(declined);
    const pending = await runAssistantToolJob(denied.context());
    decideJobApproval(denied.context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'deny' });
    await runAssistantToolJob(denied.context());
    assert.equal(fs.existsSync(path.join(f.dirs.root, declined.resource.relative)), false);
    const request = f.capture('CreateAgent', { userConfirmed: true, agent }, 'race-create');
    const race = f.admit(request);
    const review = await runAssistantToolJob(race.context());
    decideJobApproval(race.context(), { id: review.approval.id, proposalHash: review.approval.proposalHash, decision: 'allow' });
    const filename = path.join(f.dirs.root, request.resource.relative);
    fs.writeFileSync(filename, JSON.stringify({ id: request.resource.id, name: 'Keep this other agent' }));
    await assert.rejects(runAssistantToolJob(race.context()), /already uses/);
    assert.equal(JSON.parse(fs.readFileSync(filename)).name, 'Keep this other agent');
});

test('created agent kinds have usable runtime settings and respect the library capacity after review', async t => {
    const f = prepared(t);
    for (const kind of ['before-reply', 'after-reply', 'companion']) {
        const request = f.capture('CreateAgent', { userConfirmed: true, agent: { name: kind, prompt: 'Keep notes.', kind } }, kind);
        const { context } = f.admit(request);
        const pending = await runAssistantToolJob(context());
        decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
        await runAssistantToolJob(context());
        const agent = nativeAgentDefinition(JSON.parse(fs.readFileSync(path.join(f.dirs.root, request.resource.relative))));
        assert.equal(agentNeedsModel(agent), kind !== 'before-reply');
        if (kind === 'after-reply') assert.equal(agent.postProcess.promptTransformMode, 'rewrite');
        if (kind === 'before-reply') assert.equal(agent.preProcess.mode, 'inject');
    }
    const request = f.capture('CreateAgent', { userConfirmed: true, agent: { name: 'Full library', prompt: 'Notes', kind: 'companion' } }, 'capacity');
    const { context } = f.admit(request);
    const pending = await runAssistantToolJob(context());
    decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    for (let i = fs.readdirSync(f.dirs.inChatAgents).length; i < 512; i++) {
        const id = `filler-${i}`;
        fs.writeFileSync(path.join(f.dirs.inChatAgents, `${id}.json`), JSON.stringify({ id, name: id, prompt: '' }));
    }
    await assert.rejects(runAssistantToolJob(context()), /limit/i);
    assert.equal(fs.existsSync(path.join(f.dirs.root, request.resource.relative)), false);
});

test('lorebook and preset edits preserve unselected fields and refuse unsupported preset values', async t => {
    const f = prepared(t);
    const book = f.capture('EditLorebookEntry', { book: 'Manual', uid: 12, field: 'content', value: 'After',
        expected: { title: 'Observatory', content: 'Old note' }, userConfirmed: true }, 'edit-book');
    const bk = f.admit(book);
    const pending = await runAssistantToolJob(bk.context());
    decideJobApproval(bk.context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    await runAssistantToolJob(bk.context());
    const savedBook = JSON.parse(fs.readFileSync(path.join(f.dirs.worlds, 'Manual.json')));
    assert.equal(savedBook.entries[12].content, 'After');
    assert.equal(savedBook.originalData.entries[0].content, 'After');
    assert.equal(savedBook.originalData.entries[0].extensions.private, true);
    assert.throws(() => f.capture('EditModelPreset', { apiId: 'openai', name: 'Safe', field: 'temperature', value: 9,
        userConfirmed: true }), { code: 'ASSISTANT_TOOL_INVALID' });
    const preset = f.capture('EditModelPreset', { apiId: 'openai', name: 'Safe', field: 'temperature', value: 0.7,
        userConfirmed: true }, 'edit-preset');
    const ps = f.admit(preset);
    const approval = await runAssistantToolJob(ps.context());
    decideJobApproval(ps.context(), { id: approval.approval.id, proposalHash: approval.approval.proposalHash, decision: 'allow' });
    await runAssistantToolJob(ps.context());
    const savedPreset = JSON.parse(fs.readFileSync(path.join(f.dirs.openAI_Settings, 'Safe.json')));
    assert.equal(savedPreset.temperature, 0.7);
    assert.equal(savedPreset.custom_key, 'do-not-disclose');
});

test('an ask-first tool cannot perform a mutation without a subsequent reviewed request', async t => {
    const f = prepared(t);
    const request = f.capture('EditAgent', { id: 'tool-agent', field: 'prompt', value: 'Nope', userConfirmed: false });
    const { context } = f.admit(request);
    const result = await runAssistantToolJob(context());
    assert.equal(result.result.result.status, 'needs_confirmation');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.inChatAgents, 'tool-agent.json'))).prompt, 'Before');
});

test('ordinary Agent and preset writers cannot absorb an accepted assistant edit while approval is pending', async t => {
    const f = prepared(t);
    const url = await authoringServer(t, f);
    const owner = f.f.scope.owner;
    const editAgent = f.admit(f.capture('EditAgent', { id: 'tool-agent', field: 'prompt', value: 'Approved', userConfirmed: true }, 'agent-http'));
    const agentApproval = await runAssistantToolJob(editAgent.context());
    const blockedAgent = await authoringPost(`${url}/agents/save`, { id: 'tool-agent', name: 'Tools', prompt: 'Ordinary', tags: ['safe'], favorite: false }, owner);
    assert.equal(blockedAgent.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.inChatAgents, 'tool-agent.json'), 'utf8')).prompt, 'Before');
    decideJobApproval(editAgent.context(), { id: agentApproval.approval.id, proposalHash: agentApproval.approval.proposalHash, decision: 'deny' });
    await runAssistantToolJob(editAgent.context());
    const allowedAgent = await authoringPost(`${url}/agents/save`, { id: 'tool-agent', name: 'Tools', prompt: 'Ordinary', tags: ['safe'], favorite: false }, owner);
    assert.equal(allowedAgent.status, 200);

    const editPreset = f.admit(f.capture('EditModelPreset', { apiId: 'openai', name: 'Safe', field: 'temperature', value: 0.7,
        userConfirmed: true }, 'preset-http'));
    const presetApproval = await runAssistantToolJob(editPreset.context());
    const blockedPreset = await authoringPost(`${url}/presets/save`, { apiId: 'openai', name: 'Safe', preset: { temperature: 0.3 } }, owner);
    assert.equal(blockedPreset.status, 409);
    const blockedDelete = await authoringPost(`${url}/presets/delete`, { apiId: 'openai', name: 'Safe' }, owner);
    assert.equal(blockedDelete.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.openAI_Settings, 'Safe.json'), 'utf8')).temperature, 1);
    decideJobApproval(editPreset.context(), { id: presetApproval.approval.id, proposalHash: presetApproval.approval.proposalHash, decision: 'deny' });
    await runAssistantToolJob(editPreset.context());
    const allowedPreset = await authoringPost(`${url}/presets/save`, { apiId: 'openai', name: 'Safe', preset: { temperature: 0.3 } }, owner);
    assert.equal(allowedPreset.status, 200);
});

test('an approved edit of the assistant own card uses a protected lifecycle receipt and preserves chat identity', async t => {
    const f = prepared(t);
    const request = f.capture('EditCharacter', { avatar: 'Nova.png', field: 'description', value: 'Approved new description', userConfirmed: true }, 'self-edit');
    const { context } = f.admit(request);
    const waiting = await runAssistantToolJob(context());
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(f.dirs.characters, 'Nova.png')))).data.description, 'Assistant');
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'allow' });
    const completed = await runAssistantToolJob(context());
    assert.equal(completed.result.result.after, 'Approved new description');
    const card = JSON.parse(readCard(fs.readFileSync(path.join(f.dirs.characters, 'Nova.png'))));
    assert.equal(card.data.description, 'Approved new description');
    assert.equal(card.data.extensions.neconyan_assistant.id, 'miso-male');
    assert.equal(JSON.parse(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n')[2]).mes, 'Answer');
    assert.deepEqual(await runAssistantToolJob(context()), completed);
});

test('approved character creation publishes a new card with exact reviewed fields and never alters the assistant', async t => {
    const f = prepared(t);
    const request = f.capture('CreateCharacter', { userConfirmed: true, character: { name: 'New Friend', description: 'Long story', first_mes: 'Hello.' },
        characterNote: 'Remember my hat.', alternateGreetings: ['Hi there.'] }, 'create-default');
    const { context } = f.admit(request);
    const pending = await runAssistantToolJob(context());
    assert.equal(fs.existsSync(path.join(f.dirs.characters, request.resource.id)), false);
    decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    const completed = await runAssistantToolJob(context());
    assert.equal(completed.result.result.avatar, request.resource.id);
    const saved = JSON.parse(readCard(fs.readFileSync(path.join(f.dirs.characters, request.resource.id))));
    assert.equal(saved.data.name, 'New Friend');
    assert.equal(saved.data.description, 'Long story');
    assert.equal(saved.data.alternate_greetings[0], 'Hi there.');
    assert.equal(saved.data.extensions.depth_prompt.prompt, 'Remember my hat.');
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(f.dirs.characters, 'Nova.png')))).data.description, 'Assistant');
    assert.deepEqual(await runAssistantToolJob(context()), completed);
});

test('a saved character lifecycle result completes after a lost assistant-tool acknowledgement without a second card write', async t => {
    const f = prepared(t);
    const request = f.capture('EditCharacter', { avatar: 'Nova.png', field: 'description', value: 'Recovered edit', userConfirmed: true }, 'self-recover');
    const { context } = f.admit(request);
    const pending = await runAssistantToolJob(context());
    decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    await assert.rejects(runAssistantToolJob(context(), { afterCommit: () => { throw Error('Lost tool receipt after lifecycle commit'); } }),
        /Lost tool receipt/);
    const filename = path.join(f.dirs.characters, 'Nova.png');
    const changed = fs.statSync(filename, { bigint: true });
    assert.equal(JSON.parse(readCard(fs.readFileSync(filename))).data.description, 'Recovered edit');
    await runAssistantToolJob(context());
    assert.equal(fs.statSync(filename, { bigint: true }).ino, changed.ino);
});

test('a paid avatar request begins only after actual approval and its unknown outcome never creates a character or repeats', async t => {
    const f = prepared(t);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dirs.root, 'settings.json'), 'utf8'));
    saved.extension_settings['quick-image-gen'] = { provider: 'together', togetherKey: 'private-key', togetherModel: 'test-image', seed: 13 };
    fs.writeFileSync(path.join(f.dirs.root, 'settings.json'), JSON.stringify(saved));
    const request = f.capture('CreateCharacter', { userConfirmed: true, character: { name: 'Portrait Friend' },
        avatarPrompt: 'A portrait of the friend.' }, 'avatar-unknown');
    const { context } = f.admit(request);
    const pending = await runAssistantToolJob(context(), { fetchImpl: () => { throw Error('The avatar should wait for approval'); } });
    decideJobApproval(context(), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    let requests = 0;
    await assert.rejects(runAssistantToolJob(context(), { fetchImpl: () => { requests++; throw Error('A paid image outcome was lost'); } }),
        { code: 'QIG_PROVIDER_ERROR' });
    assert.equal(requests, 1);
    recoverJobs(f.dirs);
    await assert.rejects(runAssistantToolJob(context(), { fetchImpl: () => { throw Error('A repeated paid request'); } }),
        { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(fs.existsSync(path.join(f.dirs.characters, request.resource.id)), false);
});

test('a reviewed paid avatar is reused after a lost character-publication acknowledgement', async t => {
    const f = prepared(t);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dirs.root, 'settings.json'), 'utf8'));
    saved.extension_settings['quick-image-gen'] = { provider: 'together', togetherKey: 'private-key', togetherModel: 'test-image', seed: 13 };
    fs.writeFileSync(path.join(f.dirs.root, 'settings.json'), JSON.stringify(saved));
    const request = f.capture('CreateCharacter', { userConfirmed: true, character: { name: 'Portrait Friend' },
        avatarPrompt: 'A portrait of the friend.' }, 'avatar-recover');
    const { context } = f.admit(request);
    const waiting = await runAssistantToolJob(context(), { fetchImpl: () => assert.fail('The image must wait for actual approval.') });
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'allow' });
    let requests = 0;
    await assert.rejects(runAssistantToolJob(context(), {
        fetchImpl: async () => {
            requests++;
            return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
                headers: { 'Content-Type': 'application/json' },
            });
        },
        beforePublish: () => { throw Error('Lost character publication acknowledgement'); },
    }), /Lost character publication acknowledgement/);
    assert.equal(requests, 1);
    assert.equal(fs.existsSync(path.join(f.dirs.characters, request.resource.id)), false);
    const result = await runAssistantToolJob(context(), { fetchImpl: () => assert.fail('The avatar must not be paid for twice.') });
    assert.equal(result.result.result.avatar, request.resource.id);
    const bytes = fs.readFileSync(path.join(f.dirs.characters, request.resource.id));
    assert.equal(JSON.parse(readCard(bytes)).data.name, 'Portrait Friend');
    assert.equal(requests, 1);
    assert.deepEqual(await runAssistantToolJob(context()), result);
});

test('an ordinary character writer cannot absorb a pending reviewed native character edit', async t => {
    const f = prepared(t);
    const url = await authoringServer(t, f);
    const request = f.capture('EditCharacter', { avatar: 'Nova.png', field: 'description', value: 'Native edit', userConfirmed: true }, 'http-card');
    const { context } = f.admit(request);
    const waiting = await runAssistantToolJob(context());
    const blocked = await authoringPost(`${url}/characters/edit-attribute`, { ch_name: 'Nova', avatar_url: 'Nova.png',
        field: 'description', value: 'Ordinary edit' }, f.f.scope.owner);
    assert.equal(blocked.status, 409);
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(f.dirs.characters, 'Nova.png')))).data.description, 'Assistant');
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'deny' });
    await runAssistantToolJob(context());
    const allowed = await authoringPost(`${url}/characters/edit-attribute`, { ch_name: 'Nova', avatar_url: 'Nova.png',
        field: 'description', value: 'Ordinary edit' }, f.f.scope.owner);
    assert.equal(allowed.status, 200);
});

test('a near-limit reviewed character request retains the exact full text before approval', async t => {
    const f = prepared(t);
    const character = { name: 'Long review' };
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
        'system_prompt', 'post_history_instructions']) character[field] = `${field}: ${'A'.repeat(95000)}`;
    const args = { character, characterNote: 'N'.repeat(90000), alternateGreetings: ['G'.repeat(90000)], userConfirmed: true };
    const request = f.capture('CreateCharacter', args, 'full-reviewed-character');
    const { context } = f.admit(request, 'full-reviewed-character');
    const waiting = await runAssistantToolJob(context());
    assert.equal(waiting.waiting, true);
    const review = readJobApproval(context(), waiting.approval.id);
    assert.equal(review.proposal.arguments.character.description, character.description);
    assert.equal(review.proposal.arguments.character.post_history_instructions, character.post_history_instructions);
    assert.equal(review.proposal.arguments.characterNote, args.characterNote);
    assert.deepEqual(review.proposal.arguments.alternateGreetings, args.alternateGreetings);
    assert.equal(Object.hasOwn(review.proposal, 'after'), false);
    decideJobApproval(context(), { id: review.id, proposalHash: review.proposalHash, decision: 'deny' });
    await runAssistantToolJob(context());
    assert.equal(fs.existsSync(path.join(f.dirs.characters, request.resource.id)), false);
});

test('full saved owner reviews refuse another accepted edit before exhausting approval storage', t => {
    const f = prepared(t);
    const owner = f.f.scope.owner;
    const { job } = acceptJob(f.dirs, { owner, type: 'approval-fixture', submissionKey: 'approval-capacity',
        intent: { purpose: 'bound reviewed capacity' }, paused: true });
    const context = () => ({ directories: f.dirs, owner, job: getJob(f.dirs, job.id), signal: new AbortController().signal });
    const payload = 'R'.repeat(3900000);
    for (let index = 0; index < 4; index++) {
        updateJob(f.dirs, job.id, { state: 'running' });
        const review = requireJobApproval(context(), { account: f.account, key: `capacity-${index}`,
            proposal: { text: payload, index } });
        assert.equal(review.decision, null);
        assert.equal(readJobApproval(context(), review.id).proposal.text.length, payload.length);
    }
    const character = { name: 'Capacity check' };
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
        'system_prompt', 'post_history_instructions']) character[field] = 'C'.repeat(95000);
    const request = f.capture('CreateCharacter', { character, characterNote: 'N'.repeat(90000),
        alternateGreetings: ['G'.repeat(90000)], userConfirmed: true }, 'review-storage-full');
    assert.throws(() => admitAssistantToolJob(f.f.scope, f.account, { operationKey: 'review-storage-full', source: f.source, request }),
        { code: 'JOB_APPROVAL_CAPACITY' });
    assert.equal(fs.existsSync(path.join(f.dirs.characters, request.resource.id)), false);
});
