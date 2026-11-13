/* eslint playwright/expect-expect: off -- These checks use node:assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { newState, putRecord, sourceAt, syncSources, validateRecord } = await import('../src/mewmory/core.js');
const { activeReferences, assembleContext, playerReferences } = await import('../src/mewmory/context.js');
const { defaultConfig, saveConfig } = await import('../src/mewmory/models.js');
const { processBatch, interviewInput } = await import('../src/mewmory/processing.js');
const { loadCurrentState, readContextSourcesSync } = await import('../src/mewmory/sources.js');
const { mutateState, writeJson } = await import('../src/mewmory/store.js');
const { searchDocuments } = await import('../src/mewmory/search.js');
const { PLAYER_REFERENCE_GUIDANCE } = await import('../src/mewmory/contracts.js');

const locator = { avatar: 'Mara.png', chat: 'Gift', group: false };
const messages = [
    { name: 'Robin', is_user: true, mes: 'I wear a blue coat and carry the brass key.' },
    { name: 'Mara', is_user: false, mes: 'Mara waits by the harbour.' },
    { name: 'Robin', is_user: true, mes: 'I give Mara the key.' },
];
const persona = { id: 'character:player', type: 'character', entityId: 'player', name: 'Robin', text: 'Robin is a mapmaker with a blue coat.' };
const counter = { name: 'test', count: value => value.length };

function disk(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-player-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const directories = { root, ...Object.fromEntries(['chats', 'groupChats', 'groups', 'worlds', 'characters', 'files', 'avatars']
        .map(name => [name, path.join(root, name)])) };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'Mara'));
    fs.writeFileSync(path.join(directories.chats, 'Mara', 'Gift.jsonl'), [{ chat_metadata: {} }, ...messages].map(JSON.stringify).join('\n'));
    return directories;
}

test('the chat-locked persona supplies player details, selected appendices and its own lorebook', t => {
    const directories = disk(t);
    for (const avatar of ['robin.png', 'other.png']) fs.writeFileSync(path.join(directories.avatars, avatar), 'avatar');
    writeJson(path.join(directories.root, 'settings.json'), {
        username: 'Other', user_avatar: 'other.png', power_user: {
            default_persona: 'other.png', persona_description_lorebook: 'Other lore', personas: { 'robin.png': 'Robin' },
            persona_descriptions: {
                'robin.png': { description: persona.text, lorebook: 'Robin lore', appendices: [
                    { id: 'work', name: 'At work', description: 'Robin carries a compass.' },
                    { id: 'secret', name: 'Elsewhere', description: 'UNSELECTED APPENDIX' },
                ] },
                'other.png': { description: 'UNRELATED PERSONA', lorebook: 'Other lore' },
            },
        },
    });
    for (const name of ['Robin lore', 'Other lore']) writeJson(path.join(directories.worlds, name + '.json'), {
        entries: { 0: { comment: name, content: name + ' fact', key: [] } },
    });
    const source = { metadata: { persona: 'robin.png', persona_appendices: { 'robin.png': ['work'] } }, messages };
    const sources = readContextSourcesSync(directories, locator, newState(locator), source);
    const player = sources.find(item => item.entityId === 'player');
    assert.equal(player.name, 'Robin');
    assert.match(player.text, /mapmaker/);
    assert.match(player.text, /carries a compass/);
    assert.doesNotMatch(JSON.stringify(sources), /UNSELECTED|UNRELATED|Other lore/);
    assert.ok(sources.some(item => item.meta.world === 'Robin lore'));

    const state = newState(locator);
    syncSources(state, messages, sources);
    const ref = state.contextSources.find(ref => sourceAt(state, ref).entityId === 'player');
    putRecord(state, validateRecord(state, { id: 'entity:player', kind: 'entity', entityId: 'player', name: 'Robin', text: player.text,
        isCharacter: true, refs: [ref] }, { asOf: -1 }));
    assert.equal(playerReferences(state).records[0].isCharacter, false);
    source.metadata.persona = 'other.png';
    syncSources(state, messages, readContextSourcesSync(directories, locator, state, source));
    assert.equal(playerReferences(state).text, '', 'changing persona invalidates the old persona-backed reference');
});

test('group-bound personas take precedence over the last active persona', t => {
    const directories = disk(t);
    fs.writeFileSync(path.join(directories.avatars, 'robin.png'), 'avatar');
    writeJson(path.join(directories.groups, 'party.json'), { id: 'party', chat_id: 'Group story', members: [] });
    writeJson(path.join(directories.root, 'settings.json'), { username: 'Other', power_user: {
        persona_description: 'UNRELATED ACTIVE DESCRIPTION', personas: { 'robin.png': 'Robin' },
        persona_descriptions: { 'robin.png': { description: persona.text, connections: [{ id: 'party' }] } },
    } });
    const group = { group: true, chat: 'Group story' };
    const sources = readContextSourcesSync(directories, group, newState(group), { metadata: {}, messages });
    assert.equal(sources.find(item => item.entityId === 'player').text, persona.text);
    assert.doesNotMatch(JSON.stringify(sources), /UNRELATED/);
});

test('extraction receives the player persona without making the player an NPC or an interview owner', async t => {
    const directories = disk(t);
    writeJson(path.join(directories.root, 'settings.json'), { username: 'Robin', power_user: { persona_description: persona.text } });
    const config = defaultConfig();
    for (const role of ['extractor', 'pawspective']) Object.assign(config.roles[role], { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: role });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const calls = [];
    const state = await processBatch(directories, locator, {}, async (_directories, _config, role, contract, input) => {
        calls.push(role);
        assert.equal(role, 'extractor');
        assert.match(contract, /thoughts, feelings or intentions only when the user explicitly states them/);
        assert.equal(input.sources.find(item => item.entityId === 'player').text, persona.text);
        assert.ok(input.sources.some(item => item.type === 'chat' && item.isPlayer));
        assert.equal(input.existing.find(item => item.entityId === 'player').isCharacter, false);
        const refs = input.sources.filter(item => item.type === 'chat').map(({ id, revision }) => ({ id, revision }));
        return { value: {
            records: [{ id: 'state:player', kind: 'state', entityId: 'player', text: 'Robin has given Mara the key.', refs }],
            activeNpcIds: ['player'], interviews: [{ ownerId: 'player', subjectIds: ['npc:mara'], refs, reason: 'Invent a private reaction.' }],
        }, usage: { role } };
    });
    assert.deepEqual(calls, ['extractor']);
    assert.deepEqual(activeReferences(state).ids, []);
    assert.match(playerReferences(state).text, /mapmaker/);
    assert.match(playerReferences(state).text, /given Mara the key/);
    assert.equal(state.records.some(item => item.kind === 'interview'), false);
    assert.throws(() => interviewInput(state, { ownerId: 'player', subjectIds: ['npc:mara'] }, 2), /not a known AI character/);
});

function referenceState() {
    const state = newState(locator);
    syncSources(state, messages, [persona]);
    const add = (record, asOf, refs = [state.timeline[asOf]]) => putRecord(state,
        validateRecord(state, { ...record, refs }, { asOf, origin: 'extractor' }), { automatic: true });
    add({ id: 'entity:player', kind: 'entity', entityId: 'player', name: 'Robin', text: 'Robin is a mapmaker.',
        appearance: 'Blue coat', speech: 'Brief, direct sentences', isCharacter: true }, -1, state.contextSources);
    add({ id: 'state:player', kind: 'state', entityId: 'player', text: 'Robin carries the brass key.' }, 0);
    add({ id: 'state:player', kind: 'state', entityId: 'player', text: 'Robin no longer holds the brass key.' }, 2);
    add({ id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara is an archivist.', isCharacter: true }, 1);
    add({ id: 'event:key', kind: 'event', text: 'Robin gives Mara the key.', subjectIds: ['player', 'npc:mara'] }, 2);
    add({ id: 'interview:mara', kind: 'interview', ownerId: 'npc:mara', subjectIds: ['player'],
        text: 'Mara hopes Robin will stay.', searchDescription: 'Mara’s hopes about Robin',
        interview: [{ question: 'What do you hope?', answer: 'I hope Robin will stay.' }] }, 2);
    return state;
}

test('player references survive an empty NPC selection and tiny recall budget, with historical and excluded evidence respected', () => {
    const state = referenceState();
    state.activeNpcIds = [];
    const result = assembleContext(state, [], { counter, memoryTokens: 1 });
    assert.deepEqual(result.activeNpcIds, []);
    assert.match(result.npcText, /user-controlled player reference/);
    assert.match(result.npcText, /Blue coat/);
    assert.match(result.npcText, /Brief, direct sentences/);
    assert.match(result.npcText, /no longer holds/);
    assert.ok(result.npcText.includes(PLAYER_REFERENCE_GUIDANCE));
    assert.equal(result.tokens.npc, counter.count(result.npcText));
    assert.equal(result.memoryText, '');
    assert.match(playerReferences(state, 0).text, /carries the brass key/);
    assert.doesNotMatch(playerReferences(state, 0).text, /no longer/);
    state.excludedSources.push(state.contextSources[0].id);
    assert.doesNotMatch(playerReferences(state).text, /mapmaker|Blue coat/);
    state.excludedSources.push(...state.timeline.map(ref => ref.id));
    assert.equal(playerReferences(state).text, '');
});

test('writer and isolated agent memory channels preserve user authorship, even when only NPC beliefs are recalled', () => {
    const state = referenceState();
    const documents = searchDocuments(state);
    const result = assembleContext(state, documents, { counter, memoryTokens: 100000 });
    for (const field of ['npcText', 'memoryText', 'factsText', 'interviewText']) {
        assert.ok(result[field].includes(PLAYER_REFERENCE_GUIDANCE), field + ' must carry the player boundary');
        assert.match(result[field], /unless they explicitly ask you to write them/);
    }
    assert.match(result.memoryText, /User-controlled player persona excerpt/);
    state.records = state.records.filter(item => item.entityId !== 'player');
    const isolated = assembleContext(state, documents.filter(item => item.recordId === 'interview:mara'), { counter });
    assert.ok(isolated.interviewText.includes(PLAYER_REFERENCE_GUIDANCE));
    assert.match(isolated.interviewText, /I hope Robin will stay/);
});
