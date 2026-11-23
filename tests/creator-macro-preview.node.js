import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { previewCreatorMacros } from '../src/creator/macro-preview.js';

const fixture = name => new URL(`./fixtures/${name}`, import.meta.url);

/** Resolves with the worker's exit code, or rejects after a real 5 s wait if the thread is still running. */
function exitOf(worker) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The worker thread was still running 5 s after the preview ended.')), 5000);
        worker.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
}

test('macro preview counts its 2 s limit from when the worker is ready, not from when it was created', async () => {
    const started = performance.now();
    const result = await previewCreatorMacros({ text: '{{char}} {{setvar::a::1}}{{getvar::a}}', character: 'Mira' }, { workerUrl: fixture('macro-worker-slow-start.js') });
    const elapsed = performance.now() - started;
    assert.equal(result.output, 'Mira 1');
    assert.ok(elapsed > 2000, `start-up was delayed past 2 s (took ${Math.round(elapsed)} ms)`);
});

test('macro preview stops a worker that runs for more than 2 s after it is ready', async () => {
    let exited;
    const started = performance.now();
    await assert.rejects(
        previewCreatorMacros({ text: 'x' }, { workerUrl: fixture('macro-worker-runaway.js'), startupTimeoutMs: 20000, onWorker: worker => { exited = exitOf(worker); } }),
        error => error.message === 'The macro preview exceeded its time limit.' && error.status === 400,
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1990, `the 2 s limit ran its course (took ${Math.round(elapsed)} ms)`);
    assert.ok(elapsed < 10000, `the start-up bound did not decide this (took ${Math.round(elapsed)} ms)`);
    await exited;
});

test('macro preview ends a worker that never becomes ready at the start-up bound, with its own message', async () => {
    let exited;
    const started = performance.now();
    await assert.rejects(
        previewCreatorMacros({ text: 'x' }, { workerUrl: fixture('macro-worker-never-ready.js'), startupTimeoutMs: 600, onWorker: worker => { exited = exitOf(worker); } }),
        error => error.message === 'The macro preview could not start. Try again.' && error.status === 503,
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 590, `the start-up bound ran its course (took ${Math.round(elapsed)} ms)`);
    assert.ok(elapsed < 2000, `the 2 s running limit did not decide this (took ${Math.round(elapsed)} ms)`);
    await exited;
});

test('macro preview reports a worker that exits with an error code as stopped', async () => {
    await assert.rejects(
        previewCreatorMacros({ text: 'x' }, { workerUrl: fixture('macro-worker-exits.js') }),
        error => error.message === 'The macro preview stopped.' && error.status === 400,
    );
});

test('macro preview ignores test options smuggled into the input', async () => {
    const result = await previewCreatorMacros({ text: 'ok', workerUrl: fixture('macro-worker-runaway.js').href, startupTimeoutMs: 1 });
    assert.equal(result.output, 'ok');
});
