import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob,
    recoverWaitingRoleplayWorkflow } = await import('../src/generation/roleplay-workflow.js');
const { acceptRoleplayNamedWorkflow, readRoleplayWorkflowReceipt } = await import('../src/generation/roleplay-acceptance.js');
const { captureRoleplayNamedWorkflow, assertRoleplayNamedWorkflow, roleplayWorkflowContributions,
    ROLEPLAY_WORKFLOW_NAMES } = await import('../src/generation/roleplay-workflow-named.js');
const { getJob, releaseJob, setJobState } = await import('../src/jobs/store.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
function_calling: true };

/** Every named workflow here uses a saved active connection, because that is what a browser names. */
function saved(t, { settingsRevision = 7 } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        _settingsRevision: settingsRevision,
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1',
            openai_max_context: 4096, function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'active', api: 'custom', model: 'fixture',
            preset: 'Main', 'api-url': 'http://127.0.0.1:18000/v1' }] } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const records = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const messages = () => records().slice(1);
    /** The browser's own message revision, proved again server-side. */
    const revision = (name, anchor = {}) => {
        const list = messages();
        const index = anchor.messageIndex ?? (ROLEPLAY_WORKFLOW_NAMES[name].anchor === 'end' ? list.length - 1
            : list.findLastIndex(message => message.is_user !== true && message.is_system !== true));
        return getRoleplaySourceMessageRevision(list[index]);
    };
    const request = () => ({ user: { profile: { handle: f.scope.owner }, directories: dirs } });
    const body = (name, { intent = {}, anchor = {}, key = `named-${name}`, messageRevision = revision(name, anchor), ...rest } = {}) =>
        ({ key, name, intent, source: { locator: f.locator }, anchor, messageRevision, account,
            acknowledgement: { account: f.scope.owner, settingsRevision }, ...rest });
    const turn = (child, calls, text) => runRoleplayReplyJob({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, child.id),
        signal: new AbortController().signal }, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            calls.count++;
            calls.prompts.push(options.messages.map(message => ({ role: message.role, content: message.content })));
            const step = roleplayHash(['named-candidate', child.id]);
            options.onProviderStep(`provider:${step}`);
            return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text }; });
        } });
    const context = jobId => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal });
    /** Admit one named workflow and take its single model turn to a durable write. */
    async function run(name, { text = 'A named passage.', maxTokens = 64, ...submission } = {}) {
        const accepted = await acceptRoleplayNamedWorkflow(request(), body(name, { ...submission, maxTokens }));
        const calls = { count: 0, prompts: [] };
        let childId = null;
        if (accepted.created) {
            setJobState(dirs, accepted.jobId, 'running');
            const waiting = await runRoleplayWorkflowJob(context(accepted.jobId));
            assert.equal(waiting.waiting, true);
            const pointer = readArtifact(dirs, accepted.jobId, 'roleplay-workflow-child');
            childId = pointer.jobId;
            setJobState(dirs, childId, 'running');
            await turn(getJob(dirs, childId), calls, text);
            setJobState(dirs, childId, 'completed');
            recoverWaitingRoleplayWorkflow({ directories: dirs, owner: f.scope.owner, job: getJob(dirs, accepted.jobId) });
            setJobState(dirs, accepted.jobId, 'running');
        }
        // A finished receipt is the authority, so a pruned or replayed job never has to survive.
        const job = getJob(dirs, accepted.jobId);
        const result = job ? (await runRoleplayWorkflowJob(context(accepted.jobId))).result
            : readRoleplayWorkflowReceipt(request(), accepted.key).result;
        return { accepted, calls, result, childId, revision, messages };
    }
    return { dirs, account, owner: f.scope.owner, locator: f.locator, scope: f.scope, source: f.source,
        records, revision, request, body, readback: key => readRoleplayWorkflowReceipt(request(), key), run };
}

