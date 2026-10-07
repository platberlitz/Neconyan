import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/time-machine.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { write: writeCard } = await import('../src/character-card-parser.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MODULE = 'NeconyanCardTimeMachine';

function prepared(t, module = { keepPerTarget: 1 }) {
    const f = fixture(t, false, 'fixture');
    const dirs = f.scope.directories;
    for (const [key, folder] of [['worlds', 'worlds'], ['files', 'user/files'], ['openAI_Settings', 'OpenAI Settings']]) dirs[key] ??= path.join(dirs.root, folder);
    for (const folder of [dirs.characters, dirs.worlds, dirs.files, dirs.openAI_Settings]) fs.mkdirSync(folder, { recursive: true });
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Nova', data: { name: 'Nova', description: 'An astronaut.' }, chat: 'old' };
    fs.writeFileSync(path.join(dirs.characters, 'nova.png'), writeCard(PNG, JSON.stringify(card)));
    fs.writeFileSync(path.join(dirs.worlds, 'Garden.json'), JSON.stringify({ entries: { 0: { uid: 0, content: 'Roses' } } }));
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Moon.json'), JSON.stringify({ temperature: 0.5 }));
    const settingsPath = path.join(dirs.root, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ _version: 3, _settingsRevision: 5, tag_map: { 'nova.png': ['tag-1'] },
        extension_settings: { [MODULE]: { snapshots: [], ...module }, other: { kept: true } } }, null, 4));
    const base = { owner: 'fixture', directories: dirs };
    const request = { user: { profile: { handle: 'fixture' }, directories: dirs } };
    const context = job => ({ ...base, job: getJob(dirs, job.id), signal: new AbortController().signal, progress: async () => {} });
    const settings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const write = next => fs.writeFileSync(settingsPath, JSON.stringify(next, null, 4));
    const blobs = () => fs.readdirSync(dirs.files).filter(name => name.startsWith('cardtm_')).sort();
    const total = fs.readdirSync(dirs.characters).filter(name => name.endsWith('.png')).length + 2;
    return { dirs, base, request, context, settings, write, blobs, total };
}

test('one accepted snapshot job saves every snapshot and the index after the page is gone', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'all', kind: 'time-machine-capture' });
    await runOperation(p.context(accepted.job));
    const saved = p.settings();
    const rows = saved.extension_settings[MODULE].snapshots;
    assert.equal(rows.length, p.total);
    assert.deepEqual([...new Set(rows.map(row => row.kind))].sort(), ['character', 'lorebook', 'preset']);
    assert.equal(saved.extension_settings.other.kept, true);
    assert.equal(saved._version, 4);
    assert.equal(p.blobs().length, p.total);
    assert.equal(saved.extension_settings.character_attachments['__Neconyan-Card-Time-Machine__'].length, p.total);
    const character = JSON.parse(fs.readFileSync(path.join(p.dirs.files, rows.find(row => row.target === 'nova.png').name), 'utf8'));
    assert.equal(character.data.data.description, 'An astronaut.');
    assert.equal(character.data.chat, undefined);
    assert.deepEqual(character.tags, ['tag-1']);
    assert.equal(rows.find(row => row.kind === 'preset').target, 'openai/Moon');
    fs.rmSync(path.join(p.dirs.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, { key: 'all', kind: 'time-machine-capture' });
    assert.equal(again.job, null);
    assert.equal(readOperation(p.base, 'all').result.taken, p.total);
});

test('unchanged items are skipped and retention removes the older copy of an edited lorebook', async t => {
    const p = prepared(t);
    const first = await acceptApplicationOperation(p.request, { key: 'first', kind: 'time-machine-capture' });
    await runOperation(p.context(first.job));
    const firstBook = p.settings().extension_settings[MODULE].snapshots.find(row => row.kind === 'lorebook').name;
    const same = await acceptApplicationOperation(p.request, { key: 'same', kind: 'time-machine-capture' });
    await runOperation(p.context(same.job));
    assert.equal(readOperation(p.base, 'same').result.taken, 0);
    fs.writeFileSync(path.join(p.dirs.worlds, 'Garden.json'), JSON.stringify({ entries: { 0: { uid: 0, content: 'Tulips' } } }));
    const edited = await acceptApplicationOperation(p.request, { key: 'edited', kind: 'time-machine-capture' });
    await runOperation(p.context(edited.job));
    const result = readOperation(p.base, 'edited').result;
    assert.deepEqual([result.taken, result.removed], [1, 1]);
    const books = p.settings().extension_settings[MODULE].snapshots.filter(row => row.kind === 'lorebook');
    assert.equal(books.length, 1);
    assert.notEqual(books[0].name, firstBook);
    assert.equal(fs.existsSync(path.join(p.dirs.files, firstBook)), false);
});

