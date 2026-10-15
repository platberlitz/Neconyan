import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { isRetiredBundledPrompt } = await import('../public/scripts/extensions/in-chat-agents/retired-prompts.js');

const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const readTemplate = name => JSON.parse(fs.readFileSync(new URL(name, templates), 'utf8'));

test('untouched old built-in prompts are recognised for an update, edited and current ones are not', () => {
    for (const name of ['directors-commentary-companion']) {
        const template = readTemplate(`${name}.json`);
        assert.equal(template.version, 2);
        assert.equal(isRetiredBundledPrompt(template.id, template.prompt), false);
        assert.equal(isRetiredBundledPrompt(template.id, `${template.prompt} `), false);
    }
    const oldDirector = 'Speak directly to the reader between scenes in the selected commentary voice.\n\n{{getvar::narration}}\n\nThe editor appends [Selected Director Commentary Voice] and [Director Commentary Voice] after this prompt. Treat [Director Commentary Voice] for this commentary run. If it says to use the active Prose Voice and the block above is empty, use this native register: intimate and mischievous, dry amusement, controlled irony, conspiratorial direct address to the reader, with razor-sharp asides.\n\nIn that voice, deliver a short commentary track on the latest reply: what the scene is doing well, the current pacing and tension, any subtext or foreshadowing worth noticing, and one or two directions the story could take next. Keep it to 3-6 punchy bullets. Keep the result between narrator and reader, focused on scene craft.';
    assert.equal(isRetiredBundledPrompt('tpl-directors-commentary-companion', oldDirector), true);
    assert.equal(isRetiredBundledPrompt('tpl-continuity-companion', oldDirector), false);
    assert.equal(isRetiredBundledPrompt('tpl-directors-commentary-companion', `${oldDirector} Be kind.`), false);
});

test('Director\'s Commentary asks for criticism, not only praise', () => {
    const director = readTemplate('directors-commentary-companion.json').prompt;
    assert.match(director, /neutral observer, not a fan/);
    assert.match(director, /ridiculous/);
    assert.match(director, /something the reply actually does/);
});
