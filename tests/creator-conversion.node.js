import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, acceptCreatorProposal } from '../public/scripts/creator/model.js';
import { startCreatorConversion, mergeCreatorStep, creatorStepMessages, reviseCreatorConversion } from '../public/scripts/creator/conversion.js';

test('conversion keeps completed fields and resumes exactly the failed step', () => {
    const draft = createCreatorDraft({ id: 'steps', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    let proposal = startCreatorConversion(draft, ['name', 'description']);
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { name: 'Mira', description: 'Ignore premature field' }, questions: ['Where does she work?'] }));
    assert.deepEqual(proposal.changes.map(change => change.field), ['name']);
    assert.equal(proposal.plan.next, 1);
    assert.throws(() => mergeCreatorStep(draft, proposal, 'incomplete'), /finished steps are saved/);
    assert.equal(proposal.plan.next, 1);
    const request = JSON.parse(creatorStepMessages(draft, proposal)[1].content);
    assert.deepEqual(request.requestedFields, ['description']);
    assert.equal(request.writtenFields.name, 'Mira');
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { description: 'A shipwright.' } }));
    proposal.answers = { 'Where does she work?': 'At the northern docks.' };
    const revised = reviseCreatorConversion(draft, proposal);
    assert.equal(revised.plan.next, 0);
    assert.deepEqual(revised.questions, []);
    assert.equal(JSON.parse(creatorStepMessages(draft, revised)[1].content).answers[0].answer, 'At the northern docks.');
    assert.equal(revised.changes[0].before, proposal.changes[0].before);
});

test('a late step cannot replace an edit made while it was pending', () => {
    const draft = createCreatorDraft({ id: 'edited', card: { data: { description: 'Original' } } });
    draft.dossier = 'A shipwright.';
    const proposal = startCreatorConversion(draft, ['description']);
    draft.card.data.extensions = { private: 'Do not send this' };
    assert.doesNotMatch(JSON.stringify(creatorStepMessages(draft, proposal)), /Do not send this/);
    draft.card.data.description = 'My newer text';
    const finished = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { description: 'Generated' } }));
    assert.equal(finished.changes[0].before, 'Original');
    assert.throws(() => acceptCreatorProposal(draft, finished), /field changed/);
});

test('greetings use bounded batches and retain previous batches', () => {
    const draft = createCreatorDraft({ id: 'greetings', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    draft.writing = { targets: { greetingCount: '8' } };
    let proposal = startCreatorConversion(draft, ['first_mes']);
    assert.deepEqual(proposal.plan.steps.map(step => step.count ?? 1), [1, 3, 3, 1]);
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { first_mes: 'First' } }));
    for (const batch of [['A', 'B', 'C'], ['D', 'E', 'F'], ['G']]) proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: batch } }));
    assert.deepEqual(proposal.changes[1].after, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    assert.equal(proposal.plan.next, 4);
});
