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
const { getJob, releaseJob, setJobState, requestCancellation, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
function_calling: true };

/** Every named workflow here uses a saved active connection, because that is what a browser names. */
function saved(t, { settingsRevision = 7, powerUser = null, mutate = null } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    mutate?.(f.records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        _settingsRevision: settingsRevision,
        ...(powerUser ? { power_user: powerUser } : {}),
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1',
            openai_max_context: 4096, openai_max_tokens: 512, function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'active', api: 'custom', model: 'fixture',
            preset: 'Main', 'api-url': 'http://127.0.0.1:18000/v1' }] } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const records = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const messages = () => records().slice(1);
    /**
     * The anchor the browser sends: the message the user was looking at, and
     * whether it was a deliberate pick rather than the chat's own final message.
     */
    const anchorFor = (name, anchor = {}) => {
        const list = messages();
        const kind = ROLEPLAY_WORKFLOW_NAMES[name].anchor;
        const index = anchor.messageIndex ?? (kind === 'end' ? list.length - 1
            : kind === 'block' ? list.findLastIndex(message => message.is_system !== true)
                : list.findLastIndex(message => message.is_user !== true && message.is_system !== true));
        return { messageIndex: index, chosen: anchor.chosen ?? kind === 'chosen' };
    };
    /** The browser's own message revision, proved again server-side. */
    const revision = (name, anchor = {}) => getRoleplaySourceMessageRevision(messages()[anchorFor(name, anchor).messageIndex]);
    const request = () => ({ user: { profile: { handle: f.scope.owner }, directories: dirs } });
    const body = (name, { intent = {}, anchor = anchorFor(name), key = `named-${name}`, messageRevision = revision(name, anchor), ...rest } = {}) =>
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
    async function run(name, { text = 'A named passage.', maxTokens = 64, beforeTurn = null,
        calls = { count: 0, prompts: [] }, ...submission } = {}) {
        const accepted = await acceptRoleplayNamedWorkflow(request(), body(name, { ...submission, maxTokens }));
        let childId = null;
        if (accepted.created) {
            setJobState(dirs, accepted.jobId, 'running');
            const waiting = await runRoleplayWorkflowJob(context(accepted.jobId));
            assert.equal(waiting.waiting, true);
            const pointer = readArtifact(dirs, accepted.jobId, 'roleplay-workflow-child');
            childId = pointer.jobId;
            setJobState(dirs, childId, 'running');
            beforeTurn?.();
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

for (const prepared of [false, true]) {
    test(`stopping a named reply ${prepared ? 'after' : 'before'} child preparation releases the chat without generating`, async t => {
        const f = saved(t);
        const before = f.records();
        const accepted = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply'));
        if (prepared) {
            updateJob(f.dirs, accepted.jobId, { state: 'running', attempt: 1 });
            await runRoleplayWorkflowJob({ owner: f.owner, directories: f.dirs, job: getJob(f.dirs, accepted.jobId),
                signal: new AbortController().signal });
        }
        requestCancellation(f.dirs, accepted.jobId, { reason: 'user_cancelled' });
        const receipt = f.readback(accepted.key);
        assert.equal(receipt.state, 'closed');
        assert.deepEqual(receipt.result, { cancelled: true, providerDispatched: false, chatChanged: false });
        assert.deepEqual(f.readback(accepted.key), receipt);
        assert.deepEqual(f.records(), before);
        const next = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply', { key: 'after-stop' }));
        assert.equal(next.created, true);
    });
}

test('a cancelled candidate that started keeps the chat busy until it stops, then the next reply is accepted', async t => {
    const f = saved(t);
    const accepted = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply'));
    updateJob(f.dirs, accepted.jobId, { state: 'running', attempt: 1 });
    const waiting = await runRoleplayWorkflowJob({ owner: f.owner, directories: f.dirs, job: getJob(f.dirs, accepted.jobId),
        signal: new AbortController().signal });
    updateJob(f.dirs, waiting.childJobId, { state: 'running', attempt: 1, startedAt: Date.now() });
    requestCancellation(f.dirs, accepted.jobId);
    assert.equal(f.readback(accepted.key).state, 'accepted');
    await assert.rejects(acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply', { key: 'while-running' })),
        { code: 'MEDIA_TARGET_BUSY', message: /Another reply for this chat is still being written/ });
    setJobState(f.dirs, waiting.childJobId, 'cancelled');
    const next = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply', { key: 'after-started-stop' }));
    assert.equal(next.created, true);
    const released = f.readback(accepted.key);
    assert.equal(released.state, 'closed');
    assert.deepEqual(released.result, { stopped: true, chatChanged: false });
});

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
        text: 'They say the tower fell.', anchor: { messageIndex: 1, chosen: true }, key: 'named-deep' });
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

