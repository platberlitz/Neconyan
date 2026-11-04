import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { saveCreatorDraft, getCreatorDraft } from '../src/creator/store.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';
import { startCreatorConversion } from '../public/scripts/creator/conversion.js';
import { importCreatorServerProposal, recoverCreatorServerReply } from '../public/scripts/creator/server-generation.js';
const { acceptCreatorGeneration, runCreatorGeneration, creatorGenerationStatus } = await import('../src/creator/generation.js');
const { setJobState } = await import('../src/jobs/store.js');

function setup(t, configure = () => {}) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        _settingsRevision: 1, main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture' },
    }));
    const draft = createCreatorDraft({ id: 'writing' });
    draft.dossier = 'Mira repairs ships for {{user}}.';
    configure(draft);
    draft.proposals.push(startCreatorConversion(draft, ['name', 'description']));
    const saved = withRoleplayAccount(f.scope, null, lease => saveCreatorDraft(lease, draft, null));
    const request = { id: draft.id, expectedRevision: saved.revision, proposalId: draft.proposals[0].id, submissionKey: 'writing-one', acknowledgement: { settingsRevision: 1 } };
    const job = acceptCreatorGeneration(f.scope, request).job;
    const controller = new AbortController();
    const context = { directories: f.scope.directories, owner: job.owner, job, signal: controller.signal, progress: async () => {} };
    const status = () => creatorGenerationStatus(f.scope, { id: draft.id, jobId: job.id });
    return { ...f, draft, saved, request, job, controller, context, status };
}

test('Catelier runs every saved step without a page, preserves literals and never overwrites the draft', async t => {
    const f = setup(t);
    let calls = 0;
    await runCreatorGeneration(f.context, { generate: async options => {
        calls++;
        const source = JSON.parse(options.messages[1].content);
        assert.match(source.dossier, /\{\{user\}\}/);
        assert.equal(options.preparedMessages, true);
        return { text: JSON.stringify({ fields: calls === 1 ? { name: 'Mira' } : { description: 'A shipwright.' } }) };
    } });
    assert.equal(calls, 2);
    assert.equal(f.status().result.proposal.plan.next, 2);
    assert.equal(f.status().result.complete, true);
    assert.deepEqual(withRoleplayAccount(f.scope, null, lease => getCreatorDraft(lease, f.draft.id)), f.saved);
    await runCreatorGeneration(f.context, { generate: () => assert.fail('Completed work must not call the provider twice') });
    const recovered = structuredClone(f.draft);
    importCreatorServerProposal(recovered, f.status().result);
    assert.equal(recovered.card.data.description, '');
    assert.equal(recovered.proposals[0].changes[1].after, 'A shipwright.');
    assert.throws(() => importCreatorServerProposal(recovered, f.status().result), /changed/);
    const changed = structuredClone(f.draft); changed.dossier = 'New source';
    assert.throws(() => importCreatorServerProposal(changed, f.status().result), /Dossier/);
});

test('Catelier retains finished steps on failure and resumes only the unfinished step', async t => {
    const f = setup(t);
    let calls = 0;
    await assert.rejects(runCreatorGeneration(f.context, { generate: async () => {
        if (++calls === 2) throw new Error('Provider unavailable');
        return { text: '{"fields":{"name":"Mira"}}' };
    } }), /Provider unavailable/);
    assert.equal(f.status().result.proposal.plan.next, 1);
    assert.equal(f.status().result.complete, false);
    await runCreatorGeneration(f.context, { generate: async options => {
        assert.deepEqual(JSON.parse(options.messages[1].content).requestedFields, ['description']);
        return { text: '{"fields":{"description":"Resumed"}}' };
    } });
    assert.equal(f.status().result.proposal.changes[0].after, 'Mira');
    assert.equal(f.status().result.proposal.changes[1].after, 'Resumed');
});

