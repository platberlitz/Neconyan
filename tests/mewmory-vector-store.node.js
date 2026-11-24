/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import fetch from 'node-fetch';
import { setConfigFilePath } from '../src/util.js';
import { createVectorReader } from '../src/mewmory/vector-storage.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { newState, putRecord, syncSources, validateRecord } = await import('../src/mewmory/core.js');
const { buildMemoryRecoveryGuard, chatPath, mutateState, readJsonShared, readState, readStateShared, statePath, writeJson } = await import('../src/mewmory/store.js');
const { restoreRecords, router } = await import('../src/endpoints/mewmory.js');

const locator = { chat: 'Vector storage', avatar: 'Mara.png', group: false };
const messages = [{ name: 'Mara', is_user: true, mes: 'The ferry is finally at the pier.', send_date: '2026-01-01T00:00:00.000Z' }];
const readDisk = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const asJson = value => JSON.parse(JSON.stringify(value));

function expectedVector(values) {
    const buffer = new ArrayBuffer(values.length * 4);
    const view = new DataView(buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, Math.fround(value), true));
    return Buffer.from(buffer).toString('base64');
}

function fixture(t, customize) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-vector-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['chats', 'groupChats', 'groups', 'worlds', 'characters', 'files', 'userAvatars']
        .map(name => [name, path.join(root, name)]));
    directories.root = root;
    const archive = statePath(directories, locator);
    const recovery = path.join(root, 'mewmory/recovery', path.basename(archive));
    const state = newState(locator);
    state.enabled = true;
    syncSources(state, messages);
    state.index = {
        version: 'published',
        metadata: { preserve: ['ordinary fields'] },
        pending: true,
        vectors: {
            legacy: { vector: [0.1, -0.3333333333, 1 + 2 ** -27], textHash: 'legacy', future: { name: 'original' } },
            compact: { vectorF32LE: expectedVector([0.25, -0.75]), textHash: 'existing', provenance: ['kept'] },
        },
        build: { vectors: { staged: { vector: [0.101010101, 1], textHash: 'staged' } }, version: 'staged', cursor: 8 },
    };
    customize?.(state);
    writeJson(archive, state);
    writeJson(recovery, buildMemoryRecoveryGuard(state));
    const chat = chatPath(directories, locator);
    fs.mkdirSync(path.dirname(chat), { recursive: true });
    fs.writeFileSync(chat, [{ chat_metadata: {} }, ...messages].map(row => JSON.stringify(row)).join('\n') + '\n');
    return { directories, archive, recovery, state };
}

function expectedIndex(index) {
    const result = structuredClone(index);
    for (const map of [result.vectors, result.build.vectors]) {
        for (const entry of Object.values(map)) {
            const compact = Object.hasOwn(entry, 'vector') ? expectedVector(entry.vector) : entry.vectorF32LE;
            delete entry.vector;
            delete entry.vectorF32LE;
            entry.vectorF32LE = compact;
        }
    }
    return result;
}

test('cold parse converts both index maps before cache admission and native clones preserve metadata ownership', t => {
    const { directories, archive, recovery, state } = fixture(t);
    const originalArchive = fs.readFileSync(archive);
    const originalGuard = fs.readFileSync(recovery);
    const expected = expectedIndex(state.index);
    const shared = readStateShared(directories, locator);
    assert.deepEqual(shared, { ...asJson(state), index: expected });
    assert.equal(readStateShared(directories, locator), shared);
    assert.equal(readJsonShared(archive, null), shared);
    for (const map of [shared.index.vectors, shared.index.build.vectors]) for (const entry of Object.values(map)) {
        assert.equal(Object.hasOwn(entry, 'vector'), false);
        assert.equal(typeof entry.vectorF32LE, 'string');
    }
    const cloned = readState(directories, locator);
    assert.deepEqual(cloned, structuredClone(shared));
    cloned.index.vectors.legacy.future.name = 'edited clone';
    delete cloned.index.build.vectors.staged;
    assert.deepEqual(shared.index, expected);
    assert.deepEqual(fs.readFileSync(archive), originalArchive, 'Cache conversion does not write the archive');
    assert.deepEqual(fs.readFileSync(recovery), originalGuard, 'Cache conversion does not write the guard');
});

