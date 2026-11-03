import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, renderCreatorFacts } from '../public/scripts/creator/model.js';
import { buildDossierRequest } from '../public/scripts/creator/dossier.js';
import { buildCreatorLoreRequest, parseCreatorLoreProposal, acceptCreatorLoreProposal } from '../public/scripts/creator/lore-proposals.js';

const fixture = () => {
    const draft = createCreatorDraft({ id: 'readable', card: { data: { name: 'Mira', description: 'Keep this description' } } });
    draft.dossier = 'Moon Harbour is a sheltered port. Mira repairs ships there.';
    draft.books.push({ id: 'book', name: 'Places', mode: 'copy', data: { entries: {} } });
    return draft;
};

test('Recommended format requests an interview and note, preserves locks and has readable deterministic output', () => {
    const draft = fixture();
    assert.equal(draft.style, 'plain');
    draft.style = 'purachina';
    draft.facts = [{ id: 'job', section: 'identity', text: 'Repairs ships', status: 'decided' }];
    const request = buildDossierRequest(draft, ['description']);
    assert.deepEqual(request.fields, ['description', 'depth_prompt']);
    assert.match(request.messages[0].content, /speaker name in backticks/);
    const output = renderCreatorFacts(draft);
    assert.match(output.fields.description, /`Interviewer`: Brief introduction\?\n`Mira`: Repairs ships/);
    assert.equal(output.fields.depth_prompt, '[\nMira\'s persona: Repairs ships\n]');
    draft.locks.push('depth_prompt');
    assert.deepEqual(buildDossierRequest(draft, ['description']).fields, ['description']);
});

test('Dossier lore creates editable bracketed entries, preserves source, and rejects stale or empty-key acceptance', () => {
    const draft = fixture();
    draft.privateNotes = 'Private memo';
    const messages = buildCreatorLoreRequest(draft, 'book', 'Extract places', 'keep', 'dossier');
    assert.equal(JSON.parse(messages[1].content).dossier, draft.dossier);
    assert.ok(!JSON.stringify(messages).includes('Private memo'));
    assert.ok(!JSON.parse(buildCreatorLoreRequest(draft, 'book', 'Extract places')[1].content).dossier);
    const reply = { entries: [{ uid: null, title: 'Moon Harbour', keys: [' Moon Harbour ', 'Moon Harbour'], content: 'A sheltered port.', constant: false }], description: null, coverage: ['Kept the harbour'] };
    const proposal = parseCreatorLoreProposal(draft, 'book', JSON.stringify(reply), 'keep', 'dossier');
    assert.deepEqual(proposal.data.entries[0].key, ['Moon Harbour']);
    assert.equal(proposal.data.entries[0].content, '[\nA sheltered port.\n]');
    proposal.data.entries[0].content = '[\nEdited port detail.\n]';
    const applied = acceptCreatorLoreProposal(draft, proposal);
    assert.equal(applied.dossier, draft.dossier);
    assert.equal(applied.card.data.description, 'Keep this description');
    assert.equal(Object.keys(draft.books[0].data.entries).length, 0);
    assert.throws(() => acceptCreatorLoreProposal({ ...draft, dossier: 'Changed' }, proposal), /Dossier changed/);
    proposal.data.entries[0].key = [];
    assert.throws(() => acceptCreatorLoreProposal(draft, proposal), /activation keyword/);
});
