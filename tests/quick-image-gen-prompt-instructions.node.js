import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_NATURAL_INSTRUCTION_TEMPLATE,
    DEFAULT_TAGS_INSTRUCTION_TEMPLATE,
    DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE,
} from '../public/scripts/extensions/quick-image-gen/lib/prompt-defaults.js';
import {
    buildImagePromptInstruction,
    buildSceneDescriptionInstruction,
} from '../public/scripts/extensions/quick-image-gen/lib/prompt-instructions.js';

const scene = 'Mira leans on the balcony rail while I hand her a paper lantern.';
const profile = {
    charNameJoined: 'Mira',
    charNames: ['Mira'],
    userName: 'Kit',
    charDescResolved: 'Mira is a dark-skinned fox spirit with silver hair, amber eyes and a red kimono.',
    userDescResolved: 'Kit is a tall tanned skin sailor with a scarred brow.',
    charScenarioResolved: 'A lantern festival in a harbour town.',
    charTagsResolved: 'original, fantasy',
    usesCurrentCardContext: true,
    useExactNameRequirements: true,
};
const allToggles = { llmAddQuality: true, llmAddLighting: true, llmAddArtist: true };
const count = (text, needle) => text.split(needle).length - 1;

function assertTidy(prompt) {
    assert.doesNotMatch(prompt, /\n{3,}/, 'no runs of blank lines');
    assert.doesNotMatch(prompt, /^-\s*$/m, 'no empty bullets');
    assert.doesNotMatch(prompt, /undefined|\[object Object\]/);
    assert.doesNotMatch(prompt, /CRITICAL/);
}

test('natural description prompt stays style-neutral instead of pushing realism', () => {
    for (const settings of [{ llmPromptStyle: 'natural' }, { llmPromptStyle: 'natural', ...allToggles }]) {
        const prompt = buildImagePromptInstruction(settings, scene, profile, { artist: 'mika pikazo' });
        assert.match(prompt, /Stay style-neutral otherwise; realism is never the default/);
        assert.doesNotMatch(prompt, /sharp focus|photorealis|detailed rendering/i);
        assert.match(prompt, /CURRENT SCENE: Mira leans on the balcony rail/);
        assert.match(prompt, /Prompt:$/);
        assertTidy(prompt);
    }
    assert.match(buildImagePromptInstruction({ llmPromptStyle: 'natural' }, scene, profile), /- No artist names/);
    assert.match(buildImagePromptInstruction({ llmPromptStyle: 'natural', ...allToggles }, scene, profile, { artist: 'mika pikazo' }),
        /An art style reference to an artist such as mika pikazo/);
});