test('a named reply appends one message, keeps the old chat until it is durable and replays without paying', async t => {
    const f = saved(t);
    const { accepted, calls, result } = await f.run('roleplay.reply', { text: 'A named reply.' });
    assert.equal(accepted.created, true);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.named, { appended: true });
    assert.equal(f.records().at(-1).mes, 'A named reply.');
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other']);
    assert.equal(calls.count, 1);
    const receipt = f.readback(accepted.key);
    assert.equal(receipt.state, 'closed');
    assert.deepEqual(receipt.result, result);
    assert.equal(calls.count, 1);
    // The finished write is never retried under its own key, even by a stale page.
    await assert.rejects(acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply', { key: accepted.key })), error => error.status === 409);
    assert.equal(f.records().length, 4);
    assert.equal(f.records().at(-1).mes, 'A named reply.');
});

test('a repeated submission of the identical key is answered by the first acceptance, not a new job', async t => {
    const f = saved(t);
    const body = f.body('roleplay.reply');
    const first = await acceptRoleplayNamedWorkflow(f.request(), body);
    const second = await acceptRoleplayNamedWorkflow(f.request(), body);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.write.revision, first.write.revision);
    assert.equal(getJob(f.dirs, first.jobId).state, 'queued');
    assert.equal(f.readback(first.key).state, 'accepted');
    assert.equal(f.readback(first.key).result, null);
    assert.equal(f.records().length, 3);
});

test('a named continuation proves its cut and a named alternative adds one unselected swipe', async t => {
    const continued = saved(t);
    const story = await continued.run('roleplay.continue', { text: ' And then the door opened.', key: 'named-continue' });
    assert.equal(story.result.status, 'completed');
    assert.equal(continued.records()[2].mes, 'Answer And then the door opened.');
    assert.equal(continued.records()[2].swipes[0], 'Answer And then the door opened.');
    assert.deepEqual(story.result.named, { cut: 'Answer'.length, length: 'Answer And then the door opened.'.length });
    const swiped = saved(t);
    const deep = await swiped.run('deep-swipe.reply', { intent: { instruction: 'Say it as a rumour.' },
        text: 'They say the tower fell.', anchor: { messageIndex: 1 }, key: 'named-deep' });
    assert.equal(deep.result.status, 'completed');
    assert.equal(swiped.records()[2].mes, 'Answer');
    assert.equal(swiped.records()[2].swipe_id, 0);
    assert.deepEqual(swiped.records()[2].swipes, ['Answer', 'Other', 'They say the tower fell.']);
    assert.deepEqual(deep.result.named, { index: 2, count: 3 });
    assert.ok(deep.calls.prompts[0].at(-1).content.includes('Say it as a rumour.'));
    // The anchored message is excluded from its own Deep Swipe window.
    assert.ok(!deep.calls.prompts[0].some(message => message.role === 'assistant' && message.content === 'Answer'));
});

test('a named correction replaces one message and leaves the rest of the chat alone', async t => {
    const f = saved(t);
    const guided = await f.run('guided.correction', { intent: { prompt: { text: 'Answer in one word.', depth: 1, role: 'system', scan: true } },
        text: 'Silence.', key: 'named-correction' });
    assert.equal(guided.result.status, 'completed');
    assert.deepEqual(f.records().map(record => record.mes), [undefined, 'Original', 'Silence.']);
    assert.deepEqual(guided.result.named, { replaced: true, length: 'Silence.'.length });
    assert.ok(guided.calls.prompts[0].some(message => message.role === 'system' && message.content.includes('Answer in one word.')));
    const contributions = readArtifact(f.dirs, guided.childId, 'roleplay-prompt-contributions').values.extensions;
    assert.deepEqual(contributions.map(prompt => [prompt.key, prompt.position, prompt.depth, prompt.role, prompt.scan]),
        [['guided_prompt', 1, 1, 'system', true]]);
});

