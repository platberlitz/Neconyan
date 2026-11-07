import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { admitNativeMediaJob, readNativeMediaJobResultForOwner } = await import('../src/generation/media-jobs.js');
const { roleplayHash, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { acceptJob, setJobState } = await import('../src/jobs/store.js');

const RESERVATION = 512 * 1024;

function writeAcceptedReceipt(f, account, { operationKey, jobId, target }) {
    const directory = path.join(roleplayStoreDirectory(f.scope), 'media');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `${roleplayHash([account.accountId, operationKey])}.json`);
    fs.writeFileSync(filename, JSON.stringify({ version: 1, account, intentHash: roleplayHash({ operationKey }),
        targetHash: roleplayHash([account.accountId, account.dataEpoch, target]), jobId, state: 'accepted', effects: {} }));
    return filename;
}

function admit(f, account, operationKey, target = { kind: 'chat', id: 'fresh-chat' }) {
    return admitNativeMediaJob(f.scope, account, { operationKey, source: f.source(), kind: 'roleplay-workflow',
        request: { version: 1 }, target });
}

test('accepted receipts whose job was pruned stop reserving capacity they cannot use', t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    // Thirty-two 512 KiB reservations plus the incoming one exceed the 16 MiB
    // store limit, while the orphaned records themselves are a few hundred bytes.
    const orphans = Array.from({ length: 32 }, (_, index) => writeAcceptedReceipt(f, account, {
        operationKey: `orphan-${index}`, jobId: `pruned-${index}`, target: { kind: 'chat', id: `chat-${index}` },
    }));
    const before = orphans.map(filename => fs.readFileSync(filename));

    assert.equal(admit(f, account, 'fresh-after-orphans').created, true);

    for (const [index, filename] of orphans.entries()) {
        assert.deepEqual(fs.readFileSync(filename), before[index], 'the orphaned record and its proof are unchanged');
        assert.deepEqual(readNativeMediaJobResultForOwner(f.scope, { operationKey: `orphan-${index}` }),
            { state: 'accepted', jobId: `pruned-${index}`, result: null });
    }
});

test('an interrupted job still in the ledger keeps its full reservation', t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    for (let index = 0; index < 32; index++) {
        const { job } = acceptJob(f.scope.directories, { owner: f.scope.owner, type: 'media.roleplay-workflow',
            submissionKey: `interrupted-${index}`, intent: {} });
        setJobState(f.scope.directories, job.id, 'interrupted');
        writeAcceptedReceipt(f, account, { operationKey: `interrupted-${index}`, jobId: job.id,
            target: { kind: 'chat', id: `interrupted-chat-${index}` } });
    }

    assert.throws(() => admit(f, account, 'fresh-while-interrupted'), { code: 'MEDIA_STORE_FULL',
        message: 'Media record storage is full. Earlier records were kept.' });
    assert.ok(32 * RESERVATION + RESERVATION > 16 * 1024 * 1024);
});

test('a receipt from another data epoch cannot reserve current capacity', t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const other = { accountId: account.accountId, dataEpoch: account.dataEpoch + 1 };
    for (let index = 0; index < 32; index++) {
        const { job } = acceptJob(f.scope.directories, { owner: f.scope.owner, type: 'media.images',
            submissionKey: `other-epoch-${index}`, intent: {} });
        writeAcceptedReceipt(f, other, { operationKey: `other-epoch-${index}`, jobId: job.id,
            target: { kind: 'chat', id: `other-epoch-chat-${index}` } });
    }

    assert.equal(admit(f, account, 'fresh-after-earlier-epoch').created, true);
});
