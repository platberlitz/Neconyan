/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { clearAppEvidenceLog, getProviderFailures } from '../public/scripts/app-evidence-log.js';
import { formatAppEvidence } from '../public/scripts/scratchpad/evidence.js';
import {
    backendLabel,
    isStoppedRequest,
    readBackendFailure,
    watchTextBackend,
    withoutEchoes,
    withoutServerAddresses,
} from '../public/scripts/text-backend-failures.js';

const PROMPT = 'The violet lighthouse keeper whispered about the marmalade moon to nobody.';
const REPLY = 'Her answer drifted over the cold harbour like a lantern with a secret.';
const KEY = 'sk-PLANTEDtextbackendKEY1234567890abcdef';
const URL_WITH_LOGIN = 'http://llamauser:hunter2pass@192.168.1.5:5001/v1/completions?api_key=querysecret99';

function everything() {
    return JSON.stringify(getProviderFailures()).toLowerCase();
}

function expectClean() {
    const text = everything();
    for (const secret of [PROMPT, REPLY, KEY, 'hunter2pass', 'llamauser', 'querysecret99', '192.168.1.5', 'violet lighthouse', 'lantern with a secret']) {
        expect(text).not.toContain(secret.toLowerCase());
    }
}

beforeEach(() => clearAppEvidenceLog());

describe('readBackendFailure', () => {
    test.each([
        ['KoboldAI error object', { error: { message: 'Out of memory' } }, 400, 'Out of memory', 400],
        ['KoboldAI detail', { detail: { msg: 'bad sampler' } }, 422, 'bad sampler', 422],
        ['NovelAI message', { message: 'Invalid token' }, 401, 'Invalid token', 401],
        ['text completion wrapper', { error: true, status: 503, response: 'model is loading' }, 502, 'model is loading', 503],
        ['wrapper holding JSON', { error: true, status: '400', response: '{"error":{"message":"context length exceeded"}}' }, 400, 'context length exceeded', 400],
        ['plain JSON string', '{"error":"no slots available"}', 500, 'no slots available', 500],
        ['validation array', { detail: [{ msg: 'a' }, { msg: 'b' }] }, 422, 'a; b', 422],
        ['HTML page', '<html><body><h1>502 Bad Gateway</h1></body></html>', 502, '502 Bad Gateway', 502],
        ['plain text', 'upstream timed out', 504, 'upstream timed out', 504],
    ])('%s', (_name, body, http, message, status) => {
        expect(readBackendFailure(body, http)).toEqual({ message, status });
    });

    test('says so when the backend sent nothing', () => {
        expect(readBackendFailure({ error: true }, 0)).toEqual({ message: 'The backend sent no error message.', status: 0 });
        expect(readBackendFailure('', 500, 'Internal Server Error')).toEqual({ message: 'Internal Server Error', status: 500 });
    });

    test('ignores a status outside the HTTP range', () => {
        expect(readBackendFailure({ error: true, status: 'ECONNREFUSED', response: 'connect failed' }, 502).status).toBe(502);
        expect(readBackendFailure({ message: 'x', status: 9000 }, 0).status).toBe(0);
    });
});

describe('server addresses', () => {
    test.each([
        ['connect ECONNREFUSED 192.168.1.5:5001', 'connect ECONNREFUSED [server address]'],
        ['request to http://user:pw@my.lan:5000/v1?key=1 failed', 'request to [server address] failed'],
        ['fetch //user:pw@host.lan:80/x', 'fetch [server address]'],
        ['getaddrinfo ENOTFOUND my-llama.home.arpa', 'getaddrinfo ENOTFOUND [server address]'],
        ['localhost:5000 refused', '[server address] refused'],
        ['http://[::1]:5000/x', '[server address]'],
        ['kobold.example.com:5001 down', '[server address] down'],
    ])('%s', (input, expected) => {
        expect(withoutServerAddresses(input)).toBe(expected);
    });

    test('leaves ordinary words alone', () => {
        expect(withoutServerAddresses('Context length 4096 exceeded, try v1.2 or less')).toBe('Context length 4096 exceeded, try v1.2 or less');
    });
});

