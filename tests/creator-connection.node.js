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

test('The main chat Stop event does not start a fallback', async () => {
    let calls = 0;
    await assert.rejects(requestCreatorConnection({ writing: { connection: { fallbacks: ['second'] } } }, {
        validate() {},
        async send() { calls++; throw new Error('Cancelled by stop event'); },
    }), /Cancelled by stop event/);
    assert.equal(calls, 1);
});

test('Failed connections retain every labelled error in attempt order', async () => {
    await assert.rejects(requestCreatorConnection({ writing: { connection: { fallbacks: ['missing'] } } }, {
        validate() {},
        profileLabel: profile => profile ? 'Deleted backup' : 'Current connection',
        async send(profile) { throw new Error(profile ? 'Profile not found' : 'Authentication failed'); },
    }), /Current connection: Authentication failed\nDeleted backup: Profile not found/);
});

test('Wrapped profile errors include the provider cause', async () => {
    await assert.rejects(requestCreatorConnection({}, {
        validate() {},
        async send() { throw new Error('API request failed', { cause: new Error('The API key was rejected') }); },
    }), /API request failed: The API key was rejected/);
});
