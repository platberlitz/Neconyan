import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplaySource, captureRoleplayStorageSourceLocked } = await import('../src/generation/roleplay-source.js');
const { commitSingleChatWriteLocked } = await import('../src/roleplay-lifecycle.js');
const { prepareNativeChatWrite, roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob } = await import('../src/generation/roleplay-workflow.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureRoleplayNamedWorkflow } = await import('../src/generation/roleplay-workflow-named.js');
const { publishRoleplayPreview, readRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { keepRoleplayReply, preserveInterruptedRoleplayReply, readRoleplayKeptReply, readWorkflowContinuationPrefix, recordWorkflowReplyText, reconcileRoleplayKeptReply, roleplayKeptReplyPending, KEPT_REPLY_ARTIFACT } = await import('../src/generation/roleplay-kept-reply.js');
const { withNativeMediaReceipt } = await import('../src/generation/media-jobs.js');
const { acceptJob, getJob, recoverJobs, releaseJob, requestCancellation, setJobState, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { roleplayHash, roleplayLease, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { readRoleplayWorkflowReceipt } = await import('../src/generation/roleplay-acceptance.js');

let editSequence = 0;

/** An ordinary saved-chat edit through the protected writer, as a user edit would be. */
function editChat(f, mutate) {
    return withRoleplayAccount(f.f.scope, f.account, lease => {
        const captured = captureRoleplayStorageSourceLocked(lease, f.f.locator);
        const records = structuredClone(captured.saved.records);
        mutate(records);
        return commitSingleChatWriteLocked(lease, { operationKey: `test-edit-${++editSequence}`,
            mode: 'update', sourceKind: 'storage', source: captured.source, records,
            backup: { deferBackup: true } }, roleplayNativeHost).writeId;
    });
}

function prepared(t, { effect = 'append', group = false, groupSpeakers = ['Nova.png'], named = null, messageIndex = 1, recovery = false, offRecord = false } = {}) {
    const f = fixture(t, group);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    if (offRecord) f.records[0].chat_metadata = { ...f.records[0].chat_metadata, mewmory_off_record: true };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    if (group) {
        for (const avatar of groupSpeakers) {
            if (avatar === 'Nova.png' || fs.existsSync(path.join(dirs.characters, avatar))) continue;
            const name = avatar.replace(/\.[^.]+$/, '');
            fs.writeFileSync(path.join(dirs.characters, avatar), writeCard(png,
                JSON.stringify({ name, description: 'Group member', data: { name, description: 'Group member' } })));
        }
        fs.writeFileSync(path.join(dirs.groups, 'group.json'), JSON.stringify({ id: 'group', members: groupSpeakers,
            chats: ['Source', 'New'] }));
    }
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    if (recovery) {
        dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
        fs.mkdirSync(dirs.inChatAgents);
        fs.writeFileSync(path.join(dirs.inChatAgents, 'tpl-thinking-reply-recovery.json'), JSON.stringify({ id: 'tpl-thinking-reply-recovery',
            sourceTemplateId: 'tpl-thinking-reply-recovery', name: 'Thinking Reply Recovery', enabled: true, category: 'content', phase: 'post',
            prompt: 'RECOVER', execution: 'inline', settings: {}, injection: { position: 1, depth: 1, role: 0, order: 30, scan: false },
            preProcess: { mode: 'inject', interceptTiming: 'pre-generation', applyMode: 'replace', maxTokens: 8192 },
            postProcess: { enabled: false, type: 'regex', promptTransformEnabled: true, promptTransformMode: 'rewrite', promptTransformMaxTokens: 64, promptTransformContextMessages: 8 },
            conditions: { triggerKeywords: [], triggerProbability: 100, generationTypes: ['normal', 'continue'] } }));
        fs.writeFileSync(path.join(dirs.inChatAgents, 'rewrite.json'), JSON.stringify({ id: 'rewrite', name: 'Rewrite', enabled: true, phase: 'post',
            prompt: 'REWRITE', postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } }));
    }
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] }, ...(recovery ? { inChatAgents: { globalSettings: { enabled: true } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const anchorSource = effect === 'append' || group ? source
        : captureRoleplaySource(f.scope, { locator: f.locator, message: messageIndex });
    const binding = { kind: 'profile', ...captureChatProfile(dirs, 'main') };
    const request = captureRoleplayWorkflowRequest(f.scope, account, anchorSource, { avatar: groupSpeakers[0],
        binding, maxTokens: 32, effect, ...(named ? { named } : {}),
        ...(group ? { forcedAvatars: groupSpeakers, generationId: 5 } : {}) });
    const operationKey = `kept-${effect}-${group}`;
    const { jobId } = admitRoleplayWorkflowJob(f.scope, account, { operationKey, source: anchorSource, request });
    releaseJob(dirs, jobId);
    updateJob(dirs, jobId, { state: 'running' });
    const root = () => getJob(dirs, jobId);
    const context = job => ({ owner: f.scope.owner, directories: dirs, job: job ?? root(), signal: new AbortController().signal });
    const child = async () => {
        await runRoleplayWorkflowJob(context());
        const record = readArtifact(dirs, jobId, 'roleplay-workflow-child');
        return getJob(dirs, record.jobId);
    };
    return { f, dirs, account, effect, binding, jobId, operationKey, root, child, context,
        records: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse) };
}

function saveCandidate({ dirs, child, text, reasoning = '', extra = {} }) {
    const output = { message: { name: 'Nova', is_user: false, mes: text,
        extra: { ...(reasoning ? { reasoning } : {}), ...extra } } };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text', providerHash: roleplayHash({ text }), output };
    writeArtifact(dirs, child.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
    setJobState(dirs, child.id, 'completed');
    return output;
}

function saveOutput({ dirs, child, text, reasoning = '', effect = 'append' }) {
    const output = effect === 'append'
        ? { message: { name: 'Nova', is_user: false, mes: text, extra: reasoning ? { reasoning } : {} } }
        : { text, extra: reasoning ? { reasoning } : {} };
    writeArtifact(dirs, child.id, 'roleplay-output', output);
    return output;
}

test('a mid-stream Stop keeps the partial reply and its reasoning exactly once', async t => {
    const f = prepared(t);
    const child = await f.child();
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'Half a reply', reasoning: 'Because the bell rang',
        gen_started: '2026-10-28T10:00:00.000Z', generation: { model: 'fixture', source: 'custom', reasoning_effort: 'medium' } });
    const stopped = Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' });
    const kept = preserveInterruptedRoleplayReply({ ...f.context(child), signal: AbortSignal.abort() }, stopped);
    assert.equal(kept.state, 'done');
    assert.equal(f.records().length, 4);
    assert.equal(f.records()[3].mes, 'Half a reply');
    assert.equal(f.records()[3].extra.reasoning, 'Because the bell rang');
    assert.equal(f.records()[3].extra.reasoning_effort, 'medium');
    assert.equal(f.records()[3].extra.roleplay_kept_reply.reason, 'stopped');
    assert.equal(f.records()[3].extra.roleplay_kept_reply.rootJobId, f.jobId);
    assert.equal(readRoleplayKeptReply({ directories: f.dirs, jobId: child.id }).state, 'done');
    const receipt = readRoleplayWorkflowReceipt({ user: { profile: { handle: f.f.scope.owner }, directories: f.dirs } }, f.operationKey);
    assert.deepEqual(receipt.capabilities, { keptReply: 1 });
    assert.equal(receipt.publication, 'none');
    assert.equal(receipt.keptReply.state, 'done');
    assert.equal(receipt.keptReply.messageIndex, 2);
    // A second call, including a duplicate Stop, never adds the reply again.
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(f.records().length, 4);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'done');
});

test('thinking-only failed replies preserve existing story and selected swipes', async t => {
    for (const effect of ['append', 'continue', 'swipe', 'alternative']) {
        await t.test(effect, async t => {
            const f = prepared(t, { effect });
            const child = await f.child();
            const before = f.records();
            const step = 'provider:' + 'e'.repeat(64);
            writeArtifact(f.dirs, child.id, 'roleplay-main-provider', { intentHash: roleplayHash(child.intent), step });
            writeArtifact(f.dirs, child.id, step, { text: '', response: { choices: [{ index: 0, finish_reason: 'length',
                message: { content: '', reasoning_content: 'The reply budget ended during thinking.' } }], usage: { completion_tokens: 32 } } });
            const error = Object.assign(new Error('No answer.'), { code: 'GENERATION_NO_ANSWER' });
            const kept = preserveInterruptedRoleplayReply(f.context(child), error);
            assert.equal(kept.state, 'done');
            const saved = f.records();
            assert.deepEqual(saved.slice(1, before.length), before.slice(1), 'the story and selected swipe are untouched');
            assert.equal(saved.length, before.length + 1);
            assert.equal(saved.at(-1).mes, '');
            assert.equal(saved.at(-1).extra.reasoning, 'The reply budget ended during thinking.');
            assert.equal(saved.at(-1).extra.generation_outcome.reason, 'reasoning_only_length');
            assert.equal(readArtifact(f.dirs, child.id, 'roleplay-main-complete'), undefined);
            preserveInterruptedRoleplayReply(f.context(child), error);
            assert.deepEqual(f.records(), saved);
            // Reconcile a crash after the chat write but before its receipt was saved.
            const done = readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT);
            writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { ...done, state: 'writing', committedAt: null });
            setJobState(f.dirs, child.id, 'failed');
            assert.equal(reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id }).state, 'done');
            assert.deepEqual(f.records(), saved);
        });
    }
});

