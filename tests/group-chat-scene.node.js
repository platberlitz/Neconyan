import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { appendGroupSpeakerStops, buildOwnLinesReminder, getOtherMemberNames, isKeepOwnLinesEnabled } from '../public/scripts/group-chat-scene.js';
import { cleanGeneratedText } from '../public/scripts/generation-format.js';

test('keep own lines is on unless a group turns it off', () => {
    assert.equal(isKeepOwnLinesEnabled({}), true);
    assert.equal(isKeepOwnLinesEnabled({ keep_own_lines: true }), true);
    assert.equal(isKeepOwnLinesEnabled({ keep_own_lines: false }), false);
});

test('other member names drop the speaker, blanks and repeats', () => {
    assert.deepEqual(getOtherMemberNames(['Mira', 'Kit', '', 'Kit', 'Nova'], 'Mira'), ['Kit', 'Nova']);
});

test('speaker stops fill only the room the provider leaves after custom stops', () => {
    assert.deepEqual(appendGroupSpeakerStops(['END'], ['Kit', 'Nova', 'Ash', 'Bo'], 4), ['END', '\nKit:', '\nNova:', '\nAsh:']);
    assert.deepEqual(appendGroupSpeakerStops(['A', 'B', 'C', 'D'], ['Kit'], 4), ['A', 'B', 'C', 'D']);
    assert.deepEqual(appendGroupSpeakerStops(['\nKit:'], ['Kit', 'Nova'], undefined), ['\nKit:', '\nNova:']);
});

test('own lines reminder names the other members and the user', () => {
    const text = buildOwnLinesReminder('Mira', ['Kit', 'Nova'], 'Ana');
    assert.match(text, /Never write dialogue, actions or thoughts for Kit, Nova, Ana/);
    assert.equal(buildOwnLinesReminder('Mira', [], ''), '');
});

test('cleanup cuts at markdown-styled member names only when asked', () => {
    const reply = 'Mira smiles.\n**Kit:** I will answer for Kit.';
    const base = { power: {}, name1: 'Ana', name2: 'Mira', groupNames: ['Mira', 'Kit'], trimSentence: value => value };
    assert.equal(cleanGeneratedText(reply, base), reply);
    assert.equal(cleanGeneratedText(reply, { ...base, trimMarkdownNames: true }), 'Mira smiles.');
    assert.equal(cleanGeneratedText('Mira waves.\nKit: hi', base), 'Mira waves.');
    assert.equal(cleanGeneratedText('Mira waves.\n  *Kit*: hi', { ...base, trimMarkdownNames: true }), 'Mira waves.');
    assert.equal(cleanGeneratedText('Mira says Kit: is a word.', { ...base, trimMarkdownNames: true }), 'Mira says Kit: is a word.');
});

test('group generation wires the own-lines stops, reminder and setting', () => {
    const groupChats = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
    const openai = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/endpoints/groups.js', import.meta.url), 'utf8');
    assert.match(openai, /getStoppingStrings: limit => getGroupSpeakerStopStrings\(getCustomStoppingStrings\(limit\), limit, type\)/);
    assert.match(script, /trimMarkdownNames: shouldTrimGroupMarkdownNames\(\)/);
    assert.match(groupChats, /ownLines: isKeepOwnLinesEnabled\(group\)/);
    assert.match(groupChats, /\$\('#rm_group_keep_own_lines'\)\.on\('input', onGroupKeepOwnLinesClick\)/);
    assert.match(html, /<input id="rm_group_keep_own_lines" type="checkbox" checked \/>/);
    assert.match(server, /keep_own_lines: body\.keep_own_lines !== false/);
});
