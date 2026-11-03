import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GROUNDED_GUIDANCE, creatorGuidance } from '../public/scripts/creator/guidance.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

test('Catelier uses the complete bundled grounded rules and preserves explicit custom guidance', async () => {
    const bundled = JSON.parse(await readFile(new URL('../public/scripts/extensions/in-chat-agents/templates/grounded-prose.json', import.meta.url), 'utf8'));
    assert.equal(GROUNDED_GUIDANCE, bundled.prompt.slice(bundled.prompt.indexOf('# Grounded Prose Rules')).trim());
    const draft = createCreatorDraft({ id: 'grounded', card: { data: {} } });
    assert.ok(creatorGuidance(draft).includes(GROUNDED_GUIDANCE));
    draft.writing = { prompts: { grounded: 'My edited rules.' } };
    assert.ok(creatorGuidance(draft).includes('My edited rules.'));
    assert.ok(!creatorGuidance(draft).includes(GROUNDED_GUIDANCE));
});
