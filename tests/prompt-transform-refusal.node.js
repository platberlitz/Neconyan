import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelyMainReplyRefusal, isLikelyPromptTransformRefusal } from '../public/scripts/extensions/in-chat-agents/prompt-transform-refusal.js';

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

test('a main reply that opens with a refusal skips Agents', () => {
    for (const text of [
        'I cannot fulfill this request. The prompt contains instructions to generate highly explicit sexual content ("NSFW Mode," anatomical descriptions of sex acts, and bodily fluids) paired with a fictional storyline involving non-consensual sexual acts and violence. While I understand this is framed as a fictional roleplay scenario, my safety policies strictly prohibit the generation of sexually explicit content and depictions of sexual violence, regardless of framing or context',
        'I\u2019m sorry, but I can\u2019t continue this roleplay as it goes against my guidelines.',
        '(OOC: I won\'t write this scene; the content is too explicit.)',
        'I apologize, but I am unable to generate content of that nature.',
        'I don\'t feel comfortable writing this kind of content.',
        'I must respectfully decline this request.',
    ]) {
        assert.equal(isLikelyMainReplyRefusal(text), true, text);
    }
});

test('in-character refusals and late refusals still run Agents', () => {
    for (const text of [
        '',
        '"I can\'t help with this request," she said, turning away.',
        '*She shakes her head.* I can\'t help you, the policy is clear.',
        'I can\'t help you, traveller. The pass is closed till spring.',
        'I can\'t help but smile at your request.',
        'As an AI aboard this ship, I keep the lights on. The captain is asleep.',
        `${'The rain kept on against the shutters while they talked. '.repeat(5)}I cannot continue this scene, my guidelines say no.`,
        `I cannot write fast enough to keep up with your request. ${'The story went on. '.repeat(120)}`,
    ]) {
        assert.equal(isLikelyMainReplyRefusal(text), false, text);
    }
});
