import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatorPortraitPrompt, creatorPortraitPrompt } from '../public/scripts/creator/portrait-prompt.js';

test('Portrait defaults use current card details without private draft material', () => {
    const draft = { card: { data: { name: 'Mira', description: 'Silver hair and green eyes.', personality: 'Confident.', scenario: 'A harbour.', creator_notes: 'EDITOR_ONLY', system_prompt: 'SYSTEM_ONLY', extensions: { depth_prompt: { prompt: 'Blue coat.' } } } }, dossier: 'DOSSIER_ONLY', privateNotes: 'PRIVATE_ONLY' };
    const prompt = creatorPortraitPrompt(draft);
    for (const detail of ['Mira', 'Silver hair', 'Confident', 'harbour', 'Blue coat']) assert.ok(prompt.includes(detail));
    for (const secret of ['EDITOR_ONLY', 'SYSTEM_ONLY', 'DOSSIER_ONLY', 'PRIVATE_ONLY']) assert.ok(!prompt.includes(secret));
    draft.card.data.description = 'Red hair.';
    assert.ok(creatorPortraitPrompt(draft).includes('Red hair.'));
    draft.portraitPrompt = 'My custom portrait.';
    assert.equal(creatorPortraitPrompt(draft), 'My custom portrait.');
    draft.portraitPrompt = '';
    assert.equal(creatorPortraitPrompt(draft), '');
    delete draft.portraitPrompt;
    assert.ok(creatorPortraitPrompt(draft).includes('Red hair.'));
    assert.equal(buildCreatorPortraitPrompt({ card: { data: {} } }), '');
});
