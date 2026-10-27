import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventoryIdentityRepairRoot } from '../src/data-identity-repair-inspection.js';
import { createIdentityRepairBackup, verifyIdentityRepairBackup } from '../src/data-identity-repair-backup.js';

function roots(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-backup-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'data');
    const backup = path.join(directory, 'backup');
    fs.mkdirSync(root); fs.mkdirSync(backup);
    fs.mkdirSync(path.join(root, '_roleplay', 'application-inputs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, '_roleplay', 'application-inputs', 'retained.bin'), Buffer.from([0, 1, 255, 128]));
    fs.writeFileSync(path.join(root, 'neconyan-backup-manifest.json'), 'ordinary user file');
    return { root, backup };
}

test('backup preserves binary and similarly named user files and detects later changes', t => {
    const f = roots(t);
    const inventory = inventoryIdentityRepairRoot(f.root);
    const result = createIdentityRepairBackup(f.root, f.backup, crypto.randomUUID(), inventory);
    const manifest = verifyIdentityRepairBackup(result.destination, result.manifestHash);
    assert.equal(manifest.files.length, 2);
    assert.ok(manifest.directories.includes('empty'));
    assert.deepEqual(fs.readFileSync(path.join(result.destination, 'files', '_roleplay', 'application-inputs', 'retained.bin')), Buffer.from([0, 1, 255, 128]));
    assert.equal(fs.readFileSync(path.join(result.destination, 'files', 'neconyan-backup-manifest.json'), 'utf8'), 'ordinary user file');
    fs.rmdirSync(path.join(result.destination, 'files', 'empty'));
    assert.throws(() => verifyIdentityRepairBackup(result.destination, result.manifestHash), { code: 'DATA_IDENTITY_BACKUP_FAILED' });
    fs.mkdirSync(path.join(result.destination, 'files', 'empty'));
    fs.writeFileSync(path.join(result.destination, 'files', 'neconyan-backup-manifest.json'), 'changed');
    assert.throws(() => verifyIdentityRepairBackup(result.destination, result.manifestHash), { code: 'DATA_IDENTITY_BACKUP_FAILED' });
});

test('a source changed after inspection is preserved and refuses the backup', t => {
    const f = roots(t);
    const inventory = inventoryIdentityRepairRoot(f.root);
    const filename = path.join(f.root, 'neconyan-backup-manifest.json');
    fs.writeFileSync(filename, 'changed before backup');
    assert.throws(() => createIdentityRepairBackup(f.root, f.backup, crypto.randomUUID(), inventory), { code: 'DATA_IDENTITY_BACKUP_FAILED' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'changed before backup');
});
