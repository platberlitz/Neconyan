/* eslint playwright/expect-expect: off -- Node assertions exercise native text prompts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');

const instruct = { enabled: true, wrap: false, names_behavior: 'none', input_sequence: '<U>', output_sequence: '<A>',
    first_input_sequence: '<FIRST>', last_input_sequence: '<LAST>', last_output_sequence: '<NEXT>',
    input_suffix: '</U>', output_suffix: '</A>', story_string_prefix: '<S>', story_string_suffix: '</S>' };

function textJob(t, effect = 'append', { contextLimit = 512, instruction = instruct, extraSettings = {}, power = {}, bias, model = 'fixture' } = {}) {
    const f = fixture(t);
    f.records[1].extra = bias ? { bias } : {};
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        ...extraSettings, main_api: 'textgenerationwebui', active_generation: { api: 'textgenerationwebui', source: 'llamacpp', model, serverUrl: 'http://127.0.0.1:6000' },
        max_context: contextLimit, textgenerationwebui_settings: { type: 'llamacpp', api_server: 'http://127.0.0.1:6000',
            server_urls: { llamacpp: 'http://127.0.0.1:6000' } },
        power_user: { tokenizer: 1, custom_stopping_strings: '[]', instruct: instruction,
            context: { story_string: '{{description}}', story_string_position: 0 }, ...power },
    }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator, ...(effect === 'continue' ? { message: 1 } : {}) });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const request = { binding, serverPrompt: true, messages: [], maxTokens: 20, characterName: 'Nova',
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png',
            maxContext: contextLimit - 20, trigger: effect === 'append' ? 'normal' : effect, serverPrompt: true }) };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'text-prompt', effect, source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), owner: f.scope.owner, directories: f.scope.directories,
        signal: new AbortController().signal };
    return { f, context, run: fetch => runRoleplayReplyJob(context, { generate: options => runChatProfile({ ...options, fetch }) }) };
}

for (const effect of ['append', 'continue']) test(`native text ${effect} sends the fully formatted saved prompt exactly once`, async t => {
    const job = textJob(t, effect);
    let calls = 0;
    await job.run(async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        const expected = '<S>Original</S><LAST>Original</U>' + (effect === 'continue' ? '<NEXT>Answer' : '<A>Answer</A><NEXT>');
        assert.equal(request.prompt, expected);
        assert.equal(readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt').preparedText, expected);
        return new Response(JSON.stringify({ content: 'Finished' }));
    });
    await job.run(async () => assert.fail('A durable result must not call the provider again'));
    assert.equal(calls, 1);
    assert.ok(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes.includes('Finished'));
});

test('native text saves the reply when the connection has no model name', async t => {
    const job = textJob(t, 'append', { model: '' });
    let provided;
    await runRoleplayReplyJob(job.context, { generate: async options => {
        provided = await runChatProfile({ ...options, fetch: async () => new Response(JSON.stringify({ content: 'Unnamed model reply' })) });
        return provided;
    } });
    // Saved candidates are hashed as plain JSON, so the provider result must survive a JSON round trip.
    assert.deepEqual(JSON.parse(JSON.stringify(provided.generation)), provided.generation);
    assert.equal(Object.hasOwn(provided.generation, 'model'), false);
    assert.ok(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes.includes('Unnamed model reply'));
});

test('instruct sequence overhead is budgeted before any paid request', async t => {
    const job = textJob(t, 'append', { contextLimit: 120, instruction: { ...instruct, story_string_prefix: 'Long prefix '.repeat(200) } });
    await assert.rejects(job.run(async () => assert.fail('The oversized prompt must not reach the provider')), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes, 'Answer');
});

test('a restarted worker delivers a known result after the saved connection is removed', async t => {
    const job = textJob(t);
    const counter = path.join(job.f.root, 'provider-calls');
    const script = `
        import fs from 'node:fs';
        const input = JSON.parse(process.argv[1]);
        const { setConfigFilePath } = await import(${JSON.stringify(new URL('../src/util.js', import.meta.url).href)});
        setConfigFilePath(${JSON.stringify(fileURLToPath(new URL('../default/config.yaml', import.meta.url)))});
        const { getJob } = await import(${JSON.stringify(new URL('../src/jobs/store.js', import.meta.url).href)});
        const { runRoleplayReplyJob } = await import(${JSON.stringify(new URL('../src/generation/roleplay-execution.js', import.meta.url).href)});
        const { runChatProfile } = await import(${JSON.stringify(new URL('../src/generation/service.js', import.meta.url).href)});
        const context = { ...input, job: getJob(input.directories, input.jobId), signal: new AbortController().signal };
        await runRoleplayReplyJob(context, { generate: async options => {
            await runChatProfile({ ...options, fetch: async () => {
                fs.writeFileSync(input.counter, '1');
                return new Response(JSON.stringify({ content: 'Known result after restart' }));
            } });
            process.exit(73);
        } });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({
        owner: job.context.owner, directories: job.context.directories, jobId: job.context.job.id, counter,
    })], { encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr || child.stdout);
    assert.equal(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes, 'Answer');
    assert.equal(readArtifact(job.context.directories, job.context.job.id, 'roleplay-output'), undefined);
    fs.unlinkSync(path.join(job.context.directories.root, 'settings.json'));
    await job.run(async () => assert.fail('A known provider result must survive removal of the connection'));
    assert.equal(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes, 'Known result after restart');
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
});

test('saved guidance compiles both complete prompts and preserves reply bias through replay', async t => {
    const job = textJob(t, 'append', { bias: 'Saved bias', extraSettings: {
        extension_settings: { cfg: { global: { guidance_scale: 2, positive_prompt: 'Good {{char}}', negative_prompt: 'Bad {{char}}' } } },
    } });
    await job.run(async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.guidance_scale, 2);
        assert.match(request.prompt, /Good Nova\n<A>Answer<\/A><NEXT>Saved bias$/);
        assert.match(request.negative_prompt, /Bad Nova/);
        assert.match(request.negative_prompt, /<S>Original<\/S>/);
        assert.match(request.prompt, /Saved bias/);
        return new Response(JSON.stringify({ content: 'Finished guidance' }));
    });
    await job.run(async () => assert.fail('Completed guidance must not repeat'));
});