test('Catelier deduplicates submissions, rejects concurrent paid work and isolates draft readback', async t => {
    const f = setup(t);
    assert.equal(acceptCreatorGeneration(f.scope, f.request).job.id, f.job.id);
    assert.throws(() => acceptCreatorGeneration(f.scope, { ...f.request, proposalId: 'other' }), /different work/);
    assert.throws(() => acceptCreatorGeneration(f.scope, { ...f.request, submissionKey: 'second' }), /already has/);
    assert.throws(() => creatorGenerationStatus(f.scope, { id: 'other', jobId: f.job.id }), /unavailable/);
    f.controller.abort();
    await assert.rejects(runCreatorGeneration(f.context, { generate: () => assert.fail('Cancelled work must not dispatch') }), { name: 'AbortError' });
    setJobState(f.scope.directories, f.job.id, 'cancelled');
    assert.throws(() => acceptCreatorGeneration(f.scope, { ...f.request, submissionKey: 'stale', expectedRevision: 'stale' }), /Save the current draft/);
});

test('recovered field suggestions reject later edits and locks', () => {
    const source = createCreatorDraft({ id: 'field' });
    const result = { source, recovery: { kind: 'field', target: 'description' }, text: '{"value":"A shipwright."}' };
    assert.equal(recoverCreatorServerReply(source, result).card.data.description, 'A shipwright.');
    const changed = structuredClone(source); changed.card.data.description = 'My edit';
    assert.throws(() => recoverCreatorServerReply(changed, result), /changed/);
    changed.card.data.description = ''; changed.locks.push('description');
    assert.throws(() => recoverCreatorServerReply(changed, result), /locked/);
});

test('server questions wait for the author before generating fields', async t => {
    const f = setup(t, draft => { draft.writing = { askQuestionsFirst: true }; });
    let calls = 0;
    await runCreatorGeneration(f.context, { generate: async () => {
        calls++;
        return { text: '{"questions":["Where does Mira work?"]}' };
    } });
    assert.equal(calls, 1);
    assert.equal(f.status().result.proposal.plan.phase, 'answers');
    assert.deepEqual(f.status().result.proposal.changes, []);
});

test('server cancellation during a later field retains the earlier proposal', async t => {
    const f = setup(t);
    let calls = 0;
    await assert.rejects(runCreatorGeneration(f.context, { generate: async () => {
        if (++calls === 2) f.controller.abort();
        return { text: '{"fields":{"name":"Mira","description":"Do not apply"}}' };
    } }), { name: 'AbortError' });
    assert.equal(f.status().result.proposal.plan.next, 1);
    assert.deepEqual(f.status().result.proposal.changes.map(change => change.field), ['name']);
});

test('server length-limited replies never become proposals', async t => {
    const f = setup(t);
    await assert.rejects(runCreatorGeneration(f.context, { generate: async () => ({
        text: '{"fields":{"name":"Truncated"}}', response: { choices: [{ finish_reason: 'length' }] },
    }) }), /complete reply/);
    assert.equal(f.status().result, null);
});

test('server field regeneration preserves the other proposed fields and plan', async t => {
    const f = setup(t);
    await runCreatorGeneration(f.context, { generate: async options => ({ text: JSON.stringify({ fields:
        JSON.parse(options.messages[1].content).requestedFields[0] === 'name' ? { name: 'Mira' } : { description: 'Original description' },
    }) }) });
    const draft = structuredClone(f.draft);
    importCreatorServerProposal(draft, f.status().result);
    setJobState(f.scope.directories, f.job.id, 'completed');
    const saved = withRoleplayAccount(f.scope, null, lease => saveCreatorDraft(lease, draft, f.saved.revision));
    const { job } = acceptCreatorGeneration(f.scope, { ...f.request, expectedRevision: saved.revision, submissionKey: 'revise', reviseField: 'description' });
    let calls = 0;
    await runCreatorGeneration({ ...f.context, job }, { generate: async options => {
        calls++;
        assert.deepEqual(JSON.parse(options.messages[1].content).requestedFields, ['description']);
        return { text: '{"fields":{"description":"Revised description"}}' };
    } });
    const { result } = creatorGenerationStatus(f.scope, { id: draft.id, jobId: job.id });
    assert.equal(calls, 1);
    assert.deepEqual(result.proposal.plan, draft.proposals[0].plan);
    assert.equal(result.proposal.changes[0].after, 'Mira');
    assert.equal(result.proposal.changes[1].after, 'Revised description');
    importCreatorServerProposal(draft, result);
    assert.equal(draft.card.data.description, '');
});
