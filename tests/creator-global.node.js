import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCreatorDraft, editCreatorDraft, undoCreatorDraft } from '../public/scripts/creator/model.js';
import { applyCreatorGlobalSettings, creatorGlobalSettings } from '../public/scripts/creator/settings.js';
import { creatorGuidance } from '../public/scripts/creator/guidance.js';
import { buildCreatorImagePromptRequest } from '../public/scripts/creator/portrait-prompt.js';

test('only account preferences cross drafts, with independent request snapshots', () => {
    const source = createCreatorDraft({ id: 'source' });
    Object.assign(source, { style: 'plist', portraitGuidelines: 'Watercolour', portraitSupportsNegative: true, portraitPrompt: 'A red cloak', portraitNegativePrompt: 'Crowds', privateNotes: 'Private source', dossier: 'Source canon' });
    source.card.data.creator = 'Author';
    source.writing = {
        prompts: { director: 'Keep facts', grounded: '' }, connection: { maxTokens: 12345, stream: false },
        targets: { characterWords: '' }, nsfw: { enabled: false }, mode: 'custom', custom: 'Short sentences',
        formatInstruction: 'Use lists', plistDestination: 'depth_prompt', dossierFields: [], askQuestionsFirst: false,
        userInstructions: 'Keep dialogue precise', agentProcessing: { agents: ['local-agent'] },
    };
    const settings = creatorGlobalSettings(source);
    assert.equal(settings.writing.agentProcessing, undefined);
    for (const key of ['card', 'dossier', 'privateNotes', 'portraitPrompt', 'portraitNegativePrompt', 'media', 'source', 'history', 'proposals']) assert.equal(settings[key], undefined);
    const target = createCreatorDraft({ id: 'target', card: { data: { name: 'Other', creator: 'Old author' } } });
    target.writing = { askQuestionsFirst: true, agentProcessing: { agents: ['target-agent'] } };
    target.privateNotes = 'Private target';
    const original = structuredClone(target.source.original);
    applyCreatorGlobalSettings(target, settings);
    assert.equal(target.style, 'plist');
    assert.equal(target.card.data.creator, 'Author');
    assert.equal(target.card.data.name, 'Other');
    assert.deepEqual(target.source.original, original);
    assert.equal(target.privateNotes, 'Private target');
    assert.equal(target.portraitPrompt, undefined);
    assert.equal(target.portraitNegativePrompt, undefined);
    assert.deepEqual(target.writing.agentProcessing.agents, ['target-agent']);
    assert.deepEqual(target.writing.dossierFields, []);
    assert.equal(target.writing.askQuestionsFirst, false);
    assert.equal(target.writing.prompts.grounded, '');
    assert.equal(target.writing.targets.characterWords, '');
    assert.match(creatorGuidance(target), /Keep dialogue precise/);
    assert.match(JSON.stringify(buildCreatorImagePromptRequest(target)), /Watercolour/);
    target.writing.connection.maxTokens = 99;
    target.writing.dossierFields.push('description');
    assert.equal(settings.writing.connection.maxTokens, 12345);
    assert.deepEqual(settings.writing.dossierFields, []);
    assert.equal(source.writing.connection.maxTokens, 12345);
});

test('cleared settings and default resets replace stale values, including after Undo', () => {
    let draft = createCreatorDraft({ id: 'undo' });
    draft.writing = { prompts: { grounded: 'Old prose' }, askQuestionsFirst: true };
    draft.portraitSupportsNegative = true;
    draft.card.data.creator = 'Old author';
    draft = editCreatorDraft(draft, next => { next.card.data.description = 'New text'; });
    const settings = creatorGlobalSettings(createCreatorDraft({ id: 'defaults' }));
    applyCreatorGlobalSettings(draft, settings);
    assert.equal(draft.writing.prompts, undefined);
    assert.equal(draft.writing.askQuestionsFirst, undefined);
    assert.equal(draft.portraitSupportsNegative, false);
    assert.equal(draft.card.data.creator, '');
    draft = applyCreatorGlobalSettings(undoCreatorDraft(draft), settings);
    assert.equal(draft.card.data.description, '');
    assert.equal(draft.writing.prompts, undefined);
    assert.equal(draft.card.data.creator, '');
    assert.equal(draft.portraitSupportsNegative, false);
});