test('thinking-only preview from a failed stream is kept as incomplete, never as a completed reply', async t => {
    const f = prepared(t);
    const child = await f.child();
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: '', reasoning: 'Interrupted thinking' });
    const kept = preserveInterruptedRoleplayReply(f.context(child), new Error('The AI service ended the reply before it was finished.'));
    assert.equal(kept.state, 'done');
    assert.equal(f.records().at(-1).mes, '');
    assert.equal(f.records().at(-1).extra.reasoning, 'Interrupted thinking');
    assert.deepEqual(f.records().at(-1).extra.generation_outcome, { version: 1, status: 'truncated', reason: 'incomplete_stream' });
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-main-complete'), undefined);
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-output'), undefined);
});

test('a thinking-only captured record recovers after its provider and preview are unavailable', async t => {
    const f = prepared(t);
    const child = await f.child();
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'captured', jobId: child.id,
        rootJobId: f.jobId, intentHash: roleplayHash(child.intent), text: '', textHash: roleplayHash(''),
        reason: 'failed', source: 'provider', name: 'Nova', reasoning: 'Durable thinking',
        extra: { generation_outcome: { version: 1, status: 'error', reason: 'reasoning_only' }, generation_finish_reason: 'stop' },
        timings: {}, chunk: false });
    setJobState(f.dirs, child.id, 'failed');
    const kept = reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.equal(kept.state, 'done');
    const saved = f.records();
    assert.equal(saved.at(-1).mes, '');
    assert.equal(saved.at(-1).extra.reasoning, 'Durable thinking');
    reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.deepEqual(f.records(), saved);
});