test('representation-only no-ops preserve the old bytes and revision until an ordinary write', t => {
    const { directories, archive, recovery, state } = fixture(t);
    const before = fs.readFileSync(archive);
    const guard = fs.readFileSync(recovery);
    const rename = t.mock.method(fs, 'renameSync');
    assert.equal(mutateState(directories, locator, () => {}).revision, state.revision);
    const equivalent = mutateState(directories, locator, current => {
        current.index.vectors.legacy = {
            textHash: 'legacy', vector: state.index.vectors.legacy.vector.map(Math.fround), future: { name: 'original' },
        };
        current.index.vectors.compact = { vector: [0.25, -0.75], textHash: 'existing', provenance: ['kept'] };
    });
    assert.equal(equivalent.revision, state.revision);
    assert.equal(equivalent.updatedAt, state.updatedAt);
    const ordinaryWrites = () => rename.mock.calls.filter(call => [archive, recovery].includes(String(call.arguments[1])));
    assert.equal(ordinaryWrites().length, 0);
    assert.deepEqual(fs.readFileSync(archive), before);
    assert.deepEqual(fs.readFileSync(recovery), guard);
    const written = mutateState(directories, locator, current => { current.reviewedAt = 17; });
    assert.equal(written.revision, state.revision + 1);
    assert.equal(ordinaryWrites().length, 2);
    const disk = readDisk(archive);
    assert.deepEqual(disk.index, expectedIndex(state.index));
    assert.equal(disk.reviewedAt, 17);
    assert.deepEqual(disk, readStateShared(directories, locator));
    assert.deepEqual(readDisk(recovery), asJson(buildMemoryRecoveryGuard(disk)));
    assert.deepEqual(fs.readdirSync(path.dirname(archive)), [path.basename(archive)]);
});

test('invalid legacy and compact fields leave readable archives and unrelated shared JSON unchanged', t => {
    const { directories, archive, state } = fixture(t, state => {
        Object.assign(state.index.vectors, {
            overflow: { vector: [3.5e38], textHash: 'overflow', extra: { preserved: true } },
            nonnumeric: { vector: [{ valueOf: 4, toString: 2 }], textHash: 'nonnumeric' },
            dual: { vectorF32LE: expectedVector([0.25]), vector: [0.25], textHash: 'dual' },
            malformed: { textHash: 'malformed', vectorF32LE: 'AA!A' },
            wrongType: { textHash: 'wrong-type', vectorF32LE: [0.25, 0.5] },
        });
    });
    const saved = readStateShared(directories, locator);
    assert.deepEqual(saved.sources, asJson(state.sources));
    assert.deepEqual(saved.index.vectors.overflow, { textHash: 'overflow', extra: { preserved: true } });
    assert.deepEqual(saved.index.vectors.nonnumeric, { textHash: 'nonnumeric' });
    assert.deepEqual(saved.index.vectors.dual, { textHash: 'dual' });
    assert.deepEqual(saved.index.vectors.wrongType, { textHash: 'wrong-type' });
    const reader = createVectorReader();
    for (const name of ['overflow', 'nonnumeric', 'dual', 'malformed', 'wrongType']) assert.equal(reader.dimension(saved.index.vectors[name]), 0);

    const others = [path.join(directories.root, 'settings.json'),
        path.join(path.dirname(archive), 'notes.json'),
        path.join(directories.root, 'other/stories', path.basename(archive))];
    for (const file of others) {
        writeJson(file, state);
        const bytes = fs.readFileSync(file);
        assert.deepEqual(readJsonShared(file, null), asJson(state));
        assert.deepEqual(fs.readFileSync(file), bytes);
    }
    const withoutTimeline = structuredClone(state);
    delete withoutTimeline.timeline;
    writeJson(archive, withoutTimeline);
    assert.deepEqual(readStateShared(directories, locator).index.vectors.legacy, saved.index.vectors.legacy);
});

