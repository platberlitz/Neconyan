import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft } from '../public/scripts/creator/model.js';
import { appendCreatorNote } from '../public/scripts/creator/notebook-source.js';
import { creatorGuidance, CREATOR_PROMPTS } from '../public/scripts/creator/guidance.js';
import { buildDossierRequest } from '../public/scripts/creator/dossier.js';
import { normaliseScratchpadCreator, scratchpadCreatorDraft } from '../public/scripts/creator/scratchpad-draft.js';
import { normaliseChange, splitReply, describeChange } from '../public/scripts/scratchpad/proposals.js';
import { creatorCardExport } from '../public/scripts/creator/export.js';

test('Notebook imports copy only the selected saved text and preserve its source', () => {
    const draft = createCreatorDraft({ id: 'notes', card: { data: { name: 'Mira' } } });
    const note = { id: 'note1', revision: 'rev1', title: 'Alba', text: 'Mira fixes ships. {{poss}} tools.', privateOtherField: 'not imported' };
    const original = structuredClone(note);
    appendCreatorNote(draft, { notebookId: 'book', note });
    assert.equal(draft.dossier, '## Alba\n\nMira fixes ships. {{poss}} tools.');
    assert.deepEqual(note, original);
    assert.throws(() => appendCreatorNote(draft, { notebookId: 'book', note }), /already/);
    assert.equal(draft.notebookSources.length, 1);
    assert.ok(!JSON.stringify(creatorCardExport(draft)).includes('fixes ships'));
    const before = structuredClone(draft);
    assert.throws(() => appendCreatorNote(draft, { notebookId: 'book', note: { ...note, id: 'large', text: 'x'.repeat(100000) } }), /limit/);
    assert.deepEqual(draft, before);
});

test('Editable guidance replaces defaults, including intentionally empty prompts', () => {
    const draft = createCreatorDraft({ id: 'prompts', card: { data: { name: 'Mira' } } });
    draft.dossier = 'Shipwright';
    draft.writing = { mode: 'full', prompts: { director: 'Write terse dialogue.', grounded: '', macros: '' } };
    assert.equal(creatorGuidance(draft), 'Write terse dialogue.');
    const prompt = buildDossierRequest(draft).messages[0].content;
    assert.ok(prompt.includes('Write terse dialogue.'));
    assert.ok(!prompt.includes(CREATOR_PROMPTS.grounded));
    delete draft.writing.prompts.director;
    assert.ok(creatorGuidance(draft).includes(CREATOR_PROMPTS.director));
});

test('Scratchpad produces a private editable Creator draft with literal source macros', () => {
    const proposal = { type: 'creator', action: 'create', name: 'Mira', dossier: 'Agreed: {{char}} repairs ships.', fields: { description: 'Shipwright', mes_example: '<START>\nInterviewer: Why?\n{{char}}: Work.' } };
    assert.deepEqual(normaliseChange(proposal), proposal);
    assert.match(describeChange(proposal), /Creator draft/);
    const parts = splitReply('Ready.\n```scratchpad-change\n' + JSON.stringify(proposal) + '\n```');
    assert.ok(parts.some(part => part.change?.type === 'creator'));
    const draft = scratchpadCreatorDraft(proposal, 'stable-proposal');
    assert.equal(draft.id, 'stable-proposal');
    assert.equal(draft.source.avatar, null);
    assert.equal(draft.dossier, proposal.dossier);
    assert.equal(draft.card.data.description, 'Shipwright');
    assert.equal(draft.view.section, 'dossier');
    assert.throws(() => normaliseScratchpadCreator({ ...proposal, fields: { extensions: {} } }), /Unsupported/);
    assert.throws(() => normaliseScratchpadCreator({ ...proposal, action: 'publish' }), /private draft/);
});
