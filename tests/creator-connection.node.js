import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorConnection, requestCreatorConnection } from '../public/scripts/creator/connection.js';

test('Creator defaults to current connection and 64000 output tokens', () => {
    assert.deepEqual(creatorConnection({}), { profiles: [''], maxTokens: 64000 });
    assert.throws(() => creatorConnection({ writing: { connection: { maxTokens: -1 } } }), /positive/);
});

test('Creator tries distinct fallbacks in order with the same token limit', async () => {
    const calls = [];
    const result = await requestCreatorConnection({ writing: { connection: { profile: 'primary', fallbacks: ['primary', 'second', 'third'], maxTokens: 1234 } } }, {
        validate() {},
        async send(profile, tokens) {
            calls.push([profile, tokens]);
            if (profile !== 'third') throw new Error('Unavailable');
            return 'reply';
        },
    });
    assert.equal(result, 'reply');
    assert.deepEqual(calls, [['primary', 1234], ['second', 1234], ['third', 1234]]);
});

test('Cancellation never starts a fallback', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(requestCreatorConnection({ writing: { connection: { fallbacks: ['second'] } } }, {
        signal: controller.signal, validate() {},
        async send() { calls++; controller.abort(); throw new Error('Cancelled'); },
    }), /Cancelled/);
    assert.equal(calls, 1);
});

test('A changed draft or account stops fallback requests', async () => {
    let current = true;
    let calls = 0;
    await assert.rejects(requestCreatorConnection({ writing: { connection: { fallbacks: ['second'] } } }, {
        validate() { if (!current) throw new Error('Source changed'); },
        async send() { calls++; current = false; throw new Error('Connection failed'); },
    }), /Source changed/);
    assert.equal(calls, 1);
});
