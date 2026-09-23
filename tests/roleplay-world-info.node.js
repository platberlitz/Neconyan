/* eslint playwright/expect-expect: off -- Node assertions exercise server scans. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { scanWorldInfo } from '../src/generation/world-info-scan.js';
import { assertWorldInfoDepthHistory, insertWorldInfoDepth } from '../src/generation/roleplay-prompt.js';
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

test('a scan without selected entries does not call the per-pass hook', async () => {
    let calls = 0;
    const result = await scan([], { onScan: () => { calls++; } });
    assert.equal(calls, 0);
    assert.equal(result.iterations, 0);
});

test('a saved null timed window uses the same empty metadata as the browser', async () => {
    const result = await scan([entry(1, 'cat', 'Sticky lore', { sticky: 2 })], {
        metadata: { timedWorldInfo: null },
    });
    assert.equal(result.worldInfoBefore, 'Sticky lore');
    assert.equal(result.timedWorldInfo.sticky['Town.1'].end, 3);
});

test('saved depth injections preserve the system prefix and browser history order', () => {
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Latest' }];
    const inserted = insertWorldInfoDepth(messages, [
        { depth: 0, role: 0, entries: ['After latest'] },
        { depth: 1, role: 1, entries: ['Before latest'] },
        { depth: 3, role: 2, entries: ['Before first'] },
    ], 1);
    assert.deepEqual(inserted.map(value => value.content), ['Rules', 'Before first', 'First', 'Reply',
        'Before latest', 'Latest', 'After latest']);
    assert.deepEqual(messages.map(value => value.content), ['Rules', 'First', 'Reply', 'Latest']);
    assert.throws(() => insertWorldInfoDepth(messages, [{ depth: 1, role: 5, entries: ['bad'] }], 1),
        { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoDepth(messages, [{ depth: 1, role: '0', entries: ['lost'] }], 1),
        { code: 'ROLEPLAY_INVALID' });
});

test('depth placement refuses unhandled saved attachments and a fabricated empty history', t => {
    const f = fixture(t);
    assert.throws(() => assertWorldInfoDepthHistory(f.records, [{ role: 'user', content: 'Original' }], 0),
        { code: 'ROLEPLAY_INVALID' });
    f.records[1].extra = {};
    assert.throws(() => assertWorldInfoDepthHistory(f.records, [{ role: 'system', content: 'Forged' }], 1),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('server selection recurses on saved text and places entries with a bounded budget', async () => {
    const result = await scan([entry(1, 'cat', 'The moon is bright'), entry(2, 'moon', 'A gate opens')]);
    assert.deepEqual(result.activated.map(value => value.uid), [1, 2]);
    assert.equal(result.worldInfoBefore, 'A gate opens\nThe moon is bright');
    assert.equal(result.iterations, 3);
});

test('an activated automation is identified before a bound provider can run', async () => {
    const result = await scan([entry(1, 'cat', 'Execute this', { automationId: 'quick-reply-1' })]);
    assert.equal(result.activated[0].automationId, 'quick-reply-1');
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

test('group scoring ignores blank secondary keys before comparing complete matches', async () => {
    const first = entry(1, 'cat', 'One', { group: 'choice', keysecondary: ['{{blank}}', 'runs'], selectiveLogic: 3 });
    const second = entry(2, 'cat', 'Two', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 2 });
    const result = await scan([first, second], { settings: { ...settings, world_info_use_group_scoring: true },
        substitute: key => key === '{{blank}}' ? '' : key });
    assert.deepEqual(result.activated.map(value => value.uid), [1]);
});

test('group scoring gives no weight to an entry with only blank primary keys', async () => {
    const blank = entry(1, 'cat', 'Blank primary', { group: 'choice', key: ['{{blank}}'],
        keysecondary: ['runs'], selectiveLogic: 0, constant: true });
    const matching = entry(2, 'cat', 'Matching primary', { group: 'choice' });
    const result = await scan([blank, matching], { settings: { ...settings, world_info_use_group_scoring: true },
        substitute: key => key === '{{blank}}' ? '' : key });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('group scoring treats a malformed primary key list as no keys', async () => {
    const malformed = entry(1, 'cat', 'Malformed', { group: 'choice', key: 'cat', constant: true });
    const matching = entry(2, 'cat', 'Matching', { group: 'choice' });
    const result = await scan([malformed, matching], { settings: { ...settings, world_info_use_group_scoring: true } });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('a malformed trigger field does not act as a browser generation trigger filter', async () => {
    const result = await scan([entry(1, 'cat', 'Kept', { triggers: 'swipe' })], { global: { trigger: 'normal' } });
    assert.deepEqual(result.activated.map(value => value.uid), [1]);
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

test('a scan hook cannot expand its budget or recursive text beyond the saved context limit', async () => {
    const entries = [entry(1, 'cat', 'Present'), entry(2, 'Present', 'Long '.repeat(100))];
    await assert.rejects(scan(entries, { onScan: hook => { hook.budget.current = 10000; } }),
        { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entries[0]], { onScan: hook => { hook.activated.text = 'Unbudgeted '.repeat(100); } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot replace its saved activation set with an unselected entry', async () => {
    const selected = entry(1, 'cat', 'Selected');
    const foreign = entry(2, 'cat', 'Unsaved');
    await assert.rejects(scan([selected], { onScan: hook => { hook.activated.entries.add(foreign); } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot change an accepted entry after its token budget was checked', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Short')], { onScan: hook => {
        if (hook.new.successful.length) hook.new.successful[0].content = 'Unbudgeted '.repeat(100);
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot invent a timed effect outside a recorded activation', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Short')], { onScan: hook => {
        hook.timedEffects.metadata.sticky['Town.1'] = { hash: 1, start: 2, end: 200, protected: true };
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot bypass a saved cooldown during a later pass', async () => {
    const blocked = entry(2, 'cat', 'Blocked', { cooldown: 3 });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), blocked], {
        metadata: { timedWorldInfo: { cooldown: { 'Town.2': { hash: 2, start: 1, end: 4, protected: true } } } },
        onScan: hook => { hook.timedEffects.active.cooldown.clear(); },
    }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot invent delayed recursion levels or move the saved level', async () => {
    const delayed = entry(2, 'cat', 'Later', { delayUntilRecursion: 2 });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), delayed], { onScan: hook => {
        hook.recursionDelay.availableLevels.push(999);
    } }), { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), delayed], { onScan: hook => {
        hook.recursionDelay.currentLevel = 999;
    } }), { code: 'ROLEPLAY_INVALID' });
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

test('saved books and outlets named like object properties keep their own content', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, '__proto__.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Prototype lore', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['__proto__'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(Object.hasOwn(snapshot.bookHashes, '__proto__'), true);
    assert.equal((await prepareRoleplayWorldInfo(f.scope, snapshot)).worldInfoBefore, 'Prototype lore');
    const outlet = await scan([entry(2, 'cat', 'Outlet lore', { position: 7, outletName: 'constructor' })]);
    assert.deepEqual(outlet.outletEntries.constructor, ['Outlet lore']);
});

test('an entries-loaded hook cannot add a book entry outside the saved selection', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'cat', 'Allowed', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot, { onEntriesLoaded: lore => {
        lore.globalLore.push(entry(2, 'cat', 'Not in the saved book'));
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan refuses book edits made while an asynchronous hook is running', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const filename = path.join(f.scope.directories.worlds, 'Town.json');
    const book = { entries: { 1: entry(1, 'Original', 'Saved lore', { world: undefined, hash: undefined }) } };
    fs.writeFileSync(filename, JSON.stringify(book));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot, { onScan: async () => {
        book.entries[1].content = 'Changed during hook';
        fs.writeFileSync(filename, JSON.stringify(book));
    } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
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

test('a saved swipe trigger selects only swipe lore and remains bound to that effect', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Swipe lore', { world: undefined, hash: undefined, triggers: ['swipe'] }),
        2: entry(2, 'Original', 'Normal lore', { world: undefined, hash: undefined, triggers: ['normal'] }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const swipe = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100, trigger: 'swipe' });
    assert.equal((await prepareRoleplayWorldInfo(f.scope, swipe)).worldInfoBefore, 'Swipe lore');
    assert.equal((await prepareRoleplayWorldInfo(f.scope, captureRoleplayWorldInfo(f.scope, account, source,
        { avatar: 'Nova.png', maxContext: 100 }))).worldInfoBefore, 'Normal lore');
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account, source,
        { avatar: 'Nova.png', maxContext: 100, trigger: 'quiet' }), { code: 'ROLEPLAY_INVALID' });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo: swipe };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'wrong-trigger', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('saved World Info prompt transformations apply before the scan is saved', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'The old harbour', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        extension_settings: { regex: [{ findRegex: '/old/g', replaceString: 'new', placement: [5],
            promptOnly: true, markdownOnly: false }] },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    const selected = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.equal(selected.worldInfoBefore, 'The new harbour');
});

test('a macro-dependent World Info transformation refuses before dispatch', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'The old harbour', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        extension_settings: { regex: [{ findRegex: '/old/g', replaceString: '{{user}}', placement: [5],
            promptOnly: true, markdownOnly: false }] },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_INVALID' });
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
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
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
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Forged' }],
        historyStart: 0, maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let hooks = 0;
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.ok(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'));
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    const valid = { ...request, messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }] };
    const admitted = admitRoleplayJob(f.scope, account, { operationKey: 'lore-bound', effect: 'append', source, request: valid });
    releaseJob(f.scope.directories, admitted.jobId);
    const boundContext = { ...context, job: getJob(f.scope.directories, admitted.jobId) };
    const options = { worldInfoHooks: { onScan: async () => { hooks++; } },
        generate: async ({ beforeDispatch, messages }) => {
            beforeDispatch();
            assert.equal(readArtifact(f.scope.directories, admitted.jobId, 'roleplay-world-info').activated[0].uid, 7);
            assert.deepEqual(messages[0], { role: 'system', content: 'The harbour is safe' });
            assert.equal(valid.messages[0].content, 'Original');
            if (++calls === 1) throw new Error('Provider never reached');
            return { text: 'The answer' };
        } };
    await assert.rejects(runRoleplayReplyJob(boundContext, options), /Provider never reached/);
    await runRoleplayReplyJob(boundContext, options);
    assert.equal(hooks, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'The answer');
    assert.equal(readRoleplayChat(f.scope, f.locator).records[0].chat_metadata.timedWorldInfo.sticky['Town.7'].end, 4);
});

test('a selected Quick Reply automation refuses before paid provider work', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Automated lore', { world: undefined, hash: undefined, automationId: 'quick-reply-1' }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' },
        messages: [{ role: 'user', content: 'Original' }], maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'automation-lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
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

test('a group World Info selection cannot borrow a character outside its saved members', async t => {
    const f = fixture(t, true);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Outside.png'), writeCard(png, JSON.stringify({
        name: 'Outside', description: 'A different group member',
    })));
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Outside.png', maxContext: 100 }),
        { code: 'ROLEPLAY_INVALID' });
});

test('unsupported insertion positions refuse before provider dispatch and before changing the chat', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
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
    const bound = { ...request, historyStart: 0, messages: [{ role: 'user', content: 'Original' },
        { role: 'assistant', content: 'Answer' }] };
    const forged = admitRoleplayJob(f.scope, account, { operationKey: 'depth-forged', effect: 'append', source,
        request: { ...bound, messages: [{ role: 'user', content: 'Forged' }] } });
    releaseJob(f.scope.directories, forged.jobId);
    await assert.rejects(runRoleplayReplyJob({ ...context, job: getJob(f.scope.directories, forged.jobId) },
        { generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const admitted = admitRoleplayJob(f.scope, account, { operationKey: 'depth-bound', effect: 'append', source, request: bound });
    releaseJob(f.scope.directories, admitted.jobId);
    const next = { ...context, job: getJob(f.scope.directories, admitted.jobId) };
    await runRoleplayReplyJob(next, { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(value => value.content), ['A note', 'Original', 'Answer']);
        return { text: 'Answer' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Answer');
});

test('a saved timed window refuses delivery after the chat grows while the provider was away', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
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
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100, trigger: 'swipe' });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
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