test('a cancelled workflow root stays non-terminal until its running child and keeper finish', async t => {
    const f = prepared(t);
    const child = await f.child();
    updateJob(f.dirs, child.id, { state: 'running' });
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    assert.equal(getJob(f.dirs, f.jobId).state, 'waiting');
    assert.equal(getJob(f.dirs, child.id).cancellation.requested, true);
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'Keep this before leaving.' });
    preserveInterruptedRoleplayReply({ ...f.context(child), signal: AbortSignal.abort() },
        Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' }));
    assert.equal(f.records().at(-1).mes, 'Keep this before leaving.');
    assert.equal(getJob(f.dirs, f.jobId).state, 'waiting', 'the root is not terminal before its child is');
    setJobState(f.dirs, child.id, 'cancelled');
    assert.equal(getJob(f.dirs, child.id).state, 'cancelled');
    assert.equal(getJob(f.dirs, f.jobId).state, 'cancelled');
});

test('a receipt stays pending while the terminal child keeper still runs', async t => {
    const f = prepared(t);
    const child = await f.child();
    updateJob(f.dirs, child.id, { state: 'running' });
    assert.equal(roleplayKeptReplyPending({ directories: f.dirs, jobId: f.jobId }), true);
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'captured', text: 'Later text' });
    setJobState(f.dirs, child.id, 'completed');
    assert.equal(roleplayKeptReplyPending({ directories: f.dirs, jobId: f.jobId }), true);
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'done', text: 'Later text' });
    assert.equal(roleplayKeptReplyPending({ directories: f.dirs, jobId: f.jobId }), false);
});

test('a finished saved reply is preferred over the partial preview', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveOutput({ dirs: f.dirs, child, text: 'The complete saved reply.', reasoning: 'Full thought' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'The complete', reasoning: 'Full' });
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(f.records().at(-1).mes, 'The complete saved reply.');
    assert.equal(f.records().at(-1).extra.reasoning, 'Full thought');
    assert.equal(f.records().length, 4);
});

test('a preview-only kept reply carries its frozen Agent regex snapshot', async t => {
    const f = prepared(t);
    const child = await f.child();
    const inChatAgents = { activeAgentIds: ['mood'], generationType: 'normal', edited: false,
        regexScriptRefs: [{ agentId: 'mood', scriptId: 'mood', revision: 'accepted' }],
        nativeRegexScripts: [{ agentId: 'mood', script: { id: 'mood', scriptName: 'Mood display',
            findRegex: '/\\[MOOD\\|([^\\]]+)\\]/g', replaceString: '<em class="recovery-mood">$1</em>',
            placement: [2], markdownOnly: true, promptOnly: false } }] };
    publishRoleplayPreview(f.context(child), { stage: 'agents', text: '[MOOD|Calm] Kept by the server.',
        inChatAgents });
    assert.deepEqual(readRoleplayPreview({ owner: f.f.scope.owner, directories: f.dirs, job: { id: f.jobId } }).inChatAgents,
        inChatAgents);
    const kept = keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept.state, 'done');
    const saved = f.records().at(-1);
    assert.equal(saved.mes, '[MOOD|Calm] Kept by the server.');
    assert.deepEqual(saved.extra.inChatAgents, inChatAgents);
    assert.deepEqual(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).extra.inChatAgents, inChatAgents);
    assert.notEqual(saved.extra.inChatAgents, inChatAgents);
});

