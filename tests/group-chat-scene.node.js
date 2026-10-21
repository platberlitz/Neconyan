import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    appendGroupSpeakerStops,
    buildDirectorPrompt,
    buildOwnLinesReminder,
    getGroupTalkBurstCount,
    getOtherMemberNames,
    isKeepOwnLinesEnabled,
    parseDirectorResponse,
    pickNextListSpeaker,
    summariseMemberCard,
} from '../public/scripts/group-chat-scene.js';
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

test('director card summaries keep the first sentence, without markup', () => {
    assert.equal(summariseMemberCard('<b>Mira</b> is a sharp-eyed thief. She hates the rain.'), 'Mira is a sharp-eyed thief.');
    assert.equal(summariseMemberCard(''), '');
    assert.ok(summariseMemberCard('x'.repeat(400)).length <= 140);
});

test('director prompt lists members, recent lines and the JSON answer shape', () => {
    const prompt = buildDirectorPrompt({
        members: [{ name: 'Mira', summary: 'A thief.' }, { name: 'Kit', role: 'narrator' }],
        messages: Array.from({ length: 12 }, (_, index) => ({ name: index % 2 ? 'Mira' : '', isUser: !(index % 2), text: `line ${index}` })),
        userName: 'Ana',
        maxSpeakers: 9,
    });
    assert.equal(prompt.length, 2);
    assert.match(prompt[0].content, /Choose 0 to 3 members/);
    assert.match(prompt[0].content, /Ana is the user; never choose them/);
    assert.match(prompt[0].content, /"speakers"/);
    assert.match(prompt[1].content, /- Mira: A thief\.\n- Kit \(narrator\)/);
    assert.doesNotMatch(prompt[1].content, /line 3\b/);
    assert.match(prompt[1].content, /Ana: line 4\n/);
    assert.match(prompt[1].content, /Mira: line 11\n/);
});

test('director answers map to real members, in order, capped', () => {
    const names = ['Mira', 'Kit', 'Nova', 'Ash'];
    assert.deepEqual(parseDirectorResponse('```json\n{"speakers": ["kit", "Mira"], "reason": "Kit was asked"}\n```', names),
        { speakers: ['Kit', 'Mira'], reason: 'Kit was asked' });
    assert.deepEqual(parseDirectorResponse('{"speakers": ["Kit", "Kit", "Ghost", "Nova", "Ash", "Mira"]}', names).speakers, ['Kit', 'Nova', 'Ash']);
    assert.deepEqual(parseDirectorResponse('{"speaker": "Nova"}', names).speakers, ['Nova']);
    assert.deepEqual(parseDirectorResponse('Nova should answer, then Mira.', names).speakers, ['Nova', 'Mira']);
    assert.deepEqual(parseDirectorResponse('{"speakers": [], "reason": "Mira already spoke"}', names).speakers, []);
    assert.deepEqual(parseDirectorResponse('{"speakers": ["Kit", "Nova"]}', names, 1).speakers, ['Kit']);
    assert.deepEqual(parseDirectorResponse('', names).speakers, []);
    assert.equal(parseDirectorResponse('{"speakers": []}', names).paused, true);
    assert.equal(parseDirectorResponse('{"speakers": ["Ghost"]}', names).paused, undefined);
    assert.equal(parseDirectorResponse('broken answer', names).paused, undefined);
});

test('scene director is wired into the editor, server and new groups', () => {
    const groupChats = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/endpoints/groups.js', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../src/generation/roleplay-workflow-groups.js', import.meta.url), 'utf8');
    const bookmarks = readFileSync(new URL('../public/scripts/bookmarks.js', import.meta.url), 'utf8');
    assert.match(html, /<option value="4" data-i18n="Scene Director">Scene Director<\/option>/);
    assert.match(html, /<select id="rm_group_director_profile"/);
    assert.match(server, /director_profile: typeof body\.director_profile === 'string'/);
    assert.match(workflow, /strategy === 0 \|\| strategy === 4/);
    assert.match(bookmarks, /activation_strategy: group_activation_strategy\.DIRECTOR/);
    assert.match(groupChats, /DIRECTOR: GROUP_DIRECTOR_STRATEGY/);
    assert.match(groupChats, /: group_activation_strategy\.DIRECTOR;/);
    assert.match(groupChats, /runGroupSceneDirector\(group, enabledMembers/);
});

test('let them talk defaults to three replies and never goes past eight', () => {
    assert.equal(getGroupTalkBurstCount({}), 3);
    assert.equal(getGroupTalkBurstCount(null), 3);
    assert.equal(getGroupTalkBurstCount({ talk_burst: 0 }), 3);
    assert.equal(getGroupTalkBurstCount({ talk_burst: 'abc' }), 3);
    assert.equal(getGroupTalkBurstCount({ talk_burst: '5' }), 5);
    assert.equal(getGroupTalkBurstCount({ talk_burst: 4.6 }), 5);
    assert.equal(getGroupTalkBurstCount({ talk_burst: 50 }), 8);
});

test('list order hands the next turn to the member after the last speaker', () => {
    const members = ['a.png', 'b.png', 'c.png'];
    assert.equal(pickNextListSpeaker(members, 'a.png'), 'b.png');
    assert.equal(pickNextListSpeaker(members, 'c.png'), 'a.png');
    assert.equal(pickNextListSpeaker(members, 'user.png'), 'a.png');
    assert.equal(pickNextListSpeaker(members, ''), 'a.png');
});

test('director prompt says when the user is only listening', () => {
    const members = [{ name: 'Mira', summary: '' }, { name: 'Kit', summary: '' }];
    const listening = buildDirectorPrompt({ members, messages: [], userName: 'Sam', continuing: true });
    const normal = buildDirectorPrompt({ members, messages: [], userName: 'Sam' });
    assert.match(listening[0].content, /only listening/);
    assert.doesNotMatch(normal[0].content, /only listening/);
});

test('let them talk is wired into the speaker bar, editor, director and server', () => {
    const groupChats = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/endpoints/groups.js', import.meta.url), 'utf8');
    assert.match(html, /<button type="button" id="group_let_them_talk" class="menu_button menu_button_icon"/);
    assert.match(html, /<input id="rm_group_talk_burst" class="text_pole" type="number" min="1" max="8"/);
    assert.match(server, /talk_burst: Math\.min\(8, Math\.max\(1, Math\.round\(Number\(body\.talk_burst\)\) \|\| 3\)\)/);
    assert.match(groupChats, /container\.on\('click', '#group_let_them_talk', letGroupMembersTalk\);/);
    assert.match(groupChats, /await Generate\('normal', \{ suppressUserMessage: true, suppressAutoContinue: true, signal: burst\.controller\.signal \}\);/);
    assert.match(groupChats, /eventSource\.on\(event_types\.GENERATION_STOPPED, cancel\);/);
    assert.match(groupChats, /eventSource\.on\(event_types\.MESSAGE_SENT, cancel\);/);
    assert.match(groupChats, /continuing: Boolean\(burst\)/);
    assert.match(groupChats, /talk_burst: talkBurst,/);
});
