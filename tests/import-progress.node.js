import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importProgress } from '../src/import-progress.js';
import { readImportProgress } from '../public/scripts/import-progress.js';

test('measured import stream survives split chunks and reports completion only after success', async () => {
    let wire = '';
    const response = { type() {}, set() {}, write(value) { wire += value; this.headersSent = true; }, end() {} };
    const progress = importProgress({ get: () => 'application/x-ndjson' }, response);
    progress.report(0, 0, 'Checking archive');
    progress.report(1, 4, 'Importing');
    progress.report(4, 4, 'Finishing');
    progress.finish({ importedFiles: 4 });
    const observed = [];
    const stream = new ReadableStream({ start(controller) {
        const bytes = new TextEncoder().encode(wire);
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
    } });
    assert.deepEqual(await readImportProgress(new Response(stream), value => observed.push(value.percent)), { importedFiles: 4 });
    assert.deepEqual(observed, [null, 25, 99, 100]);
    await assert.rejects(readImportProgress(new Response('{"type":"progress","percent":50}\n'), () => {}), /before completion/);
    await assert.rejects(readImportProgress(new Response('{"type":"error","error":"Disk full"}\n'), () => {}), /Disk full/);
});
