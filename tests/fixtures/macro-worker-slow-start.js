/* global SharedArrayBuffer, Atomics */
// Test-only worker: blocks for 2.5 s before the real macro worker loads, like a slow phone loading its modules.
const sleeper = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sleeper, 0, 0, 2500);
await import('../../src/creator/macro-worker.js');
