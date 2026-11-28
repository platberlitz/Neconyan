import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_UNREACHABLE, PROVIDER_UNREACHABLE_MESSAGES, providerReachFailure, providerUnreachableReply } from '../src/generation/provider-reach.js';

const withCode = (code, message = `connect ${code}`) => Object.assign(new Error(message), { code });

test('connection failures to the AI provider say which kind they were', () => {
    assert.equal(providerReachFailure(withCode('ECONNREFUSED')), 'refused');
    assert.equal(providerReachFailure(withCode('ENOTFOUND')), 'not_found');
    assert.equal(providerReachFailure(withCode('EAI_AGAIN')), 'not_found');
    assert.equal(providerReachFailure(withCode('ETIMEDOUT')), 'timeout');
    assert.equal(providerReachFailure(withCode('ECONNRESET')), 'reset');
    assert.equal(providerReachFailure(withCode('EHOSTUNREACH')), 'unknown');
    assert.equal(providerReachFailure(withCode('CERT_HAS_EXPIRED')), 'certificate');
    assert.equal(providerReachFailure(withCode('DEPTH_ZERO_SELF_SIGNED_CERT')), 'certificate');
    assert.equal(providerReachFailure(Object.assign(new Error('network timeout at: https://provider.invalid'), { name: 'FetchError', type: 'request-timeout' })), 'timeout');
    assert.equal(providerReachFailure(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })), 'timeout');
});

test('undici errors are read through their cause', () => {
    const undici = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
    assert.equal(providerReachFailure(undici(withCode('ECONNREFUSED'))), 'refused');
    assert.equal(providerReachFailure(undici(withCode('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))), 'timeout');
    assert.equal(providerReachFailure(undici(withCode('UND_ERR_SOCKET', 'other side closed'))), 'reset');
    assert.equal(providerReachFailure(new TypeError('fetch failed')), 'unknown');
    assert.equal(providerReachFailure(new TypeError('terminated')), 'unknown');
});

test('errors that are not connection failures keep their own wording', () => {
    assert.equal(providerReachFailure(new Error('This provider is temporarily disabled.')), null);
    assert.equal(providerReachFailure(new TypeError('Cannot read properties of undefined')), null);
    assert.equal(providerReachFailure(null), null);
    assert.equal(providerReachFailure('ECONNREFUSED'), null);
    assert.equal(providerUnreachableReply(new Error('Invalid model.')), null);
    const loop = new Error('loop');
    loop.cause = loop;
    assert.equal(providerReachFailure(loop), null);
});

test('the reply carries a plain message, a code and the reason, but not the raw error', () => {
    const reply = providerUnreachableReply(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5001'), { code: 'ECONNREFUSED', address: '10.0.0.5', port: 5001 }));
    assert.deepEqual(reply, { error: { message: PROVIDER_UNREACHABLE_MESSAGES.refused, code: PROVIDER_UNREACHABLE, reason: 'refused' } });
    assert.equal(JSON.stringify(reply).includes('10.0.0.5'), false);
    for (const message of Object.values(PROVIDER_UNREACHABLE_MESSAGES)) {
        assert.match(message, /AI provider/);
        assert.doesNotMatch(message, /\u2014/);
        assert.doesNotMatch(message, /your connection to Neconyan|Could not reach the server/i);
    }
});