test('a completed reply without Agent metadata receives the preview snapshot', async t => {
    const f = prepared(t);
    const child = await f.child();
    const inChatAgents = { activeAgentIds: ['mood'], generationType: 'normal', edited: false,
        regexScriptRefs: [], nativeRegexScripts: [{ agentId: 'mood', script: { id: 'mood',
            findRegex: '/\\[MOOD\\|([^\\]]+)\\]/g', replaceString: '<em>$1</em>', placement: [2] } }] };
    saveOutput({ dirs: f.dirs, child, text: 'A completed reply without its regex snapshot.', reasoning: 'Kept thought' });
    publishRoleplayPreview(f.context(child), { stage: 'agents', text: 'A completed reply without its regex snapshot.',
        inChatAgents });
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records().at(-1);
    assert.equal(saved.extra.reasoning, 'Kept thought');
    assert.deepEqual(saved.extra.inChatAgents, inChatAgents);
});

test('a conflict keeps the full reply and reasoning after the chat was edited', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'A paid reply the chat moved past.', reasoning: 'Held reasoning' });
    editChat(f, records => records.push({ name: 'User', is_user: true,
        mes: 'An edit made while postprocessing ran.', extra: {} }));
    keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 5);
    assert.equal(saved[3].mes, 'An edit made while postprocessing ran.');
    assert.equal(saved[4].mes, 'A paid reply the chat moved past.');
    assert.equal(saved[4].extra.reasoning, 'Held reasoning');
    assert.equal(saved[4].extra.roleplay_kept_reply.reason, 'failed');
});

test('a refused swipe keeps its original message and adds the kept reply as a swipe', async t => {
    const f = prepared(t, { effect: 'swipe' });
    const child = await f.child();
    saveOutput({ dirs: f.dirs, child, text: 'New answer', reasoning: 'Why the new answer' });
    keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 3);
    assert.deepEqual(saved[2].swipes, ['Answer', 'Other', 'New answer']);
    assert.equal(saved[2].swipe_id, 2);
    assert.equal(saved[2].mes, 'New answer');
    assert.equal(saved[2].swipe_info[2].extra.reasoning, 'Why the new answer');
    assert.equal(saved[2].extra.roleplay_kept_reply.rootJobId, f.jobId);
    keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other', 'New answer']);
});

test('a stopped continuation extends its unchanged message without overwriting the prefix', async t => {
    const f = prepared(t, { effect: 'continue' });
    const child = await f.child();
    saveOutput({ dirs: f.dirs, child, text: ' and more', reasoning: 'Continuing', effect: 'continue' });
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved[2].mes, 'Answer and more');
    assert.equal(saved[2].extra.reasoning, 'Continuing');
});

test('a continuation whose target was edited preserves the edit and appends the paid text', async t => {
    const f = prepared(t, { effect: 'continue' });
    const child = await f.child();
    saveOutput({ dirs: f.dirs, child, text: ' and more', effect: 'continue' });
    editChat(f, records => { records[2].mes = 'An edited answer'; });
    keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved[2].mes, 'An edited answer');
    assert.equal(saved.at(-1).mes, ' and more');
    assert.equal(saved.length, 4);
});

test('an older page that saved the same partial reply is extended, not duplicated', async t => {
    const f = prepared(t);
    const child = await f.child();
    const started = '2026-10-28T11:00:00.000Z';
    saveCandidate({ dirs: f.dirs, child, text: 'Half a reply, complete' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'Half a reply', gen_started: started });
    editChat(f, records => records.push({ name: 'Nova', is_user: false, mes: 'Half a reply',
        gen_started: started, extra: {} }));
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 4);
    assert.equal(saved[3].mes, 'Half a reply, complete');
});

test('an unrelated model message with identical text is not mistaken for the reply', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'The same line.' });
    editChat(f, records => records.push({ name: 'Nova', is_user: false, mes: 'The same line.', extra: {} }));
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 5);
    assert.equal(saved.filter(record => record.mes === 'The same line.').length, 2);
});

test('unrelated prose that merely starts the same way is never suppressed', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'Sure, here is the answer.' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'Sure' });
    editChat(f, records => records.push({ name: 'Nova', is_user: false,
        mes: 'Sure, here is the answer from before.', extra: {} }));
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 5);
    assert.equal(saved[3].mes, 'Sure, here is the answer from before.');
    assert.equal(saved[4].mes, 'Sure, here is the answer.');
});

test('an older page copy longer than the server text is never shortened', async t => {
    const f = prepared(t);
    const child = await f.child();
    const started = '2026-10-28T11:00:00.000Z';
    saveCandidate({ dirs: f.dirs, child, text: 'Half a reply, complete' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'Half a reply', gen_started: started });
    editChat(f, records => records.push({ name: 'Nova', is_user: false,
        mes: 'Half a reply, complete and then some', gen_started: started, extra: {} }));
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 4);
    assert.equal(saved[3].mes, 'Half a reply, complete and then some');
});

