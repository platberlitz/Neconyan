import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelyPromptTransformRefusal } from '../public/scripts/extensions/in-chat-agents/prompt-transform-refusal.js';

const reply = 'She pulled him closer, breath hot against his neck. "Stay," she whispered, and the candle guttered out.';

test('model refusals and policy notes count as refusals', () => {
    for (const output of [
        'I\u2019m sorry, but I can\u2019t help with that request.',
        'I cannot continue this scene.',
        'I won\'t write explicit content involving these characters.',
        'I must respectfully decline.',
        'I\'m not comfortable writing this.',
        'As an AI, I keep things tasteful. Here is a softer version:\n\n' + reply,
        'This request goes against my guidelines, so here is a gentler take:\n\n' + reply,
    ]) {
        assert.equal(isLikelyPromptTransformRefusal(output, reply), true, output);
    }
});

test('ordinary rewrites and in-story refusals are not refusals', () => {
    assert.equal(isLikelyPromptTransformRefusal(reply, reply), false);
    assert.equal(isLikelyPromptTransformRefusal('', reply), false);
    const story = '"I can\'t help you," the guard said, folding his arms. "Not tonight."';
    assert.equal(isLikelyPromptTransformRefusal(`${story} He did not move from the door.`, story), false);
});

test('a refusal phrase inside a full-length rewrite is kept as story text', () => {
    const original = `${reply}\n\n${'The rain kept on against the shutters while they talked. '.repeat(30)}`;
    const rewrite = `"I won't do that," he said, and kissed her anyway.\n\n${original}`;
    assert.equal(isLikelyPromptTransformRefusal(rewrite, original), false);
});
