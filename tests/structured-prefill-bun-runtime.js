#!/usr/bin/env bun
/**
 * Bun runtime regression check for Structured Prefill.
 *
 * Bun before 1.4.0 used a VM-wide watchdog for node:vm timeouts. The same
 * decoder plus ordinary host work in the same JavaScript turn could freeze the
 * process. Bun 1.4.0 replaced it with a per-run deadline (upstream PR #38660).
 *
 * Run with a bounded process deadline:
 *   timeout 20s bun tests/structured-prefill-bun-runtime.js
 */
import assert from 'node:assert/strict';
import { compileStructuredPrefill } from '../public/scripts/structured-prefill.js';
import { bunVersionSupportsStructuredPrefill } from '../src/runtime-support.js';
import { createPrefillDecoder, prepareStructuredPrefill } from '../src/structured-prefill.js';

const bunVersion = process.versions?.bun;
if (!bunVersion) {
    console.log('structured-prefill Bun runtime check skipped: this check runs on Bun.');
    process.exit(0);
}
const runtimeLabel = `Bun ${bunVersion}`;
const supported = bunVersionSupportsStructuredPrefill(bunVersion);
const compiled = compileStructuredPrefill('Start ', { enabled: true, min_chars_after_prefix: 0 });

if (!supported) {
    assert.throws(() => createPrefillDecoder(compiled), error => {
        assert.equal(error.code, 'STRUCTURED_PREFILL_UNSUPPORTED_RUNTIME');
        assert.match(error.message, /Node 24 or Bun 1\.4\.0 or later/);
        return true;
    });
    const request = { body: {
        chat_completion_source: 'custom',
        messages: [{ role: 'user', content: 'Hello' }],
        assistant_prefill: 'Start ',
        structured_prefill: { enabled: true, type: 'normal', min_chars_after_prefix: 0 },
    } };
    await assert.rejects(() => prepareStructuredPrefill(request), error => {
        assert.equal(error.code, 'STRUCTURED_PREFILL_UNSUPPORTED_RUNTIME');
        assert.match(error.message, /Your settings and chat were not changed/);
        return true;
    });
    assert.equal(request.body.structured_prefill.enabled, true, 'The setting must not be silently removed');
    console.log(`structured-prefill Bun guard: ok (${runtimeLabel} is refused before node:vm)`);
    process.exit(0);
}

const decoder = createPrefillDecoder(compiled);
const first = decoder.push(JSON.stringify({ response: 'Start reply from the Bun regression check.' }));
const last = decoder.finish();
assert.equal(first.text + last.text, 'Start reply from the Bun regression check.');
assert.equal(last.metadata.verification, 'matched');

// Ordinary host work in the same JavaScript turn as the timed node:vm calls.
// Bun 1.3.14 froze here; 1.4.0 and later must complete.
const end = Date.now() + 300;
let spins = 0;
while (Date.now() < end) spins += 1;
assert.ok(spins > 0);

console.log(`structured-prefill Bun runtime check: ok (${runtimeLabel}, ${spins} host spins)`);
