/* eslint playwright/expect-expect: off -- Node assertions verify killed writers and fresh-process recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './roleplay-transactions-fixture.js';

const worker = fileURLToPath(new URL('./roleplay-publication-crash-worker.js', import.meta.url));
function fresh(specPath, mode) {
    const child = spawnSync(process.execPath, [worker, specPath, mode], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

for (const boundary of ['before-record', 'after-record', 'record-returned']) {
    test(`ledger error at ${boundary} closes handles and fresh retry uses only persisted authority`, t => {
        const f = fixture(t, false, 'ledger-error');
        const specPath = path.join(f.root, 'spec.json');
        fs.writeFileSync(specPath, JSON.stringify({ scope: f.scope, stable: false, boundary, failure: true }));
        const failed = fresh(specPath, 'write');
        assert.ok(failed.error, JSON.stringify(failed));
        assert.equal(failed.descriptors, 0);
        assert.equal(failed.bytesIntact, true);
        assert.equal(failed.pending.kind, 'lifecycle');
        const recovered = fresh(specPath, 'recover');
        if (boundary === 'before-record') {
            assert.equal(recovered.error?.code, 'ROLEPLAY_SOURCE_CHANGED');
            assert.deepEqual(recovered.pending, failed.pending);
        } else {
            assert.equal(recovered.error, undefined, JSON.stringify(recovered));
            assert.equal(recovered.pending, null);
            const card = Object.values(recovered.resources).find(value => value.locator?.avatar === 'Probe.png');
            assert.equal(card.revision, 1);
            assert.deepEqual(card.head.physical, recovered.physical);
        }
        assert.equal(recovered.bytesIntact, true);
    });
}
function ageLocks(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filename = path.join(root, entry.name);
        if (/^\.neconyan-chat-[a-f0-9]{64}\.lock$/.test(entry.name)) {
            const old = new Date(Date.now() - 600000);
            fs.utimesSync(filename, old, old);
        } else ageLocks(filename);
    }
}
for (const stable of [false, true]) for (const boundary of ['before-rename', 'after-rename', 'before-record', 'after-record', 'before-receipt', 'after-receipt', ...(!stable ? ['record-returned'] : [])]) {
    test(`${stable ? 'stable' : 'changed'} inode survives process death at ${boundary} with exact durable authority`, async t => {
        const f = fixture(t, false, 'crash');
        const specPath = path.join(f.root, 'spec.json');
        fs.writeFileSync(specPath, JSON.stringify({ scope: f.scope, stable, boundary }));
        const child = spawn(process.execPath, [worker, specPath, 'write'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const exited = once(child, 'exit');
        let output = '', errors = '';
        child.stderr.on('data', chunk => { errors += chunk; });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Missing ${boundary}: ${output} ${errors}`)), 15000);
                child.stdout.on('data', chunk => {
                    output += chunk;
                    if (output.includes(JSON.stringify({ boundary }))) { clearTimeout(timer); resolve(); }
                });
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('exit', () => { clearTimeout(timer); reject(new Error(`Early exit: ${output} ${errors}`)); });
            });
            assert.equal(child.kill('SIGKILL'), true);
            await exited;
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
        }
        ageLocks(f.root);
        const recovered = fresh(specPath, 'recover');
        assert.equal(recovered.bytesIntact, true);
        assert.equal(recovered.descriptors, 0);
        if (!stable && ['after-rename', 'before-record'].includes(boundary)) {
            assert.equal(recovered.error?.code, 'ROLEPLAY_SOURCE_CHANGED');
            assert.equal(recovered.pending.kind, 'lifecycle');
            assert.notEqual(recovered.pending.steps[0].physical.ino, recovered.physical.ino);
            assert.equal(Object.values(recovered.resources).some(value => value.locator?.avatar === 'Probe.png'), false);
            const repaired = fresh(specPath, 'repair');
            assert.equal(repaired.error, undefined, JSON.stringify(repaired));
            assert.equal(repaired.result.repaired, true);
            assert.equal(repaired.bytesIntact, true);
        } else {
            assert.equal(recovered.error, undefined, JSON.stringify(recovered));
            assert.equal(recovered.pending, null);
            const card = Object.values(recovered.resources).find(value => value.locator?.avatar === 'Probe.png');
            assert.equal(card.revision, 1);
            assert.deepEqual(card.head.physical, recovered.physical);
            const again = fresh(specPath, 'recover');
            assert.equal(again.error, undefined);
            assert.deepEqual(again.resources, recovered.resources);
        }
    });
}
