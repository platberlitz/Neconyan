import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/custom-css.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { providerStep } = await import('../src/jobs/artifacts.js');

function prepared(t, css = '.old { color: red; }') {
    const f = fixture(t, false, 'fixture');
    const directories = f.scope.directories;
    const settingsPath = path.join(directories.root, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ name1: 'User', main_api: 'openai', _version: 3, _settingsRevision: 5,
        power_user: { custom_css: css, other: 'kept' },
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4o' } }, null, 4));
    const base = { owner: 'fixture', directories };
    const request = { user: { profile: { handle: 'fixture' }, directories } };
    const context = job => ({ ...base, job: getJob(directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const settings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const write = next => fs.writeFileSync(settingsPath, JSON.stringify(next, null, 4));
    return { base, request, context, settings, write };
}

const body = (key, mode = 'append') => ({ key, kind: 'custom-css', instruction: 'Rounder buttons', mode, profileId: 'saved', paletteSnapshot: '--neco-ink: #222;' });

test('one accepted CSS job saves into settings after the page is gone and never asks the model twice', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, body('css'));
    let calls = 0;
    const generate = async options => {
        calls++;
        assert.match(options.messages[1].content, /Rounder buttons/);
        assert.match(options.messages[1].content, /\.old \{ color: red; \}/);
        assert.match(options.messages[1].content, /--neco-ink: #222;/);
        return { text: '```css\n.button { border-radius: 12px; }\n```' };
    };
    await runOperation(p.context(accepted.job), { generate });
    const saved = p.settings();
    assert.equal(saved.power_user.custom_css, '.old { color: red; }\n\n.button { border-radius: 12px; }');
    assert.equal(saved.power_user.other, 'kept');
    assert.equal(saved._version, 4);
    const record = readOperation(p.base, 'css');
    assert.deepEqual([record.result.applied, record.result.previousVersion, record.result.version], [true, 3, 4]);
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, body('css'));
    assert.equal(again.job, null);
    assert.equal(again.record.state, 'completed');
    assert.equal(calls, 1);
});

test('an unknown model result is never sent again and leaves settings untouched', async t => {
    const p = prepared(t);
    const before = p.settings();
    const accepted = await acceptApplicationOperation(p.request, body('unknown'));
    let calls = 0;
    const generate = options => providerStep(options.jobContext, options.stepNamespace, async () => { calls++; throw new Error('connection lost'); });
    await assert.rejects(runOperation(p.context(accepted.job), { generate }), /connection lost/);
    await assert.rejects(runOperation(p.context(accepted.job), { generate }), /unknown/i);
    assert.equal(calls, 1);
    assert.deepEqual(p.settings(), before);
});

test('newer CSS edits win and the generated CSS stays in the saved result', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, body('edited', 'replace'));
    const generate = async () => {
        const current = p.settings();
        p.write({ ...current, power_user: { ...current.power_user, custom_css: '.mine {}' }, _version: 4 });
        return { text: '.generated {}' };
    };
    await runOperation(p.context(accepted.job), { generate });
    assert.equal(p.settings().power_user.custom_css, '.mine {}');
    const record = readOperation(p.base, 'edited');
    assert.deepEqual([record.state, record.result.applied, record.result.css], ['completed', false, '.generated {}']);
});

test('a lost acknowledgement after saving finishes without overwriting later edits', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, body('lost', 'replace'));
    const generate = async () => ({ text: '.generated {}' });
    await assert.rejects(runOperation(p.context(accepted.job), { generate, afterCustomCssPublication: () => { throw new Error('Simulated lost acknowledgement'); } }), /lost acknowledgement/);
    assert.equal(p.settings().power_user.custom_css, '.generated {}');
    const current = p.settings();
    p.write({ ...current, power_user: { ...current.power_user, custom_css: '.later {}' }, _version: current._version + 1 });
    await runOperation(p.context(accepted.job), { generate: async () => { throw new Error('must not ask again'); } });
    assert.equal(p.settings().power_user.custom_css, '.later {}');
    assert.equal(readOperation(p.base, 'lost').state, 'completed');
});