test('a deleted chat is never recreated and the text stays on the job', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'Kept even without its chat.' });
    fs.rmSync(f.f.filename);
    const kept = keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    assert.equal(kept.state, 'failed');
    assert.ok(kept.error.code);
    assert.equal(fs.existsSync(f.f.filename), false);
    const retained = readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT);
    assert.equal(retained.text, 'Kept even without its chat.');
    assert.equal(retained.state, 'failed');
});

test('a group speaker cancelled before its first frame never adopts the previous speaker preview', async t => {
    const f = prepared(t, { group: true, groupSpeakers: ['Nova.png', 'Other.png'] });
    const first = await f.child();
    publishRoleplayPreview(f.context(first), { stage: 'generating', text: 'The first speaker reply.',
        gen_started: '2026-10-29T10:00:00.000Z' });
    // A second speaker child that has not published its own frame. Its intent
    // still names the same root and the next speaker index.
    const intent = structuredClone(first.intent);
    intent.request.workflowCandidate = { ...intent.request.workflowCandidate, turn: 1, speakerIndex: 1 };
    const second = acceptJob(f.dirs, { owner: f.f.scope.owner, type: 'roleplay.candidate',
        submissionKey: 'second-speaker', intent }).job;
    const before = f.records();
    const kept = keepRoleplayReply(f.context(getJob(f.dirs, second.id)), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept, null);
    assert.deepEqual(f.records(), before);
});

test('a thinking-only group speaker candidate is recovered, rewritten once and keeps its reasoning', async t => {
    t.after(cancelAutoSaves);
    const f = prepared(t, { group: true, groupSpeakers: ['Nova.png'], recovery: true });
    const child = await f.child();
    const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
        { identifier: 'worldInfoBefore', marker: true, system_prompt: true }, { identifier: 'chatHistory', marker: true, system_prompt: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'chatHistory', enabled: true }] }] };
    const calls = [];
    setJobState(f.dirs, child.id, 'running');
    await runRoleplayReplyJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, child.id), signal: new AbortController().signal }, {
        contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            const step = roleplayHash(['group-thinking', child.id]);
            options.onProviderStep(`provider:${step}`);
            return providerStep(options.jobContext, step, async () => {
                options.beforeDispatch();
                return { text: '', response: { choices: [{ message: { reasoning_content: 'Plan the reply' }, finish_reason: 'stop' }] } };
            });
        },
        generateAgent: async options => {
            const step = roleplayHash(['group-agent', child.id, JSON.stringify(options.messages)]);
            options.onProviderStep(`provider:${step}`);
            return providerStep(options.jobContext, step, async () => {
                options.beforeDispatch();
                const body = JSON.stringify(options.messages);
                calls.push(body.includes('RECOVER') ? 'recovery' : 'rewrite');
                return { text: body.includes('RECOVER') ? 'Recovered reply.' : 'Rewritten reply.' };
            });
        },
    });
    assert.deepEqual(calls, ['recovery', 'rewrite']);
    const candidate = readArtifact(f.dirs, child.id, 'roleplay-candidate');
    assert.equal(candidate.kind, 'text');
    const message = candidate.output.message;
    assert.equal(message.name, 'Nova');
    assert.equal(message.mes, 'Rewritten reply.');
    assert.equal(message.extra.reasoning, 'Plan the reply');
    assert.equal(message.extra.inChatAgentThinkingRecovery.status, 'done');
    assert.equal(message.extra.inChatAgentTransformHistory[0].beforeText, 'Recovered reply.', 'undo starts from the recovered prose');
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-thinking-recovery').status, 'done');
    await new Promise(resolve => setTimeout(resolve, 150));
});

function workflowDecision(root, turn, kind, text) {
    const record = { parentIntentHash: roleplayHash(root.intent), childJobId: `child-${turn}`, candidateHash: roleplayHash(['candidate', turn]),
        turn, outputHash: roleplayHash(text), decision: { kind, textHash: roleplayHash(text) } };
    return { ...record, hash: roleplayHash(record) };
}

function continuationChild(rootJobId, turn, speakerIndex = 0) {
    return { intent: { request: { workflowCandidate: { parentJobId: rootJobId, turn, speakerIndex } } } };
}

function savedTextTurn(f, turn, text, speakerIndex = 0) {
    const root = getJob(f.dirs, f.jobId);
    recordWorkflowReplyText({ directories: f.dirs }, root, turn, { message: { name: 'Nova', is_user: false, mes: text, extra: {} } },
        { selected: true, speakerIndex });
}

test('an automatic continuation walks back over a tool turn to its latest text turn and its continue decision', async t => {
    const f = prepared(t);
    const root = getJob(f.dirs, f.jobId);
    savedTextTurn(f, 0, 'Visible prose.');
    writeArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0', workflowDecision(root, 0, 'continue', 'Visible prose.'));
    // Turn 1 is a tool turn: it writes no text record and no text decision.
    assert.equal(readWorkflowContinuationPrefix({ directories: f.dirs, job: continuationChild(f.jobId, 2) }), 'Visible prose.');
});

