import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { isRetiredBundledPrompt } = await import('../public/scripts/extensions/in-chat-agents/retired-prompts.js');

const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const readTemplate = name => JSON.parse(fs.readFileSync(new URL(name, templates), 'utf8'));

test('untouched old built-in prompts are recognised for an update, edited and current ones are not', () => {
    for (const name of ['directors-commentary-companion', 'continuity-companion', 'continuity-corrector']) {
        const template = readTemplate(`${name}.json`);
        assert.equal(template.version, 2);
        assert.equal(isRetiredBundledPrompt(template.id, template.prompt), false);
        assert.equal(isRetiredBundledPrompt(template.id, `${template.prompt} `), false);
    }
    const oldDirector = 'Speak directly to the reader between scenes in the selected commentary voice.\n\n{{getvar::narration}}\n\nThe editor appends [Selected Director Commentary Voice] and [Director Commentary Voice] after this prompt. Treat [Director Commentary Voice] for this commentary run. If it says to use the active Prose Voice and the block above is empty, use this native register: intimate and mischievous, dry amusement, controlled irony, conspiratorial direct address to the reader, with razor-sharp asides.\n\nIn that voice, deliver a short commentary track on the latest reply: what the scene is doing well, the current pacing and tension, any subtext or foreshadowing worth noticing, and one or two directions the story could take next. Keep it to 3-6 punchy bullets. Keep the result between narrator and reader, focused on scene craft.';
    assert.equal(isRetiredBundledPrompt('tpl-directors-commentary-companion', oldDirector), true);
    assert.equal(isRetiredBundledPrompt('tpl-continuity-companion', oldDirector), false);
    assert.equal(isRetiredBundledPrompt('tpl-directors-commentary-companion', `${oldDirector} Be kind.`), false);
    const oldCompanion = 'Read the latest assistant reply and recent context as a continuity auditor. Write a concise side note for the user. Focus on contradictions, unresolved promises, changed locations, injuries, inventory, relationship shifts, and setup that may matter in the next few turns. Use 3-6 bullets. If everything is stable, write: Continuity looks stable.';
    assert.equal(isRetiredBundledPrompt('tpl-continuity-companion', oldCompanion), true);
    assert.equal(isRetiredBundledPrompt('tpl-continuity-corrector', oldCompanion), false);
    assert.equal(isRetiredBundledPrompt('tpl-continuity-companion', `${oldCompanion} Also list weather.`), false);
});

test('an untouched Chatroom v3 prompt takes the board-post wording and stays v3', () => {
    const template = readTemplate('chatroom-companion.json');
    assert.equal(template.version, 3);
    assert.equal(isRetiredBundledPrompt(template.id, template.prompt), false);
    const oldSentence = 'Each chatroom line is one complete post with its post/comment field on that same line. Greentext is the one exception: a greentext story is ONE post. Put its first > line in the post/comment field, then put each further > line on its own line directly below, with no chatroom| prefix. Keep one greentext story inside one post.';
    const oldBoard = 'the panel shows it as >>84920113. Bring greentext stories,';
    const oldPrompt = template.prompt
        .replace(/Every post opens on its own chatroom\| or chatroom-reply\| line[\s\S]*?so start every new post with its prefix\./, oldSentence)
        .replace(/the panel shows it as >>84920113\. A greentext post[\s\S]*?Bring greentext stories,/, oldBoard);
    assert.notEqual(oldPrompt, template.prompt);
    assert.equal(isRetiredBundledPrompt(template.id, oldPrompt), true);
    assert.equal(isRetiredBundledPrompt(template.id, `${oldPrompt} `), false);
});

test('Director\'s Commentary asks for criticism, not only praise', () => {
    const director = readTemplate('directors-commentary-companion.json').prompt;
    assert.match(director, /neutral observer, not a fan/);
    assert.match(director, /ridiculous/);
    assert.match(director, /something the reply actually does/);
});