test('a named Story passage contributes its saved rules and direction, and Guided contributes its own prompt', async t => {
    const f = saved(t);
    const story = await f.run('story.passage', { intent: { prompt: { rules: 'Write as a co-author.', rulesDepth: 1,
        direction: 'Open on the storm.', directionDepth: 0 } }, text: 'Rain found the broken roof.', key: 'named-story' });
    const systems = story.calls.prompts[0].filter(message => message.role === 'system').map(message => message.content);
    assert.ok(systems.some(content => content.includes('Write as a co-author.')));
    assert.ok(systems.some(content => content.includes('Open on the storm.')));
    assert.equal(f.records()[2].mes, 'AnswerRain found the broken roof.');
    assert.deepEqual(story.result.named, { cut: 'Answer'.length, length: 'AnswerRain found the broken roof.'.length });
    const guided = await f.run('guided.response', { intent: { prompt: { text: 'Reply as a list.', depth: 2, role: 'assistant', scan: true } },
        text: 'A list.', key: 'named-guided' });
    assert.ok(guided.calls.prompts[0].some(message => message.content.includes('Reply as a list.')));
    const extensions = readArtifact(f.dirs, guided.childId, 'roleplay-prompt-contributions').values.extensions;
    assert.deepEqual(extensions.map(prompt => [prompt.key, prompt.position, prompt.depth, prompt.role, prompt.scan]),
        [['guided_prompt', 1, 2, 'assistant', true]]);
    assert.equal(f.records().at(-1).mes, 'A list.');
});

test('a named workflow refuses a changed anchor, an unknown name, a missing instruction, a group turn and a stale key', async t => {
    const f = saved(t);
    const base = f.body('deep-swipe.reply', { intent: { instruction: 'A rumour.' }, anchor: { messageIndex: 1 } });
    const refuse = async (body, status) => assert.rejects(acceptRoleplayNamedWorkflow(f.request(), body), error => error.status === status);
    // The browser looked at a different message than the one the effect would write.
    await refuse({ ...base, messageRevision: f.revision('deep-swipe.reply', { messageIndex: 0 }) }, 409);
    await refuse({ ...base, name: 'guided.nope' }, 400);
    await refuse({ ...base, intent: {} }, 400);
    await refuse({ ...base, source: { locator: { ...f.locator, group: true } } }, 400);
    await refuse({ ...base, maxTokens: 9000 }, 400);
    await refuse({ ...base, key: 'x'.repeat(300) }, 400);
    await refuse({ ...base, extra: 1 }, 400);
    await refuse({ ...base, anchor: { messageIndex: 1, other: 2 } }, 400);
    await refuse({ ...base, acknowledgement: { account: 'someone-else', settingsRevision: 7 } }, 409);
    await refuse({ ...base, acknowledgement: { account: f.owner, settingsRevision: 8 } }, 409);
    // A named workflow answers one saved chat, so a missing one is refused too.
    await refuse({ ...base, source: { locator: { ...f.locator, chat: 'Missing' } } }, 404);
    assert.equal(f.records().length, 3);
    assert.equal(f.readback('named-never-accepted').accepted, false);
});