test('a swipe decision or another speaker stops the continuation walk instead of crossing it', async t => {
    const swiped = prepared(t);
    const swipedRoot = getJob(swiped.dirs, swiped.jobId);
    savedTextTurn(swiped, 0, 'Rejected prose.');
    writeArtifact(swiped.dirs, swiped.jobId, 'roleplay-workflow-decision:0', workflowDecision(swipedRoot, 0, 'swipe', 'Rejected prose.'));
    assert.equal(readWorkflowContinuationPrefix({ directories: swiped.dirs, job: continuationChild(swiped.jobId, 2) }), null);

    const otherSpeaker = prepared(t, { group: true, groupSpeakers: ['Nova.png'] });
    const groupRoot = getJob(otherSpeaker.dirs, otherSpeaker.jobId);
    savedTextTurn(otherSpeaker, 0, 'Nova prose.', 0);
    writeArtifact(otherSpeaker.dirs, otherSpeaker.jobId, 'roleplay-workflow-decision:0', workflowDecision(groupRoot, 0, 'continue', 'Nova prose.'));
    assert.equal(readWorkflowContinuationPrefix({ directories: otherSpeaker.dirs, job: continuationChild(otherSpeaker.jobId, 2, 1) }), null);
});

test('safe start leaves a pending keeper record untouched', async t => {
    const f = prepared(t);
    const child = await f.child();
    const text = 'Held until normal start.';
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'writing', jobId: child.id,
        rootJobId: f.jobId, intentHash: roleplayHash(child.intent), text, textHash: roleplayHash(text),
        previewText: '', reason: 'stopped', name: 'Nova', avatar: 'Nova.png', reasoning: '', extra: {},
        timings: {}, chunk: false, placement: 'append', messageIndex: 3, createdAt: '2026-10-29T10:00:00.000Z' });
    updateJob(f.dirs, child.id, { state: 'running' });
    const before = f.records();
    recoverJobs(f.dirs, { hold: true });
    assert.deepEqual(f.records(), before);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'writing');
    recoverJobs(f.dirs);
    assert.equal(f.records().at(-1).mes, text);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'done');
});

test('start-up recovery finishes an interrupted keeper record exactly once', async t => {
    const f = prepared(t);
    const child = await f.child();
    const saved = saveCandidate({ dirs: f.dirs, child, text: 'Recovered after the restart.' });
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'writing', jobId: child.id,
        rootJobId: f.jobId, intentHash: roleplayHash(child.intent), text: saved.message.mes,
        previewText: '', reason: 'stopped', createdAt: '2026-10-29T10:00:00.000Z' });
    updateJob(f.dirs, child.id, { state: 'running' });
    recoverJobs(f.dirs);
    assert.equal(f.records().at(-1).mes, 'Recovered after the restart.');
    assert.equal(f.records().filter(record => record.mes === 'Recovered after the restart.').length, 1);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'done');
});

test('a preview-only captured record survives losing the preview', async t => {
    const f = prepared(t);
    const child = await f.child();
    const text = 'The preview-only partial survived on disk.';
    const captured = { version: 1, state: 'captured', jobId: child.id, rootJobId: f.jobId,
        intentHash: roleplayHash(child.intent), text, textHash: roleplayHash(text),
        previewText: text.substring(0, 20), reason: 'stopped', source: 'preview',
        account: { accountId: f.account.accountId, dataEpoch: f.account.dataEpoch },
        createdAt: '2026-10-29T10:00:00.000Z', name: 'Nova', avatar: 'Nova.png',
        reasoning: 'Reasoning kept with the record', extra: { model: 'fixture-model' },
        timings: { gen_started: '2026-10-29T09:59:00.000Z' }, chunk: false };
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, captured);
    setJobState(f.dirs, child.id, 'interrupted');
    const kept = keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept.state, 'done');
    const saved = f.records().at(-1);
    assert.equal(saved.mes, text);
    assert.equal(saved.name, 'Nova');
    assert.equal(saved.extra.reasoning, 'Reasoning kept with the record');
    assert.equal(saved.extra.model, 'fixture-model');
    assert.equal(saved.gen_started, '2026-10-29T09:59:00.000Z');
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'done');
});

test('a preview-only writing record adopts its already committed marker', async t => {
    const f = prepared(t);
    const child = await f.child();
    const text = 'A committed keeper message without a candidate.';
    const captured = { version: 1, state: 'captured', jobId: child.id, rootJobId: f.jobId,
        intentHash: roleplayHash(child.intent), text, textHash: roleplayHash(text), previewText: text,
        reason: 'stopped', source: 'preview', createdAt: '2026-10-29T10:00:00.000Z',
        name: 'Nova', avatar: 'Nova.png', reasoning: '', extra: {}, timings: {}, chunk: false };
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, captured);
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const committed = f.records();
    const done = readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT);
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { ...done, state: 'writing', committedAt: null });
    setJobState(f.dirs, child.id, 'interrupted');
    const reconciled = reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.equal(reconciled.state, 'done');
    assert.deepEqual(f.records(), committed);
});

