// Test-only worker: reports it is ready, then never finishes.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
for (;;) { /* runs until the parent terminates the thread */ }
