import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const { write: writeCard, read: readCard } = await import('../src/character-card-parser.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { acceptJob, getJob, updateJob, requestCancellation, retryConversationFamily } = await import('../src/jobs/store.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { readConversationTarget, captureConversationTarget, commitConversationEffect } = await import('../src/generation/conversation-effects.js');
const { buildConversationParticipantSnapshot } = await import('../src/generation/conversation-participants.js');
const { generateConversationAssistantReply, reconcileConversationAssistantTools } = await import('../src/generation/conversation-assistant-tools.js');
const { runAssistantToolJob } = await import('../src/generation/assistant-tool-jobs.js');
const { decideJobApproval } = await import('../src/generation/job-approvals.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

async function fixture(t, id = 'miso-male', { text = false } = {}) {
    const temporary = fs.mkdtempSync('/tmp/opencode/conversation-assistant-');
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'tester');
    const directories = { root };
    for (const name of ['characters', 'groups', 'worlds', 'chats', 'groupChats', 'backups']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name], { recursive: true });
    }
    const avatar = 'Assistant.png';
    const card = id ? JSON.parse(fs.readFileSync(`default/content/assistants/${id}/card.json`)) : { name: 'Ordinary' };
    const png = fs.readFileSync('default/content/backgrounds/__transparent.png');
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(png, JSON.stringify(card)));
    const settingsFile = path.join(root, 'settings.json');
    const settings = { _version: 0, oai_settings: {}, extension_settings: {
        connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] },
        neconyan_conversation: { version: 1, settings: { connection_profile: 'saved' },
            characters: { [avatar]: { settings: {}, activeBranchId: 'main', branches: { main: {
                id: 'main', createdAt: 1, messages: [{ id: 'user-1', role: 'user', name: 'User', mes: 'How do I change Dialogue Colors?' }],
            } } } }, groups: [], reminders: [], legacyThreadPersonaAssignments: {},
        },
    } };
    if (text) {
        settings.extension_settings.connectionManager.profiles[0] = { id: 'saved', api: 'llamacpp', mode: 'tc', 'api-url': 'http://127.0.0.1:5000' };
        settings.textgenerationwebui_settings = { type: 'llamacpp' };
        settings.max_context = 8192;
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    fs.writeFileSync(path.join(directories.worlds, 'Manual.json'), JSON.stringify({ entries: {
        12: { uid: 12, comment: 'Observatory', content: 'Old note', key: ['observatory'], disable: false },
    } }));
    initialiseRoleplayAccount({ owner: 'tester', directories });
    const request = { user: { profile: { handle: 'tester' }, directories } };
    const target = captureConversationTarget(request, { avatar, personaId: '', groupId: '', branchId: 'main' });
    const current = readConversationTarget(request, target);
    let snapshot = await buildConversationParticipantSnapshot(request, current, target, { avatar }, {
        binding: captureChatProfile(directories, 'saved'), directive: '', timeZone: 'UTC',
    });
    const { job } = acceptJob(directories, { owner: 'tester', type: 'conversation.reply', submissionKey: 'assistant-reply', intent: { target } });
    writeArtifact(directories, job.id, 'request', snapshot);
    snapshot = readArtifact(directories, job.id, 'request');
    updateJob(directories, job.id, { state: 'running' });
    const context = (id = job.id) => ({ owner: 'tester', directories, job: getJob(directories, id), signal: new AbortController().signal });
    await commitConversationEffect(context(), target, 'accepted', () => null);
    const options = { messages: snapshot.messages };
    const run = generate => {
        updateJob(directories, job.id, { state: 'running' });
        return generateConversationAssistantReply(context(), snapshot, options, generate);
    };
    const child = () => getJob(directories, getJob(directories, job.id).children.at(-1));
    const finishTool = async () => {
        updateJob(directories, child().id, { state: 'running' });
        const result = await runAssistantToolJob(context(child().id));
        if (!result.waiting) updateJob(directories, child().id, { state: 'completed', result });
        return result;
    };
    return { directories, settingsFile, avatar, snapshot, job, context, run, child, finishTool };
}

