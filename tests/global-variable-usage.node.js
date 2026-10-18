import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import PNGtext from 'png-chunk-text';

import encode from '../src/png/encode.js';
import { collectGlobalVariableReferences, findUnusedGlobalVariables, readCardText } from '../src/global-variable-usage.js';
import { read as readCharacterCard } from '../src/character-card-parser.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

function references(text) {
    const names = new Set();
    collectGlobalVariableReferences(text, names);
    return names;
}

function characterPng(card) {
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 1);
    new DataView(ihdr.buffer).setUint32(4, 1);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chara = PNGtext.encode('chara', Buffer.from(JSON.stringify(card)).toString('base64'));
    return Buffer.from(encode([
        { name: 'IHDR', data: ihdr },
        { name: 'IDAT', data: new Uint8Array(4096) },
        { name: 'tEXt', data: chara.data },
        { name: 'IEND', data: new Uint8Array(0) },
    ]));
}

function makeUser() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-variable-usage-'));
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const [key, directory] of Object.entries(directories)) {
        if (key !== 'root') {
            fs.mkdirSync(directory, { recursive: true });
        }
    }
    return { root, directories };
}

test('macro, command and shorthand forms all count as references', () => {
    assert.ok(references('{{getglobalvar::mood}}').has('mood'));
    assert.ok(references('{{setglobalvar::score::10}}').has('score'));
    assert.ok(references('{{ incglobalvar :: turns }}').has('turns'));
    assert.ok(references('{{getglobalvar::two words}}').has('two words'));
    assert.ok(references('/setglobalvar key=weather rain | /echo done').has('weather'));
    assert.ok(references('/getglobalvar "quoted name"').has('quoted name'));
    assert.ok(references('/flushglobalvar oldflag').has('oldflag'));
    assert.ok(references('{{$tone}} and {{$count++}}').has('tone'));
    assert.ok(references('{{$count++}}').has('count'));
    assert.equal(references('a pov of length 327, written by actors').size, 0);
    assert.equal(references('{{getvar::localonly}}').size, 0);
});

test('the fast card reader returns the same text as the card parser', async () => {
    const { root } = makeUser();
    const file = path.join(root, 'card.png');
    fs.writeFileSync(file, characterPng({ name: 'Nova', data: { description: 'Hi {{$tone}}' } }));
    assert.equal(await readCardText(file), readCharacterCard(fs.readFileSync(file)));
});

test('only names nothing refers to are reported unused', async () => {
    const { root, directories } = makeUser();
    const names = ['preset_kept', 'lore_kept', 'card_kept', 'chat_kept', 'settings_kept', 'agent_kept', 'reply_kept', 'orphan', 'lumia_personality_standard'];

    fs.writeFileSync(path.join(directories.openAI_Settings, 'Preset.json'), JSON.stringify({ prompts: [{ content: 'Mood: {{getglobalvar::preset_kept}}' }] }));
    fs.writeFileSync(path.join(directories.worlds, 'Lore.json'), JSON.stringify({ entries: { 0: { content: '/setglobalvar key=lore_kept yes' } } }));
    fs.writeFileSync(path.join(directories.inChatAgents, 'agent.json'), JSON.stringify({ prompt: '{{hasglobalvar::agent_kept}}' }));
    fs.writeFileSync(path.join(directories.quickreplies, 'Set.json'), JSON.stringify({ qrList: [{ message: '/addglobalvar key=reply_kept 1' }] }));
    fs.writeFileSync(path.join(directories.characters, 'Nova.png'), characterPng({ name: 'Nova', data: { description: '{{$card_kept}}' } }));
    fs.mkdirSync(path.join(directories.chats, 'Nova'), { recursive: true });
    fs.writeFileSync(path.join(directories.chats, 'Nova', 'chat.jsonl'), [
        JSON.stringify({ chat_metadata: { note_prompt: 'Keep {{getglobalvar::chat_kept}} in mind' } }),
        JSON.stringify({ mes: '{{getglobalvar::orphan}} in a message does not count' }),
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        extension_settings: {
            regex: [{ replaceString: '{{incglobalvar::settings_kept}}' }],
            variables: { global: Object.fromEntries(names.map(name => [name, `{{getglobalvar::${name}}}`])) },
        },
    }));
    fs.writeFileSync(path.join(directories.textGen_Settings, 'broken.json'), '{ not json');

    const result = await findUnusedGlobalVariables({ directories, names });

    assert.deepEqual(result.unused, ['orphan', 'lumia_personality_standard']);
    assert.equal(result.used.length, names.length - 2);
    assert.equal(result.unreadable, 1);
    assert.deepEqual(result.checked, { Preset: 1, Lorebook: 1, 'Quick Reply set': 1, Agent: 1, Character: 1, Chat: 1, Settings: 1 });
});