test('an interrupted index write finishes once and keeps settings saved meanwhile', async t => {
    const p = prepared(t, { keepPerTarget: 15 });
    const accepted = await acceptApplicationOperation(p.request, { key: 'crash', kind: 'time-machine-capture' });
    await assert.rejects(runOperation(p.context(accepted.job), { afterTimeMachineIndex: () => { throw new Error('crash'); } }), /crash/);
    await runOperation(p.context(accepted.job));
    assert.equal(p.settings().extension_settings[MODULE].snapshots.length, p.total);
    const other = await acceptApplicationOperation(p.request, { key: 'merge', kind: 'time-machine-capture' });
    fs.writeFileSync(path.join(p.dirs.worlds, 'Garden.json'), JSON.stringify({ entries: { 0: { uid: 0, content: 'Tulips' } } }));
    const plan = p.context(other.job);
    const originalProgress = plan.progress;
    plan.progress = async progress => {
        const current = p.settings();
        p.write({ ...current, power_user: { mine: 'kept' }, _version: current._version + 1 });
        plan.progress = originalProgress;
        return originalProgress(progress);
    };
    await runOperation(plan);
    const saved = p.settings();
    assert.equal(saved.power_user.mine, 'kept');
    assert.equal(saved.extension_settings[MODULE].snapshots.length, p.total + 1);
});

for (const damage of ['missing', 'invalid JSON', 'changed content', 'wrong target']) {
    test(`manual capture replaces an unchanged snapshot with ${damage}`, async t => {
        const p = prepared(t);
        const first = await acceptApplicationOperation(p.request, { key: 'first', kind: 'time-machine-capture' });
        await runOperation(p.context(first.job));
        const old = p.settings().extension_settings[MODULE].snapshots.find(row => row.kind === 'lorebook');
        const filename = path.join(p.dirs.files, old.name);
        const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (damage === 'missing') fs.unlinkSync(filename);
        else if (damage === 'invalid JSON') fs.writeFileSync(filename, '{');
        else {
            if (damage === 'changed content') payload.data.entries[0].content = 'Corrupted';
            else payload.target = 'Different book';
            fs.writeFileSync(filename, JSON.stringify(payload));
        }
        const repair = await acceptApplicationOperation(p.request, { key: 'repair', kind: 'time-machine-capture' });
        await runOperation(p.context(repair.job));
        const result = readOperation(p.base, 'repair').result;
        assert.equal(result.taken, 1);
        assert.equal(result.skipped, p.total - 1);
        const row = result.module.snapshots.find(item => item.kind === 'lorebook');
        assert.notEqual(row.name, old.name);
        assert.equal(JSON.parse(fs.readFileSync(path.join(p.dirs.files, row.name), 'utf8')).data.entries[0].content, 'Roses');
    });
}

test('manual capture reports malformed source files while saving readable items', async t => {
    const p = prepared(t);
    fs.writeFileSync(path.join(p.dirs.characters, 'broken.png'), PNG);
    fs.writeFileSync(path.join(p.dirs.worlds, 'broken.json'), '{');
    fs.writeFileSync(path.join(p.dirs.openAI_Settings, 'broken.json'), '[]');
    const accepted = await acceptApplicationOperation(p.request, { key: 'partial', kind: 'time-machine-capture' });
    await runOperation(p.context(accepted.job));
    const result = readOperation(p.base, 'partial').result;
    assert.equal(result.failed, 3);
    assert.equal(result.taken, p.total);
    assert.equal(result.skipped, 0);
});

test('retention preserves malformed index rows and their files for repair', async t => {
    const p = prepared(t);
    const invalid = { kind: 'lorebook', target: 'Garden', name: 'cardtm_preset_unrecognised.json', ts: 1, size: 2 };
    const settings = p.settings();
    settings.extension_settings[MODULE].snapshots.push(invalid);
    p.write(settings);
    fs.writeFileSync(path.join(p.dirs.files, invalid.name), '{}');
    const accepted = await acceptApplicationOperation(p.request, { key: 'preserve', kind: 'time-machine-capture' });
    await runOperation(p.context(accepted.job));
    assert.ok(p.settings().extension_settings[MODULE].snapshots.some(row => row.name === invalid.name));
    assert.ok(fs.existsSync(path.join(p.dirs.files, invalid.name)));
});
