/* eslint playwright/expect-expect: off -- Node assertions exercise saved prompt assembly. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { injectChatPromptDepth } = await import('../public/scripts/chat-prompt-depth.js');
const { loadCurrentStateSync } = await import('../src/mewmory/sources.js');
const { mutateState } = await import('../src/mewmory/store.js');
const { putRecord, validateRecord } = await import('../src/mewmory/core.js');
const { withRoleplayAccount } = await import('../src/roleplay-store.js');

function promptJob(t, prompts, order, settings = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify(settings));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'prompt-assembly', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: captureRoleplayWorldInfo(f.scope, account, source,
                { avatar: 'Nova.png', maxContext: 200 }) } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    const options = {
        contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { prompts, prompt_order: [{ character_id: 100001,
            order: order.map(identifier => ({ identifier, enabled: true })) }] } }),
    };
    return { f, context, run: generate => runRoleplayReplyJob(context, { ...options, generate }) };
}

async function promptFor(t, prompts, order, settings = {}) {
    const job = promptJob(t, prompts, order, settings);
    let result;
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        result = messages;
        return { text: 'Saved result' };
    });
    return result;
}

const main = { identifier: 'main', role: 'system', system_prompt: true, content: 'Main' };
const history = { identifier: 'chatHistory', marker: true, system_prompt: true };

test('saved custom prompts keep their roles and positions on both sides of history', async t => {
    const messages = await promptFor(t, [main, history,
        { identifier: 'before', role: 'assistant', system_prompt: false, content: 'Before {{char}}' },
        { identifier: 'after', role: 'user', system_prompt: false, content: 'After {{user}}' },
    ], ['before', 'main', 'chatHistory', 'after']);
    assert.deepEqual(messages, [
        { role: 'assistant', content: 'Before Nova' }, { role: 'system', content: 'Main' },
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'After User' },
    ]);
});

test('saved depth prompts combine by priority and role before the selected history message', async t => {
    const messages = await promptFor(t, [main, history,
        { identifier: 'near', role: 'system', system_prompt: false, content: 'Near',
            injection_position: 1, injection_depth: 1, injection_order: 10 },
        { identifier: 'far', role: 'system', system_prompt: false, content: 'Far',
            injection_position: 1, injection_depth: 1, injection_order: 100 },
    ], ['main', 'near', 'far', 'chatHistory']);
    assert.deepEqual(messages.map(message => message.content), ['Main', 'Original', 'Near', 'Far', 'Answer']);
});

test('saved Author note is included even when no lore entry targets it', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { note: { default: 'Remember the rain', defaultInterval: 1, defaultDepth: 0 } },
    });
    assert.deepEqual(messages.map(message => message.content), ['Main', 'Original', 'Answer', 'Remember the rain']);
});

test('inactive notes stay absent and depth personas use their saved role and depth', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { note: { default: 'Inactive note', defaultInterval: 2 } },
        power_user: { persona_description: 'Visiting astronomer', persona_description_position: 4,
            persona_description_depth: 1, persona_description_role: 1 },
    });
    assert.deepEqual(messages, [{ role: 'system', content: 'Main' }, { role: 'user', content: 'Original' },
        { role: 'user', content: 'Visiting astronomer' }, { role: 'assistant', content: 'Answer' }]);
});

test('prompt macros use saved card and variables instead of supplied page values', async t => {
    const job = promptJob(t, [{ ...main, content: '{{description}} / {{getvar::weather}}' }, history], ['main', 'chatHistory']);
    job.context.job.intent.request.macros = { character: { description: 'Forged' }, variables: { local: { weather: 'forged' } } };
    await job.run(async ({ messages }) => {
        assert.equal(messages[0].content, 'Original / ');
        return { text: 'Saved result' };
    });
});

test('the fully assembled prompt is durable before dispatch and reused on a preparation retry', async t => {
    const job = promptJob(t, [{ ...main, content: '{{random::one::two::three}}' }, history], ['main', 'chatHistory']);
    let prepared;
    await assert.rejects(job.run(async ({ messages }) => {
        prepared = structuredClone(messages);
        assert.deepEqual(readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt').messages, prepared);
        throw new Error('Stopped before provider dispatch');
    }), /Stopped before provider dispatch/);
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages, prepared);
        return { text: 'Saved result' };
    });
});

test('damaged prompt evidence refuses instead of rebuilding a possibly dispatched request', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    await assert.rejects(job.run(async () => { throw new Error('Preparation checkpoint'); }), /Preparation checkpoint/);
    const prepared = readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt');
    prepared.messages[0].content = 'Changed on disk';
    writeArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt', prepared);
    await assert.rejects(job.run(async () => { assert.fail('Provider must stay idle'); }), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
});

test('prepared prompt retries retain request-local macro variables for provider formatting', async t => {
    const job = promptJob(t, [{ ...main, content: '{{setvar::weather::rain}}Main' }, history], ['main', 'chatHistory']);
    await assert.rejects(job.run(async ({ macroEnvironment }) => {
        assert.equal(macroEnvironment.evaluate('{{getvar::weather}}', { legacy: true }), 'rain');
        throw new Error('Before provider formatting');
    }), /Before provider formatting/);
    await job.run(async ({ macroEnvironment }) => {
        assert.equal(macroEnvironment.evaluate('{{getvar::weather}}', { legacy: true }), 'rain');
        return { text: 'Saved result' };
    });
});

test('shared depth placement retains Agent inspection data and does not mutate source history', async () => {
    const messages = [{ role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Question' }];
    const result = await injectChatPromptDepth([{ role: 'system', content: 'Agent', injection_depth: 1 }], messages, {
        maxDepth: 1, describePrompt: () => [{ identifier: 'agent', content: 'Agent' }],
        extensionAt: (depth, role) => depth === 1 && role === 'system'
            ? { content: 'Tracker', contributions: [{ identifier: 'tracker', content: 'Tracker' }] } : null,
    });
    assert.deepEqual(result.map(message => message.content), ['Question', 'Agent\nTracker', 'Answer']);
    assert.deepEqual(result[1].agentContributions.map(item => item.identifier), ['agent', 'tracker']);
    assert.equal(result[1].injected, true);
    assert.deepEqual(messages.map(message => message.content), ['Answer', 'Question']);
});

function enableMemory(job) {
    const { f } = job;
    withRoleplayAccount(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, () => {
        loadCurrentStateSync(f.scope.directories, f.locator);
        mutateState(f.scope.directories, f.locator, state => {
            state.enabled = true;
            const record = validateRecord(state, { id: 'event:original', kind: 'event', text: 'The Original parcel was blue.',
                refs: [state.timeline[0]], subjectIds: ['parcel'], evidenceStatus: 'established' },
            { asOf: 0, origin: 'objective_extractor' });
            putRecord(state, record, { automatic: true });
        });
    });
}

test('saved Mewmory context is assembled natively and retained outside Prompt Manager markers', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    enableMemory(job);
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.match(messages.at(-1).content, /The Original parcel was blue/);
        assert.deepEqual(messages.slice(0, 3).map(message => message.content), ['Main', 'Original', 'Answer']);
        const memory = readArtifact(job.context.directories, job.context.job.id, 'roleplay-mewmory');
        assert.equal(memory.enabled, true);
        assert.equal(memory.inspection.status, 'local');
        return { text: 'Saved result' };
    });
});

test('Mewmory changes during preparation refuse dispatch and retain the earlier prompt evidence', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    enableMemory(job);
    await assert.rejects(job.run(async ({ beforeDispatch }) => {
        withRoleplayAccount(job.f.scope, { accountId: job.f.scope.accountId, dataEpoch: job.f.scope.dataEpoch }, () => {
            mutateState(job.context.directories, job.f.locator, state => { state.enabled = false; });
        });
        beforeDispatch();
        assert.fail('Provider must stay idle');
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.ok(readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt'));
    await assert.rejects(job.run(async () => assert.fail('Provider must stay idle')), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('enabled Mewmory refuses a disabled history marker instead of discarding retained history', async t => {
    const job = promptJob(t, [main], ['main']);
    enableMemory(job);
    await assert.rejects(job.run(async () => assert.fail('Provider must stay idle')), /Mewmory needs.*Chat History/);
});