test('tags prompt keeps its markers and states each identity rule once', () => {
    const prompt = buildImagePromptInstruction({ llmPromptStyle: 'tags', ...allToggles }, scene, profile, { artist: 'mika pikazo' });
    assert.match(prompt, /^### STANDALONE IMAGE GENERATION TASK ###/);
    assert.match(prompt, /for this scene: Mira leans/);
    assert.match(prompt, /Tags:$/);
    assert.match(prompt, /artist tag such as mika_pikazo/);
    assert.equal(count(prompt, 'Skin tones to keep'), 1);
    assert.match(prompt, /Skin tones to keep: Mira: dark-skinned, Kit: tanned skin/);
    assert.equal(count(prompt, 'IDENTITY:'), 1);
    assertTidy(prompt);
});

test('identity rules are left out when identity preservation is off', () => {
    for (const llmPromptStyle of ['tags', 'natural']) {
        const prompt = buildImagePromptInstruction({ llmPromptStyle, preserveCharacterIdentity: false }, scene, profile);
        assert.doesNotMatch(prompt, /IDENTITY:|Skin tones/);
        assertTidy(prompt);
    }
});

test('prompts stay tidy without any character reference', () => {
    const bare = { charNames: [], charDescResolved: '', userDescResolved: '' };
    for (const llmPromptStyle of ['tags', 'natural']) {
        const prompt = buildImagePromptInstruction({ llmPromptStyle, preserveCharacterIdentity: false }, scene, bare);
        assert.doesNotMatch(prompt, /CHARACTER (INFO|REFERENCE):/);
        assertTidy(prompt);
    }
    const description = buildSceneDescriptionInstruction({ preserveCharacterIdentity: false }, scene, bare);
    assert.doesNotMatch(description, /REFERENCE CONTEXT:/);
    assertTidy(description);
});

test('multi-message scenes ask for one moment from the transcript', () => {
    const transcript = 'Mira: Look at the lanterns.\nKit: I hand her one.';
    for (const llmPromptStyle of ['tags', 'natural']) {
        const prompt = buildImagePromptInstruction({ llmPromptStyle }, transcript, profile, { isMultiMessage: true });
        assert.equal(count(prompt, 'speaker-tagged transcript'), 1);
        assertTidy(prompt);
    }
    const description = buildSceneDescriptionInstruction({}, transcript, profile, { isMultiMessage: true });
    assert.match(description, /SELECTED SCENE CONTEXT:\nMira: Look/);
    assertTidy(description);
});

test('custom instruction gets toggle extras, identity rules and the scene', () => {
    const settings = { llmPromptStyle: 'custom', llmCustomInstruction: 'Describe {{char}} for {{user}}.', ...allToggles };
    const prompt = buildImagePromptInstruction(settings, scene, profile, { artist: 'mika pikazo' });
    assert.match(prompt, /^Describe Mira for Kit\./);
    assert.match(prompt, /ALSO INCLUDE:\n- Quality tags/);
    assert.equal(count(prompt, 'IDENTITY:'), 1);
    assert.match(prompt, /SELECTED SCENE:\nMira leans/);
    assertTidy(prompt);
});

test('scene description prompt keeps its markers', () => {
    const prompt = buildSceneDescriptionInstruction({}, scene, profile);
    assert.match(prompt, /^\[STANDALONE VISUAL SCENE DESCRIPTION TASK\]/);
    assert.match(prompt, /REFERENCE CONTEXT:\nMira's appearance\/profile:/);
    assert.match(prompt, /SELECTED SCENE:\nMira leans/);
    assert.match(prompt, /Plain visual description:$/);
    assertTidy(prompt);
});

test('built-in prompts stay within their size limits', () => {
    const bare = { charNames: [], charDescResolved: '', userDescResolved: '' };
    assert.ok(buildImagePromptInstruction({ llmPromptStyle: 'tags' }, '', bare).length < 1200);
    assert.ok(buildImagePromptInstruction({ llmPromptStyle: 'natural' }, '', bare).length < 1200);
    assert.ok(buildSceneDescriptionInstruction({}, '', bare).length < 650);
});

test('editable templates mirror the built-in prompts', () => {
    assert.match(DEFAULT_TAGS_INSTRUCTION_TEMPLATE, /^### STANDALONE IMAGE GENERATION TASK ###/);
    assert.match(DEFAULT_TAGS_INSTRUCTION_TEMPLATE, /for this scene: \{\{scene\}\}/);
    assert.match(DEFAULT_TAGS_INSTRUCTION_TEMPLATE, /Tags:$/);
    assert.match(DEFAULT_NATURAL_INSTRUCTION_TEMPLATE, /CURRENT SCENE: \{\{scene\}\}/);
    assert.match(DEFAULT_NATURAL_INSTRUCTION_TEMPLATE, /realism is never the default/);
    assert.doesNotMatch(DEFAULT_NATURAL_INSTRUCTION_TEMPLATE, /sharp focus/);
    assert.match(DEFAULT_NATURAL_INSTRUCTION_TEMPLATE, /Prompt:$/);
    assert.match(DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE, /SELECTED SCENE:\n\{\{scene\}\}/);
    assert.match(DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE, /Plain visual description:$/);
    for (const template of [DEFAULT_TAGS_INSTRUCTION_TEMPLATE, DEFAULT_NATURAL_INSTRUCTION_TEMPLATE, DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE]) assertTidy(template);
});