describe('echoed prompt and reply text', () => {
    test('a quoted prompt is cut out, whatever its case or escaping', () => {
        const quoted = withoutEchoes(`Context exceeded near "${PROMPT.toUpperCase()}" please shorten`, [PROMPT]);
        expect(quoted.toLowerCase()).not.toContain('violet lighthouse');
        expect(quoted).toContain('[text removed]');
        expect(quoted).toContain('Context exceeded near');
        const escaped = withoutEchoes('bad json: "The violet lighthouse keeper\\nwhispered about the marmalade moon to nobody."', [PROMPT]);
        expect(escaped.toLowerCase()).not.toContain('marmalade');
    });

    test('a small part of a long prompt is still found', () => {
        const prompt = `${'Filler words that go first. '.repeat(20)}${PROMPT}${' Closing words that go last.'.repeat(20)}`;
        expect(withoutEchoes(`Invalid input: ...keeper whispered about the marmalade moon to ...`, [prompt]).toLowerCase()).not.toContain('marmalade');
    });

    test('the backend\'s own wording stays', () => {
        expect(withoutEchoes('context length exceeded: 5000 > 4096', [PROMPT, REPLY])).toBe('context length exceeded: 5000 > 4096');
    });

    test('a message with nothing to compare is unchanged', () => {
        expect(withoutEchoes('anything at all here', [])).toBe('anything at all here');
    });
});

describe('stopped requests', () => {
    test('aborts are not failures', () => {
        const controller = new AbortController();
        controller.abort();
        expect(isStoppedRequest(new Error('x'), controller.signal)).toBe(true);
        expect(isStoppedRequest(Object.assign(new Error('x'), { name: 'AbortError' }), null)).toBe(true);
        expect(isStoppedRequest(new Error('x'), new AbortController().signal)).toBe(false);
    });

    test('a request the person stopped records nothing, however it ends', async () => {
        const controller = new AbortController();
        const watch = watchTextBackend({ kind: 'kobold', signal: controller.signal });
        controller.abort();
        await expect(watch.run(async () => { throw new DOMException('This operation was aborted', 'AbortError'); })).rejects.toThrow();
        watch.fail(new Error('late'));
        expect(getProviderFailures()).toEqual([]);
    });
});

describe('what an entry holds', () => {
    test.each([
        ['kobold', '', 'koboldai'],
        ['novel', '', 'novelai'],
        ['text', 'llamacpp', 'text completion (llamacpp)'],
        ['text', '', 'text completion'],
        ['text', 'koboldcpp/../x y', 'text completion (koboldcpp..xy)'],
    ])('%s %s is %s', (kind, type, label) => {
        expect(backendLabel(kind, type)).toBe(label);
    });

    test('a rejected response keeps provider, model, status and the backend\'s message only', () => {
        const watch = watchTextBackend({ kind: 'text', type: 'tabby', model: 'qwen-7b', data: { prompt: PROMPT, api_server: 'http://192.168.1.5:5001' } });
        watch.rejected({ status: 502, statusText: 'Bad Gateway' }, JSON.stringify({ error: true, status: 500, response: `Bad request at ${URL_WITH_LOGIN}: "${PROMPT}" Authorization: Bearer ${KEY}` }));
        const [entry] = getProviderFailures();
        expect(entry).toMatchObject({ provider: 'text completion (tabby)', model: 'qwen-7b', status: 500 });
        expect(Object.keys(entry).sort()).toEqual(['at', 'message', 'model', 'provider', 'status']);
        expectClean();
    });

    test('a 200 body that carries an error is a failure; one that does not is not', () => {
        const watch = watchTextBackend({ kind: 'novel', model: 'kayra-v1' });
        watch.answered({ results: [{ text: REPLY }] });
        expect(getProviderFailures()).toEqual([]);
        watch.answered({ error: true });
        expect(getProviderFailures()).toHaveLength(1);
        expect(getProviderFailures()[0]).toMatchObject({ provider: 'novelai', model: 'kayra-v1', status: 0 });
    });

    test('a thrown body object is read like a response body', () => {
        const watch = watchTextBackend({ kind: 'kobold' });
        watch.fail({ error: { message: 'Model busy' } }, 400);
        expect(getProviderFailures()[0]).toMatchObject({ provider: 'koboldai', status: 400, message: 'Model busy' });
    });
});