test('a named workflow record is the server own, and a tampered one is refused', () => {
    const guided = captureRoleplayNamedWorkflow('guided.swipe', { prompt: { text: 'Guided.', depth: 1, role: 'system', scan: true } });
    assert.equal(guided.effect, 'swipe');
    assert.equal(guided.anchor, 'last');
    assert.equal(guided.instruction, '');
    assert.equal(captureRoleplayNamedWorkflow('roleplay.reply').effect, 'append');
    assert.equal(captureRoleplayNamedWorkflow('roleplay.correct').effect, 'replace');
    assert.equal(captureRoleplayNamedWorkflow('deep-swipe.user', { instruction: 'Answer as them.' }).effect, 'alternative');
    assert.throws(() => assertRoleplayNamedWorkflow({ ...guided, effect: 'append' }), error => error.status === 409);
    assert.throws(() => assertRoleplayNamedWorkflow({ ...guided, prompt: { ...guided.prompt, depth: 2 } }), error => error.status === 409);
    assert.throws(() => assertRoleplayNamedWorkflow({ ...guided, hash: '0'.repeat(64) }), error => error.status === 409);
    assert.throws(() => captureRoleplayNamedWorkflow('guided.swipe', { prompt: { text: 'Guided.', depth: 1, role: 'system', scan: true }, extra: 1 }), error => error.status === 400);
    assert.throws(() => captureRoleplayNamedWorkflow('guided.swipe', { prompt: { text: 'Guided.', depth: 1, role: 'chief', scan: true } }), error => error.status === 400);
    assert.throws(() => captureRoleplayNamedWorkflow('story.passage', { prompt: { rules: 'Rules.' } }), error => error.status === 400);
    assert.throws(() => captureRoleplayNamedWorkflow('deep-swipe.user', { instruction: 'Handle {{user}} yourself.' }), error => error.status === 400);
    assert.deepEqual(roleplayWorkflowContributions(null, { history: [{ role: 'user', content: 'Earlier.' }] }),
        { extensions: [], history: [{ role: 'user', content: 'Earlier.' }], tools: [] });
    assert.deepEqual(roleplayWorkflowContributions(guided).extensions.map(prompt => prompt.key), ['guided_prompt']);
    assert.deepEqual(roleplayWorkflowContributions(captureRoleplayNamedWorkflow('story.passage',
        { prompt: { rules: 'Rules.', rulesDepth: 1, direction: 'Later.', directionDepth: 0 } })).extensions.map(prompt => prompt.key),
    ['story_rules', 'story_direction']);
    assert.deepEqual(roleplayWorkflowContributions(captureRoleplayNamedWorkflow('story.passage',
        { prompt: { rules: 'Rules.', rulesDepth: 1, direction: '', directionDepth: 0 } })).extensions.map(prompt => prompt.key),
    ['story_rules']);
    assert.deepEqual(roleplayWorkflowContributions(captureRoleplayNamedWorkflow('deep-swipe.reply',
        { instruction: 'Answer.' })).history, [{ role: 'user', content: 'Answer.' }]);
});

test('a finished named workflow is read back by key after a reopen, without a new job or a new charge', async t => {
    const f = saved(t);
    const { accepted, result } = await f.run('roleplay.swipe', { text: 'A third answer.', key: 'named-swipe' });
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other', 'A third answer.']);
    assert.equal(f.records()[2].swipe_id, 2);
    // A reopened page knows only the key, and reads the closed receipt.
    const reopened = f.readback('named-swipe');
    assert.equal(reopened.accepted, true);
    assert.equal(reopened.state, 'closed');
    assert.equal(reopened.jobId, accepted.jobId);
    assert.deepEqual(reopened.result, result);
    // The receipt, not the job, is the authority, so a pruned job still answers.
    fs.rmSync(path.join(f.dirs.root, 'jobs', 'index.json'));
    assert.equal(getJob(f.dirs, accepted.jobId), null);
    assert.deepEqual(f.readback('named-swipe').result, result);
    assert.equal(f.records()[2].swipe_id, 2);
});

test('a saved profile binding and a named record agree with the same source anchor, and a named workflow has no automatic policy', async t => {
    const f = saved(t);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    const profile = { kind: 'profile', ...captureChatProfile(f.dirs, 'active') };
    const named = captureRoleplayNamedWorkflow('roleplay.correct');
    const captured = captureRoleplayWorkflowRequest(f.scope, f.account, source, { avatar: 'Nova.png', binding: profile, maxTokens: 32, named });
    assert.equal(captured.effect, 'replace');
    assert.equal(captured.automatic, undefined);
    assert.equal(captured.named.hash, named.hash);
    const plain = captureRoleplayWorkflowRequest(f.scope, f.account, f.source(), { avatar: 'Nova.png', binding: profile, maxTokens: 32, effect: 'append' });
    assert.equal(plain.effect, 'append');
    assert.equal(plain.named, undefined);
    const { jobId } = admitRoleplayWorkflowJob(f.scope, f.account, { operationKey: 'named-profile', source, request: captured });
    releaseJob(f.dirs, jobId);
    const job = getJob(f.dirs, jobId);
    assert.equal(job.intent.request.named.name, 'roleplay.correct');
    assert.equal(job.intent.request.automatic, undefined);
    assert.equal(job.intent.request.worldInfo.global.promptEffect, 'replace');
    assert.equal(job.intent.request.worldInfo.global.trigger, 'regenerate');
});