test('an unfinished keeper account write stays pending and then completes', async t => {
    const f = prepared(t);
    const child = await f.child();
    const text = 'The pending keeper write completed.';
    const marker = { version: 1, reason: 'stopped', rootJobId: f.jobId, childJobId: child.id, textHash: roleplayHash(text) };
    withRoleplayAccount(f.f.scope, f.account, lease => {
        const captured = captureRoleplayStorageSourceLocked(lease, f.f.locator);
        const records = structuredClone(captured.saved.records);
        records.push({ name: 'Nova', is_user: false, mes: text, send_date: '2026-10-29T10:00:00.000Z',
            gen_started: '2026-10-29T10:00:00.000Z', extra: { roleplay_kept_reply: marker } });
        const host = { prepare: prepareNativeChatWrite, backups: () => false, clearDeferred: () => {},
            publish: () => { throw new Error('The write was interrupted.'); } };
        assert.throws(() => commitSingleChatWriteLocked(lease, { operationKey: `roleplay-kept:${child.id}`,
            mode: 'update', sourceKind: 'storage', source: captured.source, records,
            backup: { deferBackup: true } }, host), error => error.roleplayWritePending === true);
    });
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'writing', jobId: child.id,
        rootJobId: f.jobId, intentHash: roleplayHash(child.intent), text, textHash: roleplayHash(text),
        previewText: '', reason: 'stopped', source: 'preview', candidatesHash: null,
        name: 'Nova', avatar: 'Nova.png', reasoning: '', extra: {}, timings: {},
        chunk: false, placement: 'append', messageIndex: 3, createdAt: '2026-10-29T10:00:00.000Z' });
    setJobState(f.dirs, child.id, 'interrupted');
    const reconciled = reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.equal(reconciled.state, 'done');
    assert.equal(f.records().at(-1).mes, text);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT).state, 'done');
    withRoleplayAccount(f.f.scope, f.account, lease => assert.equal(roleplayLease(lease).state.pending, null));
    const receipt = readRoleplayWorkflowReceipt({ user: { profile: { handle: f.f.scope.owner }, directories: f.dirs } }, f.operationKey);
    assert.equal(receipt.keptReply.state, 'done');
});

test('reconciliation adopts a keeper message committed before its record was marked done', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'Already committed before the crash.' });
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const committed = f.records();
    const done = readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT);
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { ...done, state: 'writing', committedAt: null });
    setJobState(f.dirs, child.id, 'interrupted');
    const reconciled = reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.equal(reconciled.state, 'done');
    assert.deepEqual(f.records(), committed);
});

test('reconciliation never writes over an uncertain normal publication', async t => {
    const f = prepared(t);
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'A candidate owned by its normal write.' });
    const candidate = readArtifact(f.dirs, child.id, 'roleplay-candidate');
    withNativeMediaReceipt({ owner: f.f.scope.owner, directories: f.dirs, job: f.root() }, ({ value, save }) => {
        value.effects.final = { state: 'writing', candidateHash: candidate.hash };
        save();
    }, { checkSource: false });
    writeArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT, { version: 1, state: 'writing', jobId: child.id,
        rootJobId: f.jobId, intentHash: roleplayHash(child.intent), text: 'A candidate owned by its normal write.',
        previewText: '', reason: 'stopped', candidateHash: candidate.hash, createdAt: '2026-10-29T10:00:00.000Z' });
    setJobState(f.dirs, child.id, 'interrupted');
    const before = f.records();
    const reconciled = reconcileRoleplayKeptReply({ directories: f.dirs, owner: f.f.scope.owner, jobId: child.id });
    assert.equal(reconciled.state, 'writing');
    assert.deepEqual(f.records(), before);
});

test('a Deep Swipe user alternative keeps the user role and target message', async t => {
    const named = captureRoleplayNamedWorkflow('deep-swipe.user', { instruction: 'Rewrite this as me.' });
    const f = prepared(t, { effect: 'alternative', named, messageIndex: 0 });
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'A rewritten user line.' });
    keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 3);
    assert.equal(saved[1].is_user, true);
    assert.equal(saved[1].name, 'User');
    assert.deepEqual(saved[1].swipes, ['Original', 'A rewritten user line.']);
    assert.equal(saved[1].swipe_id, undefined);
    assert.equal(saved[1].mes, 'Original');
});

