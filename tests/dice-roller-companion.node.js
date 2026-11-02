import assert from 'node:assert/strict';
import { test } from 'node:test';

const { agentNeedsModel } = await import('../src/generation/agent-definition.js');
const { captureCompanionCapacity } = await import('../src/generation/companion-capacity.js');
const { prepareCompanionFeedback } = await import('../src/generation/companion-feedback.js');
const { DICE_ROLLER_TEMPLATE_ID } = await import('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js');

const diceAgent = (overrides = {}) => ({
    id: 'dice', name: 'Dice Roller', sourceTemplateId: DICE_ROLLER_TEMPLATE_ID,
    category: 'companion', execution: 'companion', enabled: true,
    prompt: 'Write the next reply with this result as settled fact.',
    injection: { position: 1, depth: 0, role: 0, scan: false, order: 115 },
    companion: { feedback: { enabled: true, depth: 1 }, includeHistory: false },
    conditions: { generationTypes: ['normal', 'continue', 'swipe', 'regenerate'], triggerKeywords: [], triggerProbability: 100 },
    ...overrides,
});
const modelAgent = { id: 'model', name: 'Notes', sourceTemplateId: 'tpl-vitals-companion', category: 'companion',
    execution: 'companion', enabled: true, prompt: 'Write a note.', injection: { position: 1, depth: 1, role: 1, scan: false },
    companion: { feedback: { enabled: false, depth: 1 } } };
const environment = {
    names: { user: 'Ari', char: 'Nova' },
    evaluate(text) {
        return String(text ?? '').replaceAll('{{user}}', 'Ari').replaceAll('{{char}}', 'Nova');
    },
};
const snapshot = { agents: { hiddenIds: [] }, experimentalMacroEngine: false };
const roll = '\u{1F3B2} Pick the lock - rolled 18 vs 12 (1d20: 18) - SUCCESS';
const records = (text = roll) => [{ chat_metadata: {} }, { is_user: true, name: 'Ari', mes: text }];

function feedback({ active = [diceAgent()], all = records(), type = 'normal', hidden = [], customPrompt, context } = {}) {
    const agent = active[0];
    if (agent && customPrompt !== undefined) agent.prompt = customPrompt;
    return prepareCompanionFeedback(active, [], all, { ...snapshot, agents: { hiddenIds: hidden }, ...context },
        environment, [], type);
}

test('the Dice Roller never needs a model or a saved note', () => {
    assert.equal(agentNeedsModel(diceAgent()), false);
    assert.equal(agentNeedsModel(modelAgent), true);
    const capacity = captureCompanionCapacity([diceAgent(), modelAgent], [], { message: { index: 0 } });
    assert.equal(capacity.companionCount, 1);
});

test('a browser and server reply both receive the newest user roll as the configured directive', () => {
    const result = feedback();
    assert.equal(result.extensions.length, 1);
    assert.deepEqual(result.extensions[0], {
        key: 'inchat_agent_companion_dice',
        content: '[Dice result for Ari]\nPick the lock: SUCCESS. It succeeds. Show it working cleanly.\nWrite the next reply with this result as settled fact.',
        position: 1,
        depth: 0,
        role: 'system',
        scan: false,
    });

    const continued = feedback({ all: [...records(), { is_user: false, name: 'Nova', mes: 'The lock opens.' }], type: 'continue' });
    assert.equal(continued.extensions.length, 1);
    const regenerated = feedback({ all: [...records(), { is_user: false, name: 'Nova', mes: 'Old reply.' }], type: 'regenerate' });
    assert.equal(regenerated.extensions.length, 1);
});

test('a custom agent prompt is macro-resolved and replaces the closing instruction', () => {
    const result = feedback({ customPrompt: 'Write it in {{char}}\'s voice.' });
    assert.match(result.extensions[0].content, /Write it in Nova's voice\.$/);
    assert.doesNotMatch(result.extensions[0].content, /keep the dice, the numbers/);
});

test('disabled, hidden and unchanged turns inject nothing', () => {
    assert.deepEqual(feedback({ active: [] }).extensions, []);
    assert.deepEqual(feedback({ hidden: ['dice'] }).extensions, []);
    assert.deepEqual(feedback({ all: records('Look around the room.') }).extensions, []);
    assert.deepEqual(feedback({ all: [...records(), { is_user: false, name: 'Nova', mes: 'Reply.' }, { is_user: false, name: 'Nova', mes: 'Another.' }], type: 'continue' }).extensions, []);
    assert.deepEqual(feedback({ type: 'impersonate' }).extensions, []);
});