function tool(name, args = {}) {
    return { text: '', response: { choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: `Neconyan_Assistant_${name}`, arguments: JSON.stringify(args) } }] } }] } };
}

test('all nine assistants receive their shared reference and Conversation tools; ordinary characters do not', async t => {
    for (const name of ['miso', 'taro', 'nori']) {
        for (const variant of ['male', 'female', 'neutral']) {
            const id = `${name}-${variant}`;
            const f = await fixture(t, id);
            assert.equal(f.snapshot.assistantTools.id, id);
            assert.match(f.snapshot.messages[0].content, /Dialogue Colors/);
            assert.equal(fs.readdirSync(f.directories.chats).length, 0);
        }
    }
    const ordinary = await fixture(t, null);
    assert.equal(ordinary.snapshot.assistantTools, undefined);
});

test('a read tool resumes with its saved result without repeating the provider or creating a Roleplay chat', async t => {
    const f = await fixture(t);
    const prompts = [];
    const generate = async options => {
        prompts.push(options);
        return prompts.length === 1 ? tool('ReadLorebookEntry', { book: 'Manual', uid: 12 }) : { text: 'Found the old note.' };
    };
    assert.equal(await f.run(generate), null);
    assert.equal(prompts[0].functionTools.length, 14);
    assert.equal(f.child().state, 'queued');
    assert.equal(await f.run(generate), null);
    assert.equal(prompts.length, 1);
    await f.finishTool();
    assert.equal(reconcileConversationAssistantTools(f.directories, getJob(f.directories, f.job.id)), true);
    assert.equal((await f.run(generate)).text, 'Found the old note.');
    assert.match(prompts[1].messages.at(-1).content, /Old note/);
    assert.equal(prompts[1].messages.at(-1).role, 'tool');
    assert.equal((await f.run(generate)).text, 'Found the old note.');
    assert.equal(prompts.length, 2);
    assert.equal(fs.readdirSync(f.directories.chats).length, 0);
});

test('Text Completion assistants retain the reference without receiving unsupported function tools', async t => {
    const f = await fixture(t, 'taro-neutral', { text: true });
    assert.match(f.snapshot.messages[0].content, /Dialogue Colors/);
    assert.equal(f.snapshot.assistantTools, undefined);
});

test('an explicit family retry recovers an interrupted tool without repeating a completed read', async t => {
    const f = await fixture(t);
    const { job: root } = acceptJob(f.directories, { owner: 'tester', type: 'conversation.reply', submissionKey: 'family', intent: {} });
    updateJob(f.directories, f.job.id, { type: 'conversation.participant', parentId: root.id });
    updateJob(f.directories, root.id, { state: 'waiting', stage: 'children', children: [f.job.id] });
    let calls = 0;
    const generate = async () => ++calls <= 2 ? tool('ListLorebooks') : { text: 'Done.' };
    await f.run(generate);
    await f.finishTool();
    const completed = f.child();
    await f.run(generate);
    const interrupted = f.child();
    updateJob(f.directories, interrupted.id, { state: 'interrupted', recoverability: 'needs-retry' });
    reconcileConversationAssistantTools(f.directories, getJob(f.directories, f.job.id));
    updateJob(f.directories, root.id, { state: 'interrupted' });
    retryConversationFamily(f.directories, root.id);
    assert.equal(getJob(f.directories, interrupted.id).state, 'queued');
    assert.equal(getJob(f.directories, completed.id).state, 'completed');
    assert.equal(getJob(f.directories, completed.id).attempt, completed.attempt);
    await f.finishTool();
    reconcileConversationAssistantTools(f.directories, getJob(f.directories, f.job.id));
    assert.equal((await f.run(generate)).text, 'Done.');
    assert.equal(calls, 3);
});

