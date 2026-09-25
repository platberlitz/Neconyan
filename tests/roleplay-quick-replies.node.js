/* eslint playwright/expect-expect: off -- Node assertions exercise saved automatic Quick Reply actions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: 'Colour: {{getvar::color}}' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, commands, { linked = true } = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records[0].chat_metadata ??= {};
    f.records[0].chat_metadata.variables = { score: 2 };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const dirs = f.scope.directories;
    dirs.worlds = path.join(dirs.root, 'worlds');
    dirs.quickreplies = path.join(dirs.root, 'QuickReplies');
    fs.mkdirSync(dirs.worlds);
    fs.mkdirSync(dirs.quickreplies);
    fs.writeFileSync(path.join(dirs.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: { uid: 1, key: ['Original'], content: 'The safe harbour.', position: 0, automationId: 'qr-one' },
    } }));
    fs.writeFileSync(path.join(dirs.quickreplies, 'Actions.json'), JSON.stringify({ name: 'Actions', version: 2,
        qrList: commands.map((message, index) => ({ id: index + 1, automationId: 'qr-one', message })) }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture',
            'api-url': 'http://127.0.0.1:18000/v1' }] }, quickReplyV2: { isEnabled: true,
            config: { setList: linked ? [{ set: 'Actions' }] : [] } } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    const binding = { kind: 'profile', ...captureChatProfile(dirs, 'main') };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'quick-reply-native', effect: 'append', source,
        request: { binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] } });
    releaseJob(dirs, jobId);
    const context = () => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal });
    const run = generate => runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }), generate });
    return { f, dirs, account, worldInfo, source, jobId, context, run };
}

test('linked saved variable actions affect the bound prompt and commit with the reply only once', async t => {
    const f = prepared(t, ['/setvar key=color green', '/addvar key=score 3', '/getvar key=color']);
    let calls = 0;
    await f.run(async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        calls++;
        assert.match(JSON.stringify(messages), /green/);
        const during = readRoleplayChat(f.f.scope, f.f.locator).records;
        assert.equal(during[0].chat_metadata.variables.score, 2);
        assert.equal(during[0].chat_metadata.variables.color, undefined);
        return { text: 'Safe reply' };
    });
    assert.equal(calls, 1);
    const records = readRoleplayChat(f.f.scope, f.f.locator).records;
    assert.equal(records[0].chat_metadata.variables.score, 5);
    assert.equal(records[0].chat_metadata.variables.color, 'green');
    assert.equal(records.at(-1).mes, 'Safe reply');
    const saved = readArtifact(f.dirs, f.jobId, 'roleplay-quick-replies');
    assert.deepEqual(saved.results.map(result => result.value), ['green', 5, 'green']);
    await f.run(() => { throw Error('A saved reply must not pay twice.'); });
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'Safe reply');
});

test('unsupported browser Quick Reply commands refuse before paying or changing the chat', async t => {
    for (const command of ['/setglobalvar key=color green', 'ordinary browser composer text', '/setvar key=x {{char}}']) {
        const f = prepared(t, [command]);
        let paid = false;
        await assert.rejects(f.run(() => { paid = true; return { text: 'Not allowed' }; }),
            { code: 'ROLEPLAY_QUICK_REPLY_UNSUPPORTED' });
        assert.equal(paid, false);
        const records = readRoleplayChat(f.f.scope, f.f.locator).records;
        assert.equal(records[0].chat_metadata.variables.color, undefined);
        assert.equal(records.at(-1).mes, 'Answer');
    }
});

test('a replaced saved Quick Reply script refuses before the model can pay', async t => {
    const f = prepared(t, ['/setvar key=color green']);
    const name = path.join(f.dirs.quickreplies, 'Actions.json');
    const replacement = path.join(f.dirs.quickreplies, 'other.json');
    fs.writeFileSync(replacement, fs.readFileSync(name));
    fs.renameSync(replacement, name);
    let paid = false;
    await assert.rejects(f.run(() => { paid = true; return { text: 'Unsafe' }; }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(paid, false);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records[0].chat_metadata.variables.color, undefined);
});

test('an unknown paid reply retains the frozen variable plan without applying it or paying again', async t => {
    const f = prepared(t, ['/setvar key=color green']);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const step = roleplayHash(['uncertain-quick-reply-main', f.jobId]);
    let paid = 0;
    const lost = async ({ onProviderStep, beforeDispatch, jobContext }) => {
        onProviderStep(`provider:${step}`);
        return providerStep(jobContext, step, async () => { beforeDispatch(); paid++; throw Error('Reply outcome lost'); });
    };
    await assert.rejects(f.run(lost), /Reply outcome lost/);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-quick-replies').local.color, 'green');
    recoverJobs(f.dirs);
    assert.equal(getJob(f.dirs, f.jobId).state, 'interrupted');
    await assert.rejects(f.run(lost), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(paid, 1);
    const records = readRoleplayChat(f.f.scope, f.f.locator).records;
    assert.equal(records[0].chat_metadata.variables.color, undefined);
    assert.equal(records.at(-1).mes, 'Answer');
});

test('a damaged saved action proof cannot commit the reply or its variables', async t => {
    const f = prepared(t, ['/setvar key=color green']);
    await assert.rejects(f.run(async ({ beforeDispatch }) => {
        beforeDispatch();
        const original = readArtifact(f.dirs, f.jobId, 'roleplay-quick-replies');
        writeArtifact(f.dirs, f.jobId, 'roleplay-quick-replies', { ...original, local: { color: 'corrupt' } });
        return { text: 'Unsafe' };
    }), { code: 'ROLEPLAY_QUICK_REPLY_RECOVERY' });
    const records = readRoleplayChat(f.f.scope, f.f.locator).records;
    assert.equal(records[0].chat_metadata.variables.color, undefined);
    assert.equal(records.at(-1).mes, 'Answer');
});
