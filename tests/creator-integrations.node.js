import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, acceptCreatorProposal, renderCreatorFacts } from '../public/scripts/creator/model.js';
import { appendCreatorNote } from '../public/scripts/creator/notebook-source.js';
import { creatorGuidance, CREATOR_PROMPTS } from '../public/scripts/creator/guidance.js';
import { buildDossierRequest, dossierProposal } from '../public/scripts/creator/dossier.js';
import { normaliseScratchpadCreator, scratchpadCreatorDraft } from '../public/scripts/creator/scratchpad-draft.js';
import { normaliseChange, splitReply, describeChange } from '../public/scripts/scratchpad/proposals.js';
import { creatorCardExport } from '../public/scripts/creator/export.js';
import { buildCreatorFieldRequest, acceptCreatorField } from '../public/scripts/creator/field-generation.js';
import { CREATOR_FORMATS, CREATOR_NSFW_GUIDANCE, creatorTargetsSignature } from '../public/scripts/creator/formats.js';

test('Character and greeting length targets are separate, migrate old values and NSFW guidance is opt-in', () => {
    const draft = createCreatorDraft({ id: 'lengths', card: { data: { name: 'Mira' } } });
    draft.dossier = 'Mira repairs ships.';
    draft.writing = { targets: { words: '700 words', tokens: '900 tokens' } };
    let prompt = buildDossierRequest(draft).messages[0].content;
    assert.match(prompt, /Description and personality length \(word target: 700 words; approximate token target: 900 tokens\)/);
    assert.match(prompt, /Opening greeting length.*word target: ~500 words each/);
    assert.ok(!prompt.includes('NSFW instructions'));
    draft.writing.targets = { characterWords: '600 words', greetingWords: '500 words', greetingTokens: '700 tokens' };
    prompt = buildDossierRequest(draft).messages[0].content;
    assert.match(prompt, /Description and personality length \(word target: 600 words; approximate token target: ~1,600-2,600 tokens\)/);
    assert.match(prompt, /Opening greeting length.*word target: 500 words; approximate token target: 700 tokens/);
    const before = creatorTargetsSignature(draft);
    draft.writing.nsfw = { enabled: true };
    assert.notEqual(creatorTargetsSignature(draft), before);
    assert.ok(buildDossierRequest(draft).messages[0].content.includes(CREATOR_NSFW_GUIDANCE));
    draft.writing.nsfw.instruction = 'Keep it explicit but brief.';
    prompt = buildDossierRequest(draft).messages[0].content;
    assert.ok(prompt.includes('Keep it explicit but brief.') && !prompt.includes(CREATOR_NSFW_GUIDANCE));
    draft.writing.nsfw.enabled = false;
    assert.ok(!buildDossierRequest(draft).messages[0].content.includes('Keep it explicit'));
    assert.ok(!JSON.stringify(creatorCardExport(draft)).includes('Keep it explicit'));
});

test('ALIchat guidance and guided examples need no opening delimiter and preserve imported text', () => {
    const draft = createCreatorDraft({ id: 'alichat', card: { data: { mes_example: '<START>\nLegacy example' } } });
    draft.style = 'alichat';
    draft.dossier = 'Mira repairs ships.';
    draft.facts.push({ id: 'work', section: 'identity', text: 'Ship repairer', status: 'decided' });
    assert.ok(!buildDossierRequest(draft).messages[0].content.includes('<START>'));
    assert.ok(renderCreatorFacts(draft).fields.mes_example.startsWith('Interviewer:'));
    assert.equal(draft.card.data.mes_example, '<START>\nLegacy example');
});