for (const destination of ['archive', 'recovery']) {
    test(`an interrupted ${destination} write retains legacy bytes and clean cache, then persists compact on retry`, t => {
        const { directories, archive, recovery, state } = fixture(t);
        mutateState(directories, locator, () => {});
        const held = readStateShared(directories, locator);
        const snapshot = structuredClone(held);
        const archiveBytes = fs.readFileSync(archive);
        const recoveryBytes = fs.readFileSync(recovery);
        const rename = fs.renameSync;
        let interrupted = false;
        const mock = t.mock.method(fs, 'renameSync', (from, to) => {
            if (!interrupted && String(to) === (destination === 'archive' ? archive : recovery)) {
                interrupted = true;
                throw Error('interrupted compact save');
            }
            return rename(from, to);
        });
        const borrowed = Object.freeze({ textHash: 'edited', vector: Object.freeze([0.1, -2.01]) });
        const edit = value => {
            value.index = Object.freeze({ ...value.index,
                vectors: Object.freeze({ ...value.index.vectors, concurrent: borrowed }),
                build: Object.freeze({ ...value.index.build, vectors: Object.freeze({ ...value.index.build.vectors, concurrent: borrowed }) }),
            });
        };
        assert.throws(() => mutateState(directories, locator, edit), /interrupted compact save/);
        assert.equal(interrupted, true);
        assert.equal(readStateShared(directories, locator), held);
        assert.deepEqual(held, snapshot);
        assert.deepEqual(borrowed, { textHash: 'edited', vector: [0.1, -2.01] });
        assert.deepEqual(fs.readFileSync(archive), archiveBytes);
        assert.deepEqual(fs.readFileSync(recovery), recoveryBytes);
        mock.mock.restore();

        const retried = mutateState(directories, locator, edit);
        const disk = readDisk(archive);
        assert.equal(disk.revision, state.revision + 1);
        assert.deepEqual(disk, readStateShared(directories, locator));
        assert.deepEqual(asJson(retried), disk);
        const expected = expectedIndex(state.index);
        expected.vectors.concurrent = { textHash: 'edited', vectorF32LE: expectedVector([0.1, -2.01]) };
        expected.build.vectors.concurrent = { textHash: 'edited', vectorF32LE: expectedVector([0.1, -2.01]) };
        assert.deepEqual(disk.index, expected);
        assert.deepEqual(borrowed, { textHash: 'edited', vector: [0.1, -2.01] });
        assert.deepEqual(readDisk(recovery), asJson(buildMemoryRecoveryGuard(disk)));
    });
}

test('the JSON export retains compact entries and record restore keeps its own index', async t => {
    const { directories, state } = fixture(t, state => {
        const record = validateRecord(state, { id: 'event:ferry', kind: 'event', text: 'The ferry arrived.', subjectIds: ['ferry'],
            refs: [state.timeline[0]] }, { asOf: 0, origin: 'author' });
        putRecord(state, record);
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await once(server, 'listening');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator }),
    });
    assert.equal(response.status, 200);
    const backup = await response.json();
    assert.equal(backup.format, 'mewmory-export-1');
    assert.ok(Number.isFinite(Date.parse(backup.exportedAt)));
    assert.equal(backup.state.records.find(record => record.id === 'event:ferry')?.text, 'The ferry arrived.');
    assert.deepEqual(backup.state.index, expectedIndex(state.index));

    const target = structuredClone(backup.state);
    target.records = [];
    target.audit = [];
    target.index = { version: 'destination', pending: true, vectors: { own: { textHash: 'target', vectorF32LE: expectedVector([1, 2]) } } };
    const own = structuredClone(target.index);
    const result = restoreRecords(target, backup);
    assert.deepEqual(result.skipped, []);
    assert.equal(target.records.find(record => record.id === 'event:ferry')?.text, 'The ferry arrived.');
    assert.deepEqual(target.index, own);
});