test('guided regeneration replaces the reply without sending its old text or adding a swipe', async t => {
    const f = saved(t);
    const before = f.records();
    const target = before.findLast(record => record.is_user === false);
    const guided = await f.run('guided.regenerate', { intent: { prompt: {
        text: 'A different direction.', depth: 0, role: 'system', scan: true,
    } }, text: 'A fresh reply.', key: 'named-regenerate' });

    assert.equal(guided.result.status, 'completed');
    assert.equal(f.records().length, before.length);
    assert.deepEqual(guided.result.named, { replaced: true, length: 'A fresh reply.'.length });
    assert.equal(guided.calls.count, 1);
    assert.ok(guided.calls.prompts[0].some(message => message.content.includes('A different direction.')));
    assert.ok(guided.calls.prompts[0].every(message => !message.content.includes(target.mes)));
    const replacement = f.records().findLast(record => record.is_user === false);
    assert.equal(replacement.mes, 'A fresh reply.');
    assert.deepEqual(replacement.swipes ?? [replacement.mes], ['A fresh reply.']);
});

test('regeneration completes and releases the chat when the model repeats the saved wording', async t => {
    const f = saved(t);
    const before = f.records();
    const regenerated = await f.run('roleplay.correct', { text: 'Answer' });
    assert.equal(regenerated.result.status, 'completed');
    assert.deepEqual(regenerated.result.named, { replaced: true, length: 'Answer'.length });
    assert.equal(regenerated.calls.count, 1);
    assert.deepEqual(f.records().map(record => record.mes), before.map(record => record.mes));
    assert.equal(f.readback(regenerated.accepted.key).state, 'closed');
    const next = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.swipe', { key: 'after-repeated-wording' }));
    assert.equal(next.created, true);
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

test('saved message bookkeeping from the page and extensions does not stop a reply, but a legacy attachment field still does', async t => {
    const bookkeeping = records => {
        for (const record of records.slice(1)) {
            Object.assign(record, { continueHistory: [{ mes: record.mes, swipes: [record.mes] }], continueSwipeId: 0, continueSwipe: [record.mes], present: [1] });
            record.extra = { ...record.extra, reasoning: 'A thought.', reasoning_type: 'parsed', reasoning_collapsed: true,
                qvink_memory: { remember: true }, rpg_companion_swipes: {} };
        }
    };
    const guide = { prompt: { text: 'Reply as a list.', depth: 2, role: 'system', scan: true } };
    for (const [name, intent] of [['roleplay.reply', {}], ['guided.response', guide], ['guided.swipe', guide]]) {
        const f = saved(t, { mutate: bookkeeping });
        const { calls } = await f.run(name, { intent, text: 'A list.', key: `named-bookkeeping-${name}` });
        assert.equal(calls.count, 1, name);
        assert.ok(calls.prompts[0].some(message => message.role === 'user' && message.content === 'Original'), name);
    }
    const legacy = saved(t, { mutate: records => { records[2].extra = { ...records[2].extra, image: 'data:image/png;base64,AAAA' }; } });
    const calls = { count: 0, prompts: [] };
    await assert.rejects(legacy.run('guided.response', { intent: guide, calls, key: 'named-legacy-image' }),
        { code: 'ROLEPLAY_INVALID', message: /non-text content/ });
    assert.equal(calls.count, 0);
});

test('a named workflow refuses a changed anchor, an unknown name, a missing instruction, a group turn and a stale key', async t => {
    const f = saved(t);
    const base = f.body('deep-swipe.reply', { intent: { instruction: 'A rumour.' }, anchor: { messageIndex: 1, chosen: true } });
    const refuse = async (body, status) => assert.rejects(acceptRoleplayNamedWorkflow(f.request(), body), error => error.status === status);
    // The browser looked at a different message than the one the effect would write.
    await refuse({ ...base, messageRevision: f.revision('deep-swipe.reply', { messageIndex: 0 }) }, 409);
    await refuse({ ...base, name: 'guided.nope' }, 400);
    await refuse({ ...base, intent: {} }, 400);
    await refuse({ ...base, source: { locator: { ...f.locator, group: true } } }, 400);
    await refuse({ ...base, maxTokens: 64001 }, 400);
    await refuse({ ...base, key: 'x'.repeat(300) }, 400);
    await refuse({ ...base, extra: 1 }, 400);
    await refuse({ ...base, anchor: { messageIndex: 1, chosen: true, other: 2 } }, 400);
    // A chosen workflow needs the user's own pick, and a chat-owned one refuses it.
    await refuse({ ...base, anchor: { messageIndex: 1, chosen: false } }, 400);
    await refuse(f.body('roleplay.reply', { anchor: { messageIndex: 1, chosen: true } }), 400);
    await refuse(f.body('roleplay.reply', { anchor: { messageIndex: 1 } }), 400);
    await refuse(f.body('roleplay.reply', { anchor: { messageIndex: -1, chosen: false } }), 400);
    // A chat-owned workflow answers the chat's own final message, so a stale index is refused.
    await refuse(f.body('roleplay.reply', { anchor: { messageIndex: 0, chosen: false } }), 409);
    await refuse(f.body('roleplay.swipe', { anchor: { messageIndex: 0, chosen: false } }), 409);
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
    assert.equal(guided.anchor, 'assistant');
    assert.equal(guided.instruction, '');
    assert.equal(captureRoleplayNamedWorkflow('roleplay.reply').effect, 'append');
    assert.equal(captureRoleplayNamedWorkflow('story.passage',
        { prompt: { rules: 'Rules.', rulesDepth: 1, direction: '', directionDepth: 0 } }).anchor, 'block');
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

test('a named workflow with no stated token limit takes one the saved context can hold, and a stale acknowledgement is named', async t => {
    const f = saved(t);
    const { accepted } = await f.run('roleplay.reply', { maxTokens: null, text: 'A bounded reply.' });
    // The fixture's saved context is 4096, so the derived limit leaves room for it.
    assert.equal(getJob(f.dirs, accepted.jobId).intent.request.maxTokens, 512);
    assert.equal(getJob(f.dirs, accepted.jobId).intent.request.worldInfo.maxContext, 4096 - 512);
    await assert.rejects(acceptRoleplayNamedWorkflow(f.request(),
        f.body('roleplay.reply', { key: 'named-stale-ack', acknowledgement: { account: f.owner, settingsRevision: 8 } })),
    error => error.status === 409 && error.apiError === 'roleplay_settings_ack_required');
});

test('page prompt additions travel with the named record, reach the provider and are refused when malformed', async t => {
    const f = saved(t);
    const page = [
        { key: '1_memory', content: 'Summary so far.', position: 0, depth: 0, role: 'system' },
        { key: 'dialogue-colors', content: 'Colour Nova in teal.', position: 1, depth: 0, role: 'system' },
    ];
    const { accepted, calls, result } = await f.run('roleplay.reply', { intent: { page }, text: 'A coloured reply.' });
    assert.equal(result.status, 'completed');
    assert.deepEqual(getJob(f.dirs, accepted.jobId).intent.request.named.page, page);
    const sent = calls.prompts[0].map(message => message.content).join('\n');
    assert.match(sent, /Summary so far\./);
    assert.match(sent, /Colour Nova in teal\./);
    // Page prompts are published on every turn under their own prefix, after the named slots.
    const contributions = roleplayWorkflowContributions(captureRoleplayNamedWorkflow('guided.response',
        { prompt: { text: 'Guide.', depth: 1, role: 'system', scan: true }, page }));
    assert.deepEqual(contributions.extensions.map(prompt => [prompt.key, prompt.scan]),
        [['guided_prompt', true], ['page_1_memory', false], ['page_dialogue-colors', false]]);
    const refuse = (intent, label) => assert.throws(() => captureRoleplayNamedWorkflow('roleplay.reply', intent),
        error => error.status === 400, label);
    refuse({ page: [page[1], page[0]] }, 'unsorted');
    refuse({ page: [page[0], page[0]] }, 'duplicate');
    refuse({ page: [{ ...page[0], content: 'Roll {{roll:d6}}' }] }, 'macro');
    refuse({ page: [{ ...page[0], role: 'narrator' }] }, 'role');
    refuse({ page: [{ ...page[0], position: 3 }] }, 'position');
    refuse({ page: [{ ...page[0], key: 'a b' }] }, 'key');
    refuse({ page: [{ ...page[0], scan: true }] }, 'extra field');
    refuse({ page: Array.from({ length: 33 }, (_, index) => ({ ...page[0], key: `k${String(index).padStart(2, '0')}` })) }, 'count');
    const tampered = captureRoleplayNamedWorkflow('roleplay.reply', { page });
    assert.throws(() => assertRoleplayNamedWorkflow({ ...tampered, page: [page[0]] }), error => error.status === 409);
    assert.throws(() => assertRoleplayNamedWorkflow({ ...captureRoleplayNamedWorkflow('roleplay.reply'), page: [] }), error => error.status === 409);
});

test('plain Roleplay controls keep saved automatic continuations, and bounded named workflows never capture them', async t => {
    const f = saved(t, { powerUser: { auto_continue: { enabled: true, allow_chat_completions: true, target_length: 400 } } });
    const plain = await acceptRoleplayNamedWorkflow(f.request(), f.body('roleplay.reply', { key: 'named-auto', maxTokens: 64 }));
    assert.ok(getJob(f.dirs, plain.jobId).intent.request.automatic);
    // A busy chat never absorbs a second intent, so the bounded workflow uses its own chat.
    const g = saved(t, { powerUser: { auto_continue: { enabled: true, allow_chat_completions: true, target_length: 400 } } });
    const guided = await acceptRoleplayNamedWorkflow(g.request(), g.body('guided.swipe', { key: 'named-guided-auto', maxTokens: 64,
        intent: { prompt: { text: 'Guide.', depth: 1, role: 'system', scan: true } } }));
    assert.equal(getJob(g.dirs, guided.jobId).intent.request.automatic, undefined);
});

test('a routine page save after acceptance keeps the reply, and a real settings change still stops it before paying', async t => {
    const f = saved(t);
    const file = path.join(f.dirs.root, 'settings.json');
    const edit = change => fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
    // Input history, the save counters and the Conversation store change on ordinary page saves.
    const { result } = await f.run('roleplay.reply', { text: 'Kept through a page save.', beforeTurn: () => edit(settings => ({
        ...settings, _version: 11, _settingsRevision: settings._settingsRevision + 1,
        accountStorage: { 'st--inputHistory': '["Where are you?"]' },
        extension_settings: { ...settings.extension_settings, neconyan_conversation: { characters: { nova: { branches: {} } } } },
    })) });
    assert.equal(result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'Kept through a page save.');

    const g = saved(t);
    const other = path.join(g.dirs.root, 'settings.json');
    const calls = { count: 0, prompts: [] };
    await assert.rejects(g.run('roleplay.reply', { calls, beforeTurn: () => {
        const settings = JSON.parse(fs.readFileSync(other, 'utf8'));
        settings.oai_settings.openai_max_context = 2048;
        fs.writeFileSync(other, JSON.stringify(settings));
    } }), error => error.code === 'ROLEPLAY_SOURCE_CHANGED');
    assert.equal(calls.count, 0);
    assert.equal(g.records().length, 3);
});