test('PList destination reviews Character’s Note without changing description or depth settings', () => {
    const draft = createCreatorDraft({ id: 'note-target', card: { data: { description: 'Original description', extensions: { depth_prompt: { prompt: 'Old note', depth: 7, role: 'user', opaque: true } } } } });
    draft.dossier = 'Mira repairs ships.';
    draft.style = 'plist';
    draft.writing = { formatInstruction: 'Use compact bracketed categories.', plistDestination: 'depth_prompt' };
    draft.facts.push({ id: 'work', section: 'identity', text: 'Ship repairer', status: 'decided' });
    assert.match(renderCreatorFacts(draft).fields.depth_prompt, /Ship repairer/);
    const request = buildDossierRequest(draft, ['description']);
    assert.deepEqual(request.fields, ['depth_prompt']);
    assert.match(request.messages[0].content, /compact bracketed categories/);
    assert.equal(JSON.parse(request.messages[1].content).existingFields.depth_prompt, 'Old note');
    const proposal = dossierProposal(draft, JSON.stringify({ fields: { depth_prompt: '[Work: ship repairs]' }, questions: [], coverage: ['Kept occupation'] }), request.fields);
    const applied = acceptCreatorProposal(draft, proposal);
    assert.equal(applied.card.data.description, 'Original description');
    assert.deepEqual(applied.card.data.extensions.depth_prompt, { prompt: '[Work: ship repairs]', depth: 7, role: 'user', opaque: true });
    assert.equal(draft.card.data.extensions.depth_prompt.prompt, 'Old note');
    assert.throws(() => acceptCreatorProposal({ ...draft, writing: { ...draft.writing, formatInstruction: 'Changed rules' } }, proposal), /targets changed/);
    assert.throws(() => acceptCreatorProposal({ ...draft, locks: ['depth_prompt'] }, proposal), /locked/);
});

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

test('Conversion targets and style controls reach authoring prompts, guard stale proposals and remain draft-private', () => {
    const draft = createCreatorDraft({ id: 'targets', card: { data: { name: 'Mira', description: 'Shipwright' } } });
    draft.dossier = 'Mira repairs ships at the dock.';
    assert.match(creatorGuidance(draft), /Rely strictly on the supplied dossier/);

    draft.writing = {
        targets: {
            tense: 'present',
            pov: 'third',
            canon: 'supplement',
            words: '2500-4000 interview, 500 opening',
            paragraphs: '3-5 paragraphs',
            tokens: '~1200 tokens',
            interviewQuestions: '8 questions across surface and fault lines',
            plistCategories: 'persona, appearance, body, wardrobe, quirks_and_tells',
            openingScenarios: '4 everyday workshop openings',
        },
    };
    const guidance = creatorGuidance(draft);
    assert.match(guidance, /present tense outside dialogue quotes/);
    assert.match(guidance, /third-person external narration/);
    assert.match(guidance, /established canon knowledge/);
    assert.match(guidance, /word target: 2500-4000 interview, 500 opening/);
    assert.match(guidance, /Paragraph target: 3-5 paragraphs/);
    assert.match(guidance, /approximate token target: ~1200 tokens/);
    assert.match(guidance, /8 questions across surface and fault lines/);
    assert.match(guidance, /persona, appearance, body, wardrobe, quirks_and_tells/);
    assert.match(guidance, /4 everyday workshop openings/);

    for (const messages of [buildDossierRequest(draft).messages, buildCreatorFieldRequest(draft, 'description')]) {
        assert.ok(messages[0].content.includes('Conversion and writing targets:'));
    }

    const exported = JSON.stringify(creatorCardExport(draft));
    assert.ok(!exported.includes('2500-4000 interview'));
    assert.ok(!exported.includes('4 everyday workshop openings'));

    const proposal = dossierProposal(draft, JSON.stringify({ fields: { description: 'Updated' }, questions: [], coverage: ['Kept dock work.'] }));
    const changedTargets = structuredClone(draft);
    changedTargets.writing.targets.tense = 'past';
    assert.throws(() => acceptCreatorProposal(changedTargets, proposal), /conversion targets changed/);
    assert.throws(() => acceptCreatorField(changedTargets, draft, 'description', 'Updated'), /changed/);
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
