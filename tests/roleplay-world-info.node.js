/* eslint playwright/expect-expect: off -- Node assertions exercise server scans. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { scanWorldInfo } from '../src/generation/world-info-scan.js';
import { write as writeCard } from '../src/character-card-parser.js';

const { captureRoleplayWorldInfo, prepareRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { admitRoleplayJob, applyRoleplayJobEffect } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');

const settings = { world_info_depth: 2, world_info_budget: 100, world_info_budget_cap: 0,
    world_info_recursive: true, world_info_min_activations: 0, world_info_case_sensitive: false,
    world_info_match_whole_words: false, world_info_use_group_scoring: false };
const entry = (uid, key, content, more = {}) => ({ world: 'Town', uid, hash: uid, key: [key],
    keysecondary: [], content, position: 0, probability: 100, useProbability: true, order: 10 - uid,
    decorators: [], ...more });
const scan = (entries, overrides = {}) => scanWorldInfo({ entries, chat: ['A cat runs'], metadata: {}, settings,
    maxContext: 100, countTokens: async text => text.length, ...overrides });

test('server selection recurses on saved text and places entries with a bounded budget', async () => {
    const result = await scan([entry(1, 'cat', 'The moon is bright'), entry(2, 'moon', 'A gate opens')]);
    assert.deepEqual(result.activated.map(value => value.uid), [1, 2]);
    assert.equal(result.worldInfoBefore, 'A gate opens\nThe moon is bright');
    assert.equal(result.iterations, 3);
});

test('probability, group choices and timed cooldowns use repeatable draws', async () => {
    const entries = [entry(1, 'cat', 'First', { group: 'one', groupWeight: 1, probability: 50 }),
        entry(2, 'cat', 'Second', { group: 'one', groupWeight: 3, cooldown: 3 })];
    const options = { random: () => 0.75, metadata: { timedWorldInfo: { sticky: {}, cooldown: {} } } };
    const selected = await scan(entries, options);
    assert.deepEqual(selected.activated.map(value => value.uid), [2]);
    assert.deepEqual(await scan(entries, options), selected);
    const blocked = await scan(entries, { ...options, random: () => 0.2, metadata: { timedWorldInfo: { sticky: {}, cooldown: {
        'Town.2': { hash: 2, start: 1, end: 4, protected: true },
    } } } });
    assert.deepEqual(blocked.activated.map(value => value.uid), [1]);
    assert.equal(blocked.draws.length, 1);
});

test('group scoring counts secondary hits only for the browser positive selection logic', async () => {
    const first = entry(1, 'cat', 'Primary only', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 2 });
    const second = entry(2, 'cat', 'Positive secondary', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 0 });
    const result = await scan([first, second], { settings: { ...settings, world_info_use_group_scoring: true } });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('the scan hook can change the next state and budget before any provider call', async () => {
    let calls = 0;
    const result = await scan([entry(1, 'cat', 'Present')], { onScan: async hook => {
        calls++;
        hook.state.next = 0;
    } });
    assert.equal(calls, 1);
    assert.equal(result.iterations, 1);
});

test('scan hooks and random choices cannot escape bounded saved decision states', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Present', { probability: 50 })], { random: () => NaN }),
        { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entry(1, 'cat', 'Present')], { onScan: hook => { hook.state.next = 99; } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('the account captures saved books and refuses a changed book before the provider runs', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const filename = path.join(f.scope.directories.worlds, 'Town.json');
    const book = { entries: { 7: entry(7, 'Original', 'The harbour is safe', { world: undefined, hash: undefined }) } };
    fs.writeFileSync(filename, JSON.stringify(book));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 2, world_info_budget: 100,
            world_info_recursive: true },
    }));
    const snapshot = captureRoleplayWorldInfo(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(snapshot.bookHashes.Town.length, 64);
    const first = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.deepEqual(first.activated.map(value => value.uid), [7]);
    assert.equal(first.worldInfoBefore, 'The harbour is safe');
    assert.deepEqual(await prepareRoleplayWorldInfo(f.scope, snapshot), first);
    book.entries[7].content = 'Other harbour';
    fs.writeFileSync(filename, JSON.stringify(book));
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a saved scan refuses changed settings or a reset before reading new account books', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {} }));
    const filename = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['Town'] } } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    fs.writeFileSync(filename, JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 3 } }));
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    resetRoleplayAccount(f.scope, account, 'reset');
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('a fabricated scan input cannot replace saved chat or lore controls before dispatch', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    const fabricated = structuredClone(snapshot);
    fabricated.chat = ['Invented keyword'];
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, fabricated), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fabricated.chat = snapshot.chat;
    fabricated.global.personaDescription = 'Invented persona';
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, fabricated), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('saved default name inclusion activates speaker keys before provider work', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'User:', 'The user speaks', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.ok(snapshot.chat.some(line => line.startsWith('User:')));
    const selected = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.equal(selected.worldInfoBefore, 'The user speaks');
});

test('saved persona, card notes and character tags decide activation without browser state', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', creator_notes: 'The sentinel', data: { name: 'Nova', creator_notes: 'The sentinel',
            extensions: { depth_prompt: { prompt: 'The beacon' } } },
    })));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'The visitor', 'Persona lore', { matchPersonaDescription: true }),
        2: entry(2, 'The sentinel', 'Notes lore', { matchCreatorNotes: true }),
        3: entry(3, 'The beacon', 'Depth lore', { matchCharacterDepthPrompt: true }),
        4: entry(4, 'Original', 'Filtered lore', { characterFilter: { tags: ['absent'], isExclude: false } }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { persona_description: 'The visitor' },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(snapshot.global.personaDescription, 'The visitor');
    assert.equal(snapshot.global.creatorNotes, 'The sentinel');
    assert.equal(snapshot.global.characterDepthPrompt, 'The beacon');
    const result = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.deepEqual(result.activated.map(value => value.uid), [1, 2, 3]);
});

test('the worker saves scan decisions before a provider call and closes timed effects with the reply', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        7: entry(7, 'Original', 'The harbour is safe', { hash: undefined, world: undefined, sticky: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 2, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let hooks = 0;
    let calls = 0;
    const options = { worldInfoHooks: { onScan: async () => { hooks++; } },
        generate: async ({ beforeDispatch, messages }) => {
            beforeDispatch();
            assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info').activated[0].uid, 7);
            assert.deepEqual(messages[0], { role: 'system', content: 'The harbour is safe' });
            assert.equal(request.messages[0].content, 'Original');
            if (++calls === 1) throw new Error('Provider never reached');
            return { text: 'The answer' };
        } };
    await assert.rejects(runRoleplayReplyJob(context, options), /Provider never reached/);
    await runRoleplayReplyJob(context, options);
    assert.equal(hooks, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'The answer');
    assert.equal(readRoleplayChat(f.scope, f.locator).records[0].chat_metadata.timedWorldInfo.sticky['Town.7'].end, 4);
});

test('a saved World Info selection cannot name another chat in a paid Roleplay job', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' },
        messages: [{ role: 'user', content: 'Original' }], maxTokens: 32, characterName: 'Nova',
        worldInfo: { account, source: { ...source, locator: { ...source.locator, chat: 'Other' } },
            avatar: 'Nova.png' } };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'foreign-lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('unsupported insertion positions refuse before provider dispatch and before changing the chat', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'A note', { position: 4, depth: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'depth', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw new Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.ok(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'));
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

test('a saved timed window refuses delivery after the chat grows while the provider was away', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'A note', { sticky: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 0 });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'timed-swipe', effect: 'swipe', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => { throw Error('outcome unknown'); } }), /outcome unknown/);
    const saved = readArtifact(f.scope.directories, jobId, 'roleplay-world-info');
    assert.equal(saved.chatLength, 2);
    const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
    const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
    commitSingleChatWrite(f.scope, { operationKey: 'unrelated', sourceKind: 'storage', mode: 'update',
        source: captureRoleplayStorageSource(f.scope, f.locator),
        records: [...readRoleplayChat(f.scope, f.locator).records, { name: 'User', is_user: true, mes: 'Later' }],
        backup: { deferBackup: true } }, roleplayNativeHost);
    assert.throws(() => applyRoleplayJobEffect(f.scope, account, { operationKey: 'timed-swipe', jobId,
        output: { text: 'Later swipe', timedWorldInfo: saved.timedWorldInfo,
            timedBaseline: saved.timedBaseline, timedChatLength: saved.chatLength } }, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length + 1);
});