test('a group speaker keeps its avatar and generation identity', async t => {
    const f = prepared(t, { group: true });
    const child = await f.child();
    saveCandidate({ dirs: f.dirs, child, text: 'A group speaker reply.', reasoning: 'Speaking as Nova' });
    keepRoleplayReply(f.context(child), { reason: 'failed', rootJobId: f.jobId });
    const saved = f.records();
    assert.equal(saved.length, 4);
    assert.equal(saved[3].name, 'Nova');
    assert.equal(saved[3].original_avatar, 'Nova.png');
    assert.equal(saved[3].force_avatar, 'Nova.png');
    assert.equal(saved[3].extra.gen_id, 5);
    assert.equal(saved[3].extra.reasoning, 'Speaking as Nova');
});

test('a restart interruption with a saved delivery proof stays retryable and writes nothing', async t => {
    const f = prepared(t);
    const child = await f.child();
    const step = 'provider:' + 'a'.repeat(64);
    writeArtifact(f.dirs, child.id, 'roleplay-main-provider', { intentHash: roleplayHash(child.intent), step,
        promptHash: readArtifact(f.dirs, child.id, 'roleplay-prompt')?.hash ?? null, worldInfoHash: null });
    writeArtifact(f.dirs, child.id, step, { text: 'Saved before the restart.' });
    const kept = preserveInterruptedRoleplayReply({ ...f.context(child), signal: AbortSignal.abort() },
        Object.assign(new Error('The server stopped.'), { code: 'INTERRUPTED' }));
    assert.equal(kept, null);
    assert.equal(f.records().length, 3);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT), undefined);
    const plainFailure = preserveInterruptedRoleplayReply(f.context(child),
        new Error('The worker stopped after the provider answered.'));
    assert.equal(plainFailure, null);
    assert.equal(f.records().length, 3);
});

test('a reply stopped after Agent postprocessing keeps its rewritten text and Agent transform history', async t => {
    const f = prepared(t);
    const child = await f.child();
    writeArtifact(f.dirs, child.id, 'roleplay-agent-output-base', {
        intentHash: roleplayHash(child.intent),
        base: 'Raw reply before Agent.',
        reasoning: 'Saved reasoning',
    });
    const inChatAgentTransformHistory = [{
        id: 'tx-1',
        agentName: 'Polish',
        mode: 'rewrite',
        beforeText: 'Raw reply before Agent.',
        afterText: 'Polished reply after Agent.',
    }];
    const inChatAgentPreGenerationInterceptHistory = [{
        id: 'pre-1',
        agentName: 'Expander',
        changed: true,
        beforeText: 'Original',
        afterText: 'Expanded Original',
    }];
    writeArtifact(f.dirs, child.id, 'roleplay-agent-intercepts:pre-generation', {
        extra: { inChatAgentPreGenerationInterceptHistory },
    });
    writeArtifact(f.dirs, child.id, 'roleplay-agent-post', {
        text: 'Polished reply after Agent.',
        extra: {
            inChatAgentTransformHistory,
            inChatAgents: { activeAgentIds: ['polish'], generationType: 'normal', edited: false },
        },
    });
    const kept = keepRoleplayReply(f.context(child), { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept.state, 'done');
    const saved = f.records().at(-1);
    assert.equal(saved.mes, 'Polished reply after Agent.');
    assert.deepEqual(saved.extra.inChatAgentTransformHistory, inChatAgentTransformHistory);
    assert.deepEqual(saved.extra.inChatAgentPreGenerationInterceptHistory, inChatAgentPreGenerationInterceptHistory);
});

test('a reply kept while the chat is off the record is never read by Mewmory', async t => {
    const f = prepared(t, { offRecord: true });
    const child = await f.child();
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    publishRoleplayPreview(f.context(child), { stage: 'generating', text: 'A secret half reply',
        gen_started: '2026-10-28T10:00:00.000Z', generation: { model: 'fixture', source: 'custom' } });
    const stopped = Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' });
    const kept = preserveInterruptedRoleplayReply({ ...f.context(child), signal: AbortSignal.abort() }, stopped);
    assert.equal(kept.state, 'done', JSON.stringify(kept));
    const reply = f.records().at(-1);
    assert.equal(reply.mes, 'A secret half reply');
    assert.equal(reply.extra.mewmoryExclude, true);
    const normal = prepared(t, { effect: 'append' });
    const normalChild = await normal.child();
    requestCancellation(normal.dirs, normal.jobId, { reason: 'user_cancelled' });
    publishRoleplayPreview(normal.context(normalChild), { stage: 'generating', text: 'An ordinary half reply',
        gen_started: '2026-10-28T10:00:00.000Z', generation: { model: 'fixture', source: 'custom' } });
    preserveInterruptedRoleplayReply({ ...normal.context(normalChild), signal: AbortSignal.abort() }, stopped);
    assert.equal(normal.records().at(-1).mes, 'An ordinary half reply');
    assert.equal(normal.records().at(-1).extra.mewmoryExclude, undefined, 'chats that are on the record are unchanged');
});
