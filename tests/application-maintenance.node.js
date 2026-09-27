import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
const { readMaintenanceView } = await import('../src/operations/maintenance.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { resetRoleplayAccount } = await import('../src/roleplay-store.js');

function prepared(t, owner = 'fixture', group = false) {
    const f = fixture(t, group, owner);
    const directories = f.scope.directories;
    for (const [name, relative] of Object.entries({ files: 'user/files', userImages: 'user/images', worlds: 'worlds', avatars: 'User Avatars',
        thumbnailsAvatar: 'thumbnails/avatar', thumbnailsBg: 'thumbnails/bg', thumbnailsBgMobile: 'thumbnails/bg-mobile', thumbnailsPersona: 'thumbnails/persona', backgrounds: 'backgrounds' })) {
        directories[name] = path.join(directories.root, relative); fs.mkdirSync(directories[name], { recursive: true });
    }
    const base = { owner, directories };
    const request = { user: { profile: { handle: owner }, directories } };
    const context = job => ({ ...base, job: getJob(directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const upload = (name, text = 'Old file') => { const filename = path.join(directories.files, name); fs.writeFileSync(filename, text); return filename; };
    const scan = async (key = 'report') => {
        const accepted = await acceptApplicationOperation(request, { key, kind: 'maintenance-report' });
        await runOperation(context(accepted.job));
        return readOperation(base, key);
    };
    const deletion = async (report, hashes, key = 'delete') => acceptApplicationOperation(request, { key, kind: 'maintenance-delete', reportKey: report.key, resultHash: report.resultHash, hashes });
    return { f, base, request, context, upload, scan, deletion };
}

test('maintenance retains Meower, Conversation, snapshot and selected-swipe file references in its saved report', async t => {
    const p = prepared(t);
    for (const name of ['meower.png', 'conversation.png', 'swipe.png', 'loose.png']) fs.writeFileSync(path.join(p.base.directories.userImages, name), 'Image');
    p.upload('cardtm_snapshot.json', '{"saved":"snapshot"}');
    p.upload('loose.txt'); p.upload('_sbca_organization.json', '{"version":1}');
    const hopper = path.join(p.base.directories.root, 'hopper'); fs.mkdirSync(hopper);
    fs.writeFileSync(path.join(hopper, 'store.json'), JSON.stringify({ feeds: { one: { posts: [{ image: { url: '/user/images/meower.png' } }] } } }));
    fs.writeFileSync(path.join(p.base.directories.root, 'settings.json'), JSON.stringify({ extension_settings: {
        conversation: { messages: [{ image: '/user/images/conversation.png' }] }, timeMachine: { snapshots: [{ url: '/user/files/cardtm_snapshot.json' }] },
    } }));
    const rows = structuredClone(p.f.records);
    rows[2].swipe_info[1].extra = { media: [{ url: '/user/images/swipe.png' }] };
    fs.writeFileSync(p.f.filename, rows.map(row => JSON.stringify(row)).join('\n'));
    const report = await p.scan();
    assert.deepEqual(report.result.report.images.map(item => item.name), ['loose.png']);
    assert.deepEqual(report.result.report.files.map(item => item.name), ['loose.txt']);
    assert.equal(readMaintenanceView(p.base, report.key, report.result.report.files[0].hash).bytes.toString(), 'Old file');
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    fs.rmSync(path.join(p.base.directories.root, 'jobs/artifacts'), { recursive: true });
    assert.deepEqual(readOperation(p.base, report.key).result, report.result);
});

test('an unreadable reference source stops maintenance rather than reporting its files as unused', async t => {
    const p = prepared(t); const file = p.upload('kept.txt');
    fs.writeFileSync(p.f.filename, '{broken chat');
    await assert.rejects(acceptApplicationOperation(p.request, { key: 'bad', kind: 'maintenance-report' }), /could not read/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Old file');
    assert.equal(readOperation(p.base, 'bad'), null);
});

test('reviewed maintenance refuses later file replacements and newly referenced files', async t => {
    const p = prepared(t); const file = p.upload('later.txt');
    const report = await p.scan(); const hash = report.result.report.files[0].hash;
    fs.writeFileSync(path.join(p.base.directories.root, 'settings.json'), JSON.stringify({ extension_settings: { attachments: [{ url: '/user/files/later.txt' }] } }));
    await assert.rejects(p.deletion(report, [hash]), /changed or is now in use/);
    fs.unlinkSync(path.join(p.base.directories.root, 'settings.json'));
    const accepted = await p.deletion(report, [hash]);
    fs.unlinkSync(file); fs.writeFileSync(file, 'Later replacement');
    await assert.rejects(runOperation(p.context(accepted.job)), /changed after deletion/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Later replacement');
    assert.throws(() => readMaintenanceView(p.base, report.key, hash), /changed after the report/);
});

test('interrupted multi-file deletion retains proof and never removes a later replacement', async t => {
    const p = prepared(t); const first = p.upload('a.txt'); const second = p.upload('b.txt');
    const report = await p.scan();
    const accepted = await p.deletion(report, report.result.report.files.map(item => item.hash));
    await assert.rejects(runOperation(p.context(accepted.job), { afterFileDeletion: () => { throw new Error('Simulated lost acknowledgement'); } }), /lost acknowledgement/);
    assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), true);
    fs.writeFileSync(first, 'Later replacement');
    await assert.rejects(runOperation(p.context(accepted.job)), /later file replaced/);
    assert.equal(fs.readFileSync(first, 'utf8'), 'Later replacement');
    fs.unlinkSync(first);
    await runOperation(p.context(accepted.job));
    assert.equal(fs.existsSync(second), false);
    fs.writeFileSync(first, 'Kept after completed deletion');
    await runOperation(p.context(accepted.job));
    assert.equal(fs.readFileSync(first, 'utf8'), 'Kept after completed deletion');
});

test('protected orphan chat deletion replays its lifecycle receipt without deleting a recreated path', async t => {
    const p = prepared(t, 'fixture', true);
    p.f.source();
    fs.unlinkSync(path.join(p.base.directories.groups, 'group.json'));
    const report = await p.scan();
    assert.equal(report.result.report.groupChats.length, 1);
    const accepted = await p.deletion(report, [report.result.report.groupChats[0].hash]);
    await assert.rejects(runOperation(p.context(accepted.job), { afterFileDeletion: () => { throw new Error('Lost lifecycle acknowledgement'); } }), /Lost lifecycle/);
    assert.equal(fs.existsSync(p.f.filename), false);
    fs.writeFileSync(p.f.filename, 'Later user file');
    await runOperation(p.context(accepted.job));
    assert.equal(fs.readFileSync(p.f.filename, 'utf8'), 'Later user file');
    assert.equal(readOperation(p.base, 'delete').state, 'completed');
});

test('maintenance reports and file reads remain account scoped', async t => {
    const alice = prepared(t, 'alice'); const bob = prepared(t, 'bob');
    alice.upload('alice.txt'); bob.upload('bob.txt');
    const a = await alice.scan(); const b = await bob.scan();
    assert.equal(a.result.report.files[0].name, 'alice.txt'); assert.equal(b.result.report.files[0].name, 'bob.txt');
    assert.throws(() => readMaintenanceView(bob.base, a.key, a.result.report.files[0].hash), /not in this saved report/);
    await assert.rejects(bob.deletion(a, [a.result.report.files[0].hash]), /unavailable or changed/);
});

test('an old maintenance report cannot delete files recreated after an account reset', async t => {
    const p = prepared(t); const file = p.upload('later.txt');
    const report = await p.scan();
    resetRoleplayAccount(p.base, null, 'reset');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'New account data');
    await assert.rejects(p.deletion(report, [report.result.report.files[0].hash]), /earlier account|changed|epoch/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'New account data');
});
