import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import { fixture } from './roleplay-transactions-fixture.js';
import { retainUploadedArchive } from '../src/operations/input-files.js';
import { captureZipImport } from '../src/operations/account-import-sources.js';
import { captureAccountImport } from '../src/operations/account-import.js';
import { admitOperation, readOperation } from '../src/operations/store.js';
import { runOperation } from '../src/operations/jobs.js';
import { getJob } from '../src/jobs/store.js';
import { roleplayStoreDirectory } from '../src/roleplay-store.js';

// This fixture tests inventory only. Its deliberately short compressed stream must
// still be refused if read: advertised sizes never authorise extra output bytes.
function inventoryZip(sizes) {
    const locals = [], central = [];
    let offset = 0;
    for (const [index, size] of sizes.entries()) {
        const name = Buffer.from(`extensions/large/file-${index}.bin`);
        const extra = Buffer.alloc(12);
        extra.writeUInt16LE(1, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(size), 4);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(45, 4); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(2, 18); local.writeUInt32LE(0xffffffff, 22);
        local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50); header.writeUInt16LE(45, 4); header.writeUInt16LE(45, 6);
        header.writeUInt16LE(8, 10); header.writeUInt32LE(2, 20); header.writeUInt32LE(0xffffffff, 24);
        header.writeUInt16LE(name.length, 28); header.writeUInt16LE(extra.length, 30); header.writeUInt32LE(offset, 42);
        const entry = Buffer.concat([local, name, extra, Buffer.from([3, 0])]);
        locals.push(entry); central.push(header, name, extra); offset += entry.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(sizes.length, 8); end.writeUInt16LE(sizes.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

test('ZIP64 inventories accept 13 GiB expanded and individual files above the former quotas', async t => {
    const f = fixture(t, false), base = { owner: 'fixture', directories: f.scope.directories };
    for (const [index, sizes] of [[4 * 1024 ** 3, 4 * 1024 ** 3, 5 * 1024 ** 3], [40 * 1024 ** 3]].entries()) {
        const filename = path.join(path.dirname(base.directories.root), `large-${index}.zip`);
        fs.writeFileSync(filename, inventoryZip(sizes));
        const source = await retainUploadedArchive(base, f.scope, `large-${index}`, filename);
        const plan = await captureZipImport(source);
        assert.deepEqual(plan.files.map(file => file.size), sizes);
        assert.equal(plan.total, sizes.reduce((a, b) => a + b, 0));
    }
    const filename = path.join(path.dirname(base.directories.root), 'overflow.zip');
    fs.writeFileSync(filename, inventoryZip([Number.MAX_SAFE_INTEGER, 1]));
    const source = await retainUploadedArchive(base, f.scope, 'overflow', filename);
    await assert.rejects(captureZipImport(source), /cannot be represented exactly/);
});

test('retained upload history above 32 GiB does not refuse another archive', async t => {
    const f = fixture(t, false), base = { owner: 'fixture', directories: f.scope.directories };
    const filename = path.join(path.dirname(base.directories.root), 'small.zip');
    fs.writeFileSync(filename, inventoryZip([1]));
    await retainUploadedArchive(base, f.scope, 'earlier', filename);
    const root = path.join(roleplayStoreDirectory(base), 'application-inputs');
    const recordPath = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.json')));
    const record = JSON.parse(fs.readFileSync(recordPath));
    // Simulate the saved allocation of an earlier large upload without allocating it in CI.
    record.size = 40 * 1024 ** 3;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const before = fs.readFileSync(recordPath);
    const next = await retainUploadedArchive(base, f.scope, 'next', filename);
    assert.ok(next);
    assert.deepEqual(fs.readFileSync(recordPath), before);
});

test('streamed ZIP import publishes exact bytes with bounded memory', async t => {
    const size = Number(process.env.NECONYAN_LARGE_IMPORT_BYTES || 4 * 1024 ** 2);
    assert.ok(Number.isSafeInteger(size) && size > 0);
    const f = fixture(t, false), base = { owner: 'fixture', directories: f.scope.directories };
    const filename = path.join(path.dirname(base.directories.root), 'streamed.zip');
    const originalChat = fs.readFileSync(f.filename);
    const expected = createHash('sha256'), chunk = Buffer.alloc(1024 ** 2, 78);
    const archive = archiver('zip', { forceZip64: true, zlib: { level: 1 } });
    const output = fs.createWriteStream(filename), complete = finished(output);
    archive.on('error', error => output.destroy(error)); archive.pipe(output);
    archive.append(Readable.from((async function* () {
        for (let remaining = size; remaining > 0; remaining -= chunk.length) {
            const bytes = chunk.subarray(0, Math.min(chunk.length, remaining));
            expected.update(bytes); yield bytes;
        }
    })()), { name: 'extensions/large/payload.bin' });
    await archive.finalize(); await complete;
    const source = await retainUploadedArchive(base, f.scope, 'streamed', filename);
    const plan = await captureAccountImport(base, f.scope, { mode: 'zip', inputId: source.id }, { defaults: { files: [], directories: [] } });
    assert.equal(plan.total, size);
    const accepted = admitOperation(base, f.scope, { key: 'streamed', kind: 'account-import', input: {}, plan, label: 'Streamed import' });
    await runOperation({ ...base, job: getJob(base.directories, accepted.job.id), signal: new AbortController().signal, progress: async () => {} });
    const imported = path.join(base.directories.root, 'extensions/large/payload.bin');
    assert.equal(fs.statSync(imported).size, size);
    const actual = createHash('sha256');
    for await (const bytes of fs.createReadStream(imported)) actual.update(bytes);
    assert.equal(actual.digest('hex'), expected.digest('hex'));
    assert.equal(readOperation(base, 'streamed').result.skippedCount, 0);
    assert.deepEqual(fs.readFileSync(f.filename), originalChat);
    t.diagnostic(`Verified ${size} imported bytes and SHA-256 without buffering the entire file.`);
});
