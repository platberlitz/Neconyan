import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { createMessageTokenCounter } = await import('../src/generation/message-token-counts.js');

test('counts reasoning before output and publishes the last chunk even if the stream pauses', async t => {
    const updates = [];
    const counter = await createMessageTokenCounter(value => updates.push(value));
    t.after(() => counter.stop());
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    counter.publish({ reasoning: 'Think carefully.' });
    assert.equal(updates[0].token_count, 0);
    assert.ok(updates[0].reasoning_tokens > 0);
    counter.publish({ text: 'A short reply.', reasoning: 'Think carefully. Check again.' });
    assert.equal(updates.length, 1);
    t.mock.timers.tick(500);
    assert.equal(updates.length, 2);
    assert.ok(updates[1].token_count > 0);
    assert.ok(updates[1].reasoning_tokens > updates[0].reasoning_tokens);
});

test('cancellation discards a queued update and stops future publications', async t => {
    const updates = [];
    const controller = new AbortController();
    const counter = await createMessageTokenCounter(value => updates.push(value), { signal: controller.signal });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    counter.publish({ text: 'First' });
    counter.publish({ text: 'Later' });
    controller.abort();
    t.mock.timers.tick(1000);
    counter.publish({ text: 'Too late' });
    assert.equal(updates.length, 1);
});
