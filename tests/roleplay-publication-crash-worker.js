/* global Atomics, SharedArrayBuffer */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { png } from './roleplay-transactions-fixture.js';
import { publicationFilesystem } from './roleplay-publication-fixture.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { readRoleplayAccount, readRoleplayFile, roleplayStoreDirectory, withRoleplayAccount } from '../src/roleplay-store.js';
import { commitRoleplayLifecycleLocked, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import { readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { inspectTransferredRoleplay, repairTransferredRoleplay } from '../src/roleplay-transfer-recovery.js';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mode = process.argv[3];
const filename = path.join(spec.scope.directories.characters, 'Probe.png');
const statePath = path.join(roleplayStoreDirectory(spec.scope), 'state.json');
const mappingPath = process.argv[2] + '.mapping';
const bytes = writeCard(png, JSON.stringify({ name: 'Probe', description: 'Saved' }));
const write = fs.writeSync;
let mock;
let injected = false;
function pause(boundary) {
    if (mode !== 'write' || boundary !== spec.boundary || injected) return;
    injected = true;
    fs.writeFileSync(mappingPath, JSON.stringify([...mock.published]));
    if (spec.failure) throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' });
    write(1, JSON.stringify({ boundary }) + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Pause unexpectedly resumed');
}
const patched = { mock: { method(object, key, value) { object[key] = value; } } };
mock = publicationFilesystem(patched, {
    field: spec.stable ? null : 'ino',
    beforeRename(from, to) {
        if (to === filename) pause('before-rename');
        if (to === statePath && fs.existsSync(filename)) {
            const state = JSON.parse(fs.readFileSync(from, 'utf8')).state;
            if (state.pending?.steps[0].physical?.ino === readRoleplayFile(filename).physical.ino) pause('before-record');
            if (!state.pending) pause('before-receipt');
        }
    },
    afterRename() { pause('after-rename'); },
});
if (fs.existsSync(mappingPath)) for (const entry of JSON.parse(fs.readFileSync(mappingPath, 'utf8'))) mock.published.set(...entry);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (String(to) === statePath && fs.existsSync(filename)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')).state;
        if (state.pending?.steps[0].physical?.ino === readRoleplayFile(filename).physical.ino) pause('after-record');
        if (!state.pending) pause('after-receipt');
    }
    return result;
};
const close = fs.closeSync;
fs.closeSync = fd => {
    const target = mock.descriptors.get(fd);
    const result = close(fd);
    if (target === filename && mock.published.has(filename)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')).state;
        if (state.pending?.steps[0].physical?.ino === String(fs.lstatSync(filename, { bigint: true }).ino)) pause('record-returned');
    }
    return result;
};
let result, error;
try {
    if (mode === 'write') result = withRoleplayAccount(spec.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'crash', action: 'character-create', intent: { avatar: 'Probe.png' },
        steps: [{ op: 'create', kind: 'character', locator: { avatar: 'Probe.png' }, bytes }],
    }));
    else if (mode === 'repair') {
        const check = inspectTransferredRoleplay(spec.scope);
        assert.equal(check.canRepair, true);
        const repair = repairTransferredRoleplay(spec.scope, check.token);
        const repaired = { ...spec.scope, dataEpoch: repair.dataEpoch };
        assert.equal(readRoleplayAccount(repaired).pending, null);
        assert.equal(readRoleplayEntity(repaired, 'character', 'Probe.png').data.name, 'Probe');
        assert.throws(() => readRoleplayEntity(spec.scope, 'character', 'Probe.png'), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
        result = { repaired: true, dataEpoch: repair.dataEpoch };
    } else result = reconcilePendingChatWrite(spec.scope, {});
} catch (failure) { error = { code: failure.code, message: failure.message }; }
const state = JSON.parse(fs.readFileSync(statePath, 'utf8')).state;
const file = fs.existsSync(filename) ? readRoleplayFile(filename) : null;
process.stdout.write(JSON.stringify({ result, error, pending: state.pending, resources: state.resources,
    bytesIntact: file?.bytes.equals(bytes), physical: file?.physical, descriptors: mock.descriptors.size }) + '\n');
