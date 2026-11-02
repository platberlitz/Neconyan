import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft } from '../public/scripts/creator/model.js';
import { appendCreatorNote } from '../public/scripts/creator/notebook-source.js';
import { creatorGuidance, CREATOR_PROMPTS } from '../public/scripts/creator/guidance.js';
import { buildDossierRequest } from '../public/scripts/creator/dossier.js';
import { normaliseScratchpadCreator, scratchpadCreatorDraft } from '../public/scripts/creator/scratchpad-draft.js';
import { normaliseChange, splitReply, describeChange } from '../public/scripts/scratchpad/proposals.js';
import { creatorCardExport } from '../public/scripts/creator/export.js';
import { buildCreatorFieldRequest, acceptCreatorField } from '../public/scripts/creator/field-generation.js';
import { CREATOR_FORMATS } from '../public/scripts/creator/formats.js';

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
    assert.ok(creatorGuidance(draft).startsWith('Write terse dialogue.\n\nSelected writing format: Natural description.'));
    const prompt = buildDossierRequest(draft).messages[0].content;
    assert.ok(prompt.includes('Write terse dialogue.'));
    assert.ok(!prompt.includes(CREATOR_PROMPTS.grounded));
    delete draft.writing.prompts.director;
    assert.ok(creatorGuidance(draft).includes(CREATOR_PROMPTS.director));
});

test('All formats and custom user instructions reach Dossier and field generation without private notes', () => {
    const draft = createCreatorDraft({ id: 'generation', card: { data: { name: 'Mira', description: 'Shipwright', alternate_greetings: ['Old opening'] } } });
    draft.dossier = 'She seeks her sister with {{poss}} tools.';
    draft.privateNotes = 'UNSHARED_SECRET';
    draft.writing = { userInstructions: 'Make her voice terse.' };
    for (const [style, format] of Object.entries(CREATOR_FORMATS)) {
        draft.style = style;
        for (const messages of [buildDossierRequest(draft).messages, buildCreatorFieldRequest(draft, 'description')]) {
            assert.ok(messages[0].content.includes(`Selected writing format: ${format.label}`));
            assert.ok(messages[0].content.includes('Make her voice terse.'));
            assert.ok(messages[1].content.includes('{{poss}}'));
            assert.ok(!JSON.stringify(messages).includes('UNSHARED_SECRET'));
        }
    }
    const next = acceptCreatorField(draft, draft, 'alternate_greetings:0', 'New opening');
    assert.equal(next.card.data.alternate_greetings[0], 'New opening');
    assert.equal(draft.card.data.alternate_greetings[0], 'Old opening');
    assert.equal(next.history.length, 1);
    const shifted = structuredClone(draft);
    shifted.card.data.alternate_greetings.unshift('Old opening');
    assert.throws(() => acceptCreatorField(shifted, draft, 'alternate_greetings:0', 'New'), /list changed/);
    assert.throws(() => acceptCreatorField({ ...draft, dossier: 'changed' }, draft, 'description', 'New'), /changed/);
    assert.throws(() => acceptCreatorField({ ...draft, style: 'plain' }, draft, 'description', 'New'), /changed/);
    assert.throws(() => acceptCreatorField({ ...draft, locks: ['description'] }, draft, 'description', 'New'), /locked/);
    assert.throws(() => buildCreatorFieldRequest(draft, 'privateNotes'), /no longer available/);
    const depth = acceptCreatorField(draft, draft, 'depth_prompt', 'Remember her goal.');
    assert.deepEqual(depth.card.data.extensions.depth_prompt, { depth: 4, role: 'system', prompt: 'Remember her goal.' });
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