describe('one failed request, one entry', () => {
    test('every route into the same watch records once', async () => {
        const watch = watchTextBackend({ kind: 'text', type: 'ooba' });
        watch.rejected({ status: 500, statusText: 'x' }, { error: 'first' });
        watch.fail(new Error('Got response status 500'));
        watch.answered({ error: 'again' });
        expect(getProviderFailures()).toHaveLength(1);
        expect(getProviderFailures()[0].message).toBe('first');
    });

    test('a request that succeeds records nothing', async () => {
        const watch = watchTextBackend({ kind: 'text', type: 'ooba' });
        const stream = await watch.run(async () => async function* () { yield { text: 'a' }; yield { text: 'ab' }; });
        const seen = [];
        for await (const chunk of stream()) seen.push(chunk.text);
        expect(seen).toEqual(['a', 'ab']);
        expect(getProviderFailures()).toEqual([]);
    });

    test('a stream that breaks after part of a reply records once and keeps the error moving', async () => {
        const watch = watchTextBackend({ kind: 'text', type: 'llamacpp', model: 'm', data: { prompt: PROMPT } });
        const stream = await watch.run(async () => async function* () {
            yield { text: REPLY };
            throw new Error(`The provider disconnected before completing the reply. Last words: ${REPLY}`);
        });
        await expect((async () => { for await (const _chunk of stream()) { /* drain */ } })()).rejects.toThrow('disconnected');
        expect(getProviderFailures()).toHaveLength(1);
        expect(getProviderFailures()[0].message).toContain('disconnected before completing');
        expectClean();
    });

    test('a stream that is stopped part way records nothing', async () => {
        const controller = new AbortController();
        const watch = watchTextBackend({ kind: 'novel', signal: controller.signal });
        const stream = watch.observe(async function* () {
            yield { text: 'a' };
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
        });
        await expect((async () => { for await (const _chunk of stream()) { /* drain */ } })()).rejects.toThrow();
        expect(getProviderFailures()).toEqual([]);
    });

    test('a JSON error that arrives with a 200 for a streamed request is noted without touching the response', async () => {
        const watch = watchTextBackend({ kind: 'kobold', model: 'Nemo' });
        const response = new Response(JSON.stringify({ error: true }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
        await watch.inspect(response);
        expect(getProviderFailures()).toHaveLength(1);
        expect(await response.text()).toBe('{"error":true}');
        clearAppEvidenceLog();
        const stream = new Response('data: {"token":"hi"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
        await watchTextBackend({ kind: 'kobold' }).inspect(stream);
        expect(getProviderFailures()).toEqual([]);
    });

    test('a lost connection is noted with the error text and no status', async () => {
        const watch = watchTextBackend({ kind: 'text', type: 'vllm', model: 'm' });
        await expect(watch.run(async () => { throw new TypeError(`request to ${URL_WITH_LOGIN} failed, reason: connect ECONNREFUSED 192.168.1.5:5001`); })).rejects.toThrow();
        expect(getProviderFailures()[0]).toMatchObject({ provider: 'text completion (vllm)', status: 0 });
        expectClean();
    });
});

describe('what the assistant receives', () => {
    test('entries read like the chat completion ones in ## App evidence', () => {
        const watch = watchTextBackend({ kind: 'text', type: 'koboldcpp', model: 'mistral-nemo' });
        watch.rejected({ status: 400, statusText: 'Bad Request' }, { error: true, status: 400, response: 'Prompt is too long' });
        const text = formatAppEvidence({ modelFailures: getProviderFailures() });
        expect(text).toMatch(/- \d{4}-\d\d-\d\dT[\d:.]+Z text completion \(koboldcpp\) \/ mistral-nemo: HTTP 400, "Prompt is too long"/);
    });
});

describe('wiring', () => {
    const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

    test('the helper imports nothing but the recorder', () => {
        expect(read('scripts/text-backend-failures.js').match(/^import .*$/gm)).toEqual(["import { recordProviderFailure } from './app-evidence-log.js';"]);
    });

    test('the recorder still has no dependency on the app', () => {
        expect(read('scripts/app-evidence-log.js').match(/^import .*$/gm)).toEqual(["import { redactEvidenceText } from './scratchpad/evidence.js';"]);
    });

    test.each([
        ['scripts/kai-settings.js', "kind: 'kobold'"],
        ['scripts/nai-settings.js', "kind: 'novel'"],
        ['scripts/textgen-settings.js', "kind: 'text'"],
        ['scripts/custom-request.js', "kind: 'text'"],
        ['script.js', 'requestBackendJson'],
    ])('%s watches its request', (file, marker) => {
        const source = read(file);
        expect(source).toContain(marker);
        expect(source).toContain('watchTextBackend');
    });

    test('the two non-streaming routes in script.js share one request function', () => {
        const source = read('script.js');
        expect(source.match(/requestBackendJson\(/g)).toHaveLength(3);
        expect(source).not.toMatch(/fetchResumable\(generateUrl/);
    });
});
