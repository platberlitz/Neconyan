import assert from 'node:assert/strict';
import test from 'node:test';
import { safeProviderErrorMessage } from '../src/generation/provider-error.js';

const options = { status: 400, statusText: 'Bad Request' };
const message = (body, extra = {}) => safeProviderErrorMessage(body, { ...options, ...extra });

test('provider diagnostics use recognised nonblank strings in order', () => {
    assert.equal(message({ error: { message: '  First\nreason\u0000  ' }, message: 'Second', detail: 'Third' }), 'First reason');
    assert.equal(message({ error: 'String error', message: 'Second' }), 'String error');
    assert.equal(message({ error: { message: {} }, message: 'Second', detail: 'Third' }), 'Second');
    assert.equal(message({ error: '  ', message: '\t', detail: 'Detail' }), 'Detail');
    for (const body of [null, '', 'Unrecognised root string', [], {}, { error: { secret: 'private' } }, { error: true }, { detail: 42 }]) {
        assert.equal(message(body), 'Bad Request');
    }
});

test('empty or unsafe status text uses a bounded numeric HTTP fallback', () => {
    for (const status of [400, 429, 502, 503]) {
        assert.equal(message({}, { status, statusText: '' }), `The model provider could not complete the reply (HTTP ${status}).`);
        assert.equal(message({}, { status, statusText: '<html>Private response</html>' }), `The model provider could not complete the reply (HTTP ${status}).`);
    }
    assert.equal(message({}, { status: 'ECONNRESET', statusText: '' }), 'The model provider could not complete the reply.');
});

test('credentials, unknown outgoing headers and credential URLs are redacted', () => {
    const secret = 'configured-private-value', header = 'unknown-header-private-value';
    const result = message({ error: { message: `Invalid ${secret}; ${header}; Bearer abc123; Basic YWJjOmRlZg==; api_key="unconfigured-value"; password=pass123; https://alice:pass456@example.invalid/path?key=query-secret#fragment-secret https://username-only@example.invalid/path /path?token=relative-secret sk-abcdefghijklmnop` } },
        { secrets: [secret], headers: { 'X-Unusual': header } });
    for (const value of [secret, header, 'abc123', 'YWJjOmRlZg==', 'unconfigured-value', 'pass123', 'alice', 'pass456', 'username-only', 'query-secret', 'fragment-secret', 'relative-secret', 'sk-abcdefghijklmnop']) {
        assert.equal(result.includes(value), false, value);
    }
    assert.match(result, /Invalid \[redacted\]/);
    assert.ok(result.length <= 500);
});

test('redaction completes before the display bound can cut a credential', () => {
    const secret = 'PRIVATE-CREDENTIAL-'.repeat(12);
    const prefix = 'x'.repeat(480) + ' ';
    const result = message({ message: prefix + secret }, { secrets: [secret] });
    assert.equal(result, prefix + '[redacted]');
    const assignment = message({ message: prefix + 'api_key="' + secret + '"' });
    assert.equal(assignment, (prefix + 'api_key=[redacted]').slice(0, 500));
    const bearer = message({ message: prefix + 'Bearer ' + secret });
    assert.equal(bearer, (prefix + 'Bearer [redacted]').slice(0, 500));
    assert.equal(bearer.includes('PRIVATE'), false);
});

test('unsafe structured text and obvious full or partial request echoes fall back', () => {
    const requestBody = { model: 'fixture', messages: [{ role: 'user', content: 'Private garden: blue violets bloom across the quiet courtyard tonight.' }],
        private_instruction: 'KEEP-THIS-CUSTOM-REQUEST-VALUE-PRIVATE' };
    for (const diagnostic of [
        '<html>Private provider error</html>', '{"messages":[{"content":"private"}]}',
        'Provider replied: {"private":"body content"}',
        'Prompt: private text', 'Messages = private text',
        'Rejected: Private garden: blue violets bloom across the quiet courtyard tonight.',
        'Rejected near blue violets bloom across the quiet courtyard.',
        'Invalid KEEP-THIS-CUSTOM-REQUEST-VALUE-PRIVATE',
        'The limit is exceeded. ' + 'x'.repeat(520) + ' blue violets bloom across the quiet courtyard',
    ]) assert.equal(message({ error: { message: diagnostic } }, { requestBody }), 'Bad Request');
    assert.equal(message({ message: 'x'.repeat(65537) }), 'Bad Request');
});

test('ordinary reasoning and token-limit explanations survive ordinary request content', () => {
    const requestBody = { model: 'fixture', reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'Hello, write a short story about a garden.' }] };
    for (const diagnostic of [
        'The selected reasoning effort xhigh is not supported by this model.',
        'reasoning.effort must be one of [\'low\', \'medium\', \'high\'].',
        'reasoning.effort must be one of ["low", "medium", "high"].',
        'The prompt exceeds the context limit of 32768 tokens.',
        'max_tokens must be less than or equal to 16384.',
        'The requested output budget exceeds this model\'s maximum.',
        'The model provider is busy. Please try again later.',
    ]) assert.equal(message({ message: diagnostic }, { requestBody }), diagnostic);
    assert.equal(message({ message: 'The model provider is busy.' }, { requestBody: { messages: [{ role: 'user', content: 'is' }] } }), 'The model provider is busy.');
    assert.equal(message({ message: 'The model provider is there.' }, { requestBody: { messages: [{ content: 'here' }] } }), 'The model provider is there.');
});

test('short complete request values are rejected in diagnostics and status text', () => {
    for (const [content, diagnostic] of [['PIN 1234', 'Rejected: PIN 1234'], ['secret42', 'Invalid secret42']]) {
        const requestBody = { messages: [{ role: 'user', content }] };
        assert.equal(message({ error: { message: diagnostic } }, { requestBody }), 'Bad Request');
        assert.equal(message({}, { requestBody, statusText: diagnostic }), 'The model provider could not complete the reply (HTTP 400).');
        assert.equal(message({ message: diagnostic }, { requestBody, statusText: diagnostic }), 'The model provider could not complete the reply (HTTP 400).');
    }
    const requestBody = { messages: [{ content: 'secret42' }] };
    assert.equal(message({ message: 'Expected one of ["low", "secret42"].' }, { requestBody }), 'Bad Request');
    assert.equal(message({ message: 'Expected one of ["low", "opaque-secret"].' }, { secrets: ['opaque-secret'] }), 'Expected one of ["low", "[redacted]"].');
});

test('only a bounded normalised diagnostic leaves the helper', () => {
    assert.equal(message({ detail: 'x'.repeat(1000) }), 'x'.repeat(500));
    assert.equal(message({ detail: '  Model\t unavailable\ntry\u0000 again\u007f\u202e  ' }), 'Model unavailable try again');
    assert.equal(message({ message: 'Value opaque-secret is invalid' }, { secrets: ['opaque-secret'], requestBody: { messages: [{ content: 'Separate private request' }] } }), 'Value [redacted] is invalid');
});
