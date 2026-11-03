import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, acceptCreatorProposal } from '../public/scripts/creator/model.js';
import { buildDossierRequest, dossierProposal } from '../public/scripts/creator/dossier.js';

test('Saved field choices include an intentionally empty selection and honour locks', () => {
    const draft = createCreatorDraft({ id: 'choices' });
    draft.dossier = 'A shipwright.';
    draft.writing = { dossierFields: ['description'] };
    assert.deepEqual(buildDossierRequest(draft).fields, ['description']);
    draft.writing.dossierFields = [];
    assert.throws(() => buildDossierRequest(draft), /Choose at least/);
    draft.writing.dossierFields = ['first_mes'];
    assert.deepEqual(buildDossierRequest(draft).fields, ['first_mes', 'alternate_greetings']);
    draft.locks.push('alternate_greetings');
    assert.deepEqual(buildDossierRequest(draft).fields, ['first_mes']);
});

test('Multiple greetings remain separate, editable and protected against stale replies', () => {
    const draft = createCreatorDraft({ id: 'greetings' });
    draft.dossier = 'A shipwright. Write four greetings.';
    const requested = buildDossierRequest(draft, ['first_mes']).fields;
    const reply = { fields: { first_mes: 'At the dock.', alternate_greetings: ['At home.', 'At work.', 'At sea.'] }, questions: [], coverage: ['Four openings'] };
    const proposal = dossierProposal(draft, JSON.stringify(reply), requested);
    proposal.changes.find(item => item.field === 'alternate_greetings').after[1] = 'At the workshop.';
    const next = acceptCreatorProposal(draft, proposal);
    assert.equal(next.card.data.first_mes, 'At the dock.');
    assert.deepEqual(next.card.data.alternate_greetings, ['At home.', 'At the workshop.', 'At sea.']);
    proposal.changes[1].after[0] = 'Changed afterwards';
    assert.equal(next.card.data.alternate_greetings[0], 'At home.');
    assert.throws(() => acceptCreatorProposal(next, proposal), /changed/);
    reply.fields.alternate_greetings = 'Not an array';
    assert.throws(() => dossierProposal(draft, JSON.stringify(reply), requested), /invalid field/);
    assert.throws(() => dossierProposal(draft, JSON.stringify({ ...reply, fields: { alternate_greetings: ['Unrequested'] } }), ['description']), /unrequested/);
});
import { creatorTargetValue, creatorTargetsSignature, creatorTargetsGuidance } from '../public/scripts/creator/formats.js';

test('Greeting count defaults to one, rejects invalid counts and invalidates old targets', () => {
    for (const value of [undefined, '', '0', '-1', '1.5', 'no', Infinity]) {
        assert.equal(creatorTargetValue({ greetingCount: value }, 'greetingCount'), '1');
    }
    const draft = { writing: { targets: {} } };
    const before = creatorTargetsSignature(draft);
    draft.writing.targets.greetingCount = '6';
    assert.notEqual(creatorTargetsSignature(draft), before);
    assert.match(creatorTargetsGuidance(draft), /Number of greetings to create: 6 total/);
});