for (const decision of ['allow', 'deny']) {
    test(`a Conversation lorebook edit waits for ${decision} and forwards the saved outcome`, async t => {
        const f = await fixture(t, 'nori-neutral');
        let calls = 0;
        const generate = async options => {
            if (calls++ === 0) return tool('EditLorebookEntry', { book: 'Manual', uid: 12, field: 'content', value: 'After',
                expected: { title: 'Observatory', content: 'Old note' }, userConfirmed: true });
            assert.match(options.messages.at(-1).content, decision === 'allow' ? /After/ : /denied/);
            return { text: 'Done.' };
        };
        await f.run(generate);
        const pending = await f.finishTool();
        assert.equal(pending.waiting, true);
        const read = () => JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Manual.json'))).entries[12].content;
        assert.equal(read(), 'Old note');
        assert.equal(reconcileConversationAssistantTools(f.directories, getJob(f.directories, f.job.id)), false);
        // Reopening the app saves read markers and appearance without changing the proposed edit.
        const settings = JSON.parse(fs.readFileSync(f.settingsFile));
        settings._version += 1;
        settings.power_user = { theme: 'Calico' };
        settings.extension_settings.neconyan_conversation.characters[f.avatar].branches.main.readThrough = 'user-1';
        fs.writeFileSync(f.settingsFile, JSON.stringify(settings));
        decideJobApproval(f.context(f.child().id), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision });
        await f.finishTool();
        assert.equal(read(), decision === 'allow' ? 'After' : 'Old note');
        await f.run(generate);
        assert.equal(calls, 2);
    });
}

test('approved self-edits can finish and continue the same Conversation reply', async t => {
    const f = await fixture(t);
    let calls = 0;
    const generate = async () => calls++ === 0 ? tool('EditCharacter', { avatar: f.avatar, field: 'description', value: 'Updated description', userConfirmed: true }) : { text: 'Updated.' };
    await f.run(generate);
    const pending = await f.finishTool();
    const settings = JSON.parse(fs.readFileSync(f.settingsFile));
    settings._version += 1;
    fs.writeFileSync(f.settingsFile, JSON.stringify(settings));
    decideJobApproval(f.context(f.child().id), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    await f.finishTool();
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(f.directories.characters, f.avatar)))).data.description, 'Updated description');
    assert.equal((await f.run(generate)).text, 'Updated.');
});

test('a changed Conversation branch prevents an accepted tool from editing', async t => {
    const f = await fixture(t);
    await f.run(async () => tool('EditLorebookEntry', { book: 'Manual', uid: 12, field: 'content', value: 'After', userConfirmed: true }));
    const settings = JSON.parse(fs.readFileSync(f.settingsFile));
    settings.extension_settings.neconyan_conversation.characters[f.avatar].branches.main.messages[0].mes = 'Changed request';
    fs.writeFileSync(f.settingsFile, JSON.stringify(settings));
    await assert.rejects(f.finishTool(), /changed|edited|checkpoint/i);
});

test('changed tool settings still invalidate a reviewed Conversation edit', async t => {
    const f = await fixture(t);
    await f.run(async () => tool('EditLorebookEntry', { book: 'Manual', uid: 12, field: 'content', value: 'After', userConfirmed: true }));
    const pending = await f.finishTool();
    const settings = JSON.parse(fs.readFileSync(f.settingsFile));
    settings.extension_settings.connectionManager.profiles = [];
    fs.writeFileSync(f.settingsFile, JSON.stringify(settings));
    decideJobApproval(f.context(f.child().id), { id: pending.approval.id, proposalHash: pending.approval.proposalHash, decision: 'allow' });
    await assert.rejects(f.finishTool(), /source changed/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Manual.json'))).entries[12].content, 'Old note');
});

test('cancelling the reply also cancels its pending assistant tool', async t => {
    const f = await fixture(t);
    await f.run(async () => tool('ListLorebooks'));
    requestCancellation(f.directories, f.job.id, 'Stopped');
    assert.equal(f.child().cancellation.requested, true);
    await assert.rejects(f.finishTool(), /cancelled|no longer active/i);
});
