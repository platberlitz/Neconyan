import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';

import { fixture } from './roleplay-transactions-fixture.js';

const { SETTINGS_FILE } = await import('../src/constants.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getJob, listJobs, requestCancellation } = await import('../src/jobs/store.js');
const { createProviderScope, providerStep, readArtifact, unresolvedProviderStep } = await import('../src/jobs/artifacts.js');
const { abortJob, testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { acceptScratchpadReply, registerScratchpadJobs, testExports: jobs } = await import('../src/scratchpad/jobs.js');
const store = await import('../src/scratchpad/store.js');
const web = await import('../src/scratchpad/web-search.js');
const { buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');
const { SECRET_KEYS, SecretManager, writeSecret } = await import('../src/endpoints/secrets.js');

after(() => cancelAutoSaves());

const SOURCE = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
let counter = 0;

function account(t) {
    const f = fixture(t, false, 'scratch-web');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    setDirectoriesResolver(() => directories);
    const request = body => ({ user: { profile: { handle: f.scope.owner, admin: true }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const read = source => store.withScratchpad(base, lease => store.readBucketLocked(lease, source));
    return { f, directories, request, base, read };
}

function startSession(a, settings = {}) {
    return store.mutateBucket(a.base, SOURCE, bucket => store.createSession(bucket, {
        assistant: 'taro', settings: { connection: { kind: 'profile', profileId: 'saved' }, ...settings },
    }));
}

function sendBody(session, extra = {}) {
    return {
        submissionKey: `web-${++counter}`,
        source: SOURCE,
        sessionId: session.id,
        text: 'What is Nova hiding in this scene?',
        context: '#1 User: Original\n#2 Nova: Answer',
        capabilities: { lore: true, character: true, chat: true },
        names: { user: 'Kris', character: 'Nova' },
        ...extra,
    };
}

function updateConfig(a, values, { admin = true } = {}) {
    return store.withScratchpad(a.base, lease => web.updateWebSearchLocked(lease, values, web.readWebSearchLocked(lease).revision, { admin }));
}

function state(a) {
    return store.withScratchpad(a.base, lease => web.webSearchStateLocked(lease));
}

function response(payload, status = 200) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-length': String(Buffer.byteLength(text)) }),
        body: Readable.from([Buffer.from(text)]),
    };
}

function streamedResponse(chunks) {
    return { ok: true, status: 200, headers: new Headers(), body: Readable.from(chunks.map(chunk => Buffer.from(chunk))) };
}

function braveKey(a, value = 'brave-secret-value') {
    return writeSecret(a.directories, SECRET_KEYS.BRAVE_SEARCH, value);
}

test('web search settings default off, normalise counts and expose no key value', t => {
    const a = account(t);
    const initial = state(a);
    assert.equal(initial.webSearch.provider, 'off');
    assert.equal(initial.webSearch.results, 5);
    assert.equal(initial.webSearch.revision, 0);
    assert.equal(initial.readiness.configured, false);
    assert.equal(initial.readiness.missing, 'off');

    braveKey(a);
    updateConfig(a, { provider: 'brave', results: 50 });
    const ready = state(a);
    assert.equal(ready.webSearch.results, 10, 'the result count is capped at ten');
    assert.equal(ready.readiness.configured, true);
    assert.ok(!JSON.stringify(ready).includes('brave-secret-value'), 'the response never contains the key value');
    assert.ok(!JSON.stringify(ready).includes('keyId'), 'the selected key id stays server-side');
});

test('web search settings are revision-safe and belong to one account', t => {
    const a = account(t), b = account(t);
    const saved = updateConfig(a, { provider: 'searxng', searxngUrl: 'https://search.example.com/searxng/' });
    assert.equal(saved.revision, 1);
    assert.equal(saved.searxngUrl, 'https://search.example.com/searxng');
    assert.throws(() => store.withScratchpad(a.base, lease => web.updateWebSearchLocked(lease,
        { provider: 'off' }, 0)), { code: 'SCRATCHPAD_WEB_SEARCH_CHANGED' });
    assert.equal(state(a).webSearch.searxngUrl, 'https://search.example.com/searxng');
    assert.equal(state(b).webSearch.provider, 'off');
    assert.equal(state(b).webSearch.revision, 0);
    const own = updateConfig(b, { provider: 'off', results: 3 });
    assert.equal(own.revision, 1);
    assert.equal(state(a).webSearch.revision, 1);
});

test('a private SearXNG address needs an administrator, including mapped IPv6 and Docker aliases', t => {
    const a = account(t);
    for (const address of ['http://127.0.0.1:8080/', 'http://localhost:8080', 'http://[::]/', 'http://[::1]/',
        'http://[::ffff:127.0.0.1]:8080', 'http://[::ffff:7f00:1]:8080', 'http://host.docker.internal:8080',
        'http://gateway.docker.internal:8080']) {
        assert.equal(web.searxngAddressIsPrivate(address), true, address);
        assert.throws(() => updateConfig(a, { provider: 'searxng', searxngUrl: address }, { admin: false }),
            { code: 'SCRATCHPAD_WEB_SEARCH_PRIVATE', status: 403 }, address);
    }
    for (const address of ['https://example.com', 'https://example.com/searxng', 'https://8.8.8.8']) {
        assert.equal(web.searxngAddressIsPrivate(address), false, address);
    }
    assert.equal(web.isPrivateAddress('::ffff:8.8.8.8'), false);
    assert.equal(web.isPrivateAddress('::ffff:7f00:1'), true);
    assert.equal(updateConfig(a, { provider: 'searxng', searxngUrl: 'https://8.8.8.8' }, { admin: false }).searxngUrl, 'https://8.8.8.8');
    const local = updateConfig(a, { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080/' }, { admin: true });
    assert.equal(local.searxngUrl, 'http://127.0.0.1:8080');
    assert.equal(state(a).readiness.configured, true);
    const saved = updateConfig(a, { provider: 'searxng', searxngUrl: 'http://[::ffff:127.0.0.1]:8080/' }, { admin: true });
    assert.equal(saved.searxngUrl, 'http://[::ffff:7f00:1]:8080');
    assert.equal(state(a).readiness.configured, true);
    updateConfig(a, { provider: 'searxng', searxngUrl: '' });
    assert.equal(state(a).readiness.missing, 'searxng-url');
});

test('Brave and NanoGPT need their saved keys before a reply can be planned', t => {
    const a = account(t);
    updateConfig(a, { provider: 'brave' });
    assert.equal(state(a).readiness.missing, 'brave-key');
    assert.throws(() => web.planWebSearch(a.directories, state(a).webSearch, 'A question'),
        { code: 'SCRATCHPAD_WEB_SEARCH_UNCONFIGURED' });
    braveKey(a);
    assert.equal(state(a).readiness.configured, true);
    updateConfig(a, { provider: 'nanogpt' });
    assert.equal(state(a).readiness.missing, 'nanogpt-key');
    writeSecret(a.directories, SECRET_KEYS.NANOGPT, 'nano-secret-value');
    assert.equal(state(a).readiness.configured, true);
});

test('the prepared plan snapshots the selected key id, never the key value, and keeps the Brave limit', t => {
    const a = account(t);
    const first = braveKey(a, 'first-secret');
    const second = writeSecret(a.directories, SECRET_KEYS.BRAVE_SEARCH, 'second-secret');
    new SecretManager(a.directories).rotateSecret(SECRET_KEYS.BRAVE_SEARCH, first);
    updateConfig(a, { provider: 'brave', results: 4 });
    const plan = web.planWebSearch(a.directories, state(a).webSearch, `  What   is\n${'x'.repeat(500)}  `);
    assert.equal(plan.keyId, first);
    assert.equal(plan.query.length, 400);
    assert.ok(plan.query.startsWith('What is x'));
    assert.ok(!JSON.stringify(plan).includes('first-secret'));
    assert.ok(!JSON.stringify(plan).includes('second-secret'));

    let captured;
    return web.performWebSearch(plan, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ web: { results: [{ title: 'One', url: 'https://example.com/one', description: 'Snippet' }] } });
        },
    }).then(result => {
        assert.equal(captured.options.headers['X-Subscription-Token'], 'first-secret', 'the snapshotted key is used even after rotation');
        assert.equal(result.results[0].url, 'https://example.com/one');
        assert.equal(second, new SecretManager(a.directories).getSecretState()[SECRET_KEYS.BRAVE_SEARCH].find(secret => !secret.active).id);
    });
});

test('Brave requests use the documented endpoint, count and subscription header', async t => {
    const a = account(t);
    braveKey(a, 'brave-secret');
    updateConfig(a, { provider: 'brave', results: 7 });
    const plan = web.planWebSearch(a.directories, state(a).webSearch, 'Latest Nova news');
    let captured;
    const result = await web.performWebSearch(plan, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ web: { results: [
                { title: '<b>Nova &amp; friends</b>', url: 'https://example.com/one#part', description: '<p>First &amp; best</p>' },
                { title: 'Duplicate', url: 'https://example.com/one', description: 'Same address' },
                { title: 'Credentialed', url: 'https://user:pass@example.com/two', description: 'Rejected' },
                { title: 'Script', url: 'javascript:alert(1)', description: 'Rejected' },
                { title: 'Two', url: 'https://example.com/two', description: 'Second' },
            ] } });
        },
    });
    const url = new URL(captured.url);
    assert.equal(url.origin, 'https://api.search.brave.com');
    assert.equal(url.pathname, '/res/v1/web/search');
    assert.equal(url.searchParams.get('q'), 'Latest Nova news');
    assert.equal(url.searchParams.get('count'), '7');
    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers['X-Subscription-Token'], 'brave-secret');
    assert.deepEqual(result.results.map(item => item.url), ['https://example.com/one', 'https://example.com/two']);
    assert.equal(result.results[0].title, 'Nova & friends');
    assert.equal(result.results[0].snippet, 'First & best');
});

test('SearXNG keeps its base path and NanoGPT sends the Linkup standard request', async t => {
    const a = account(t);
    updateConfig(a, { provider: 'searxng', searxngUrl: 'https://search.example.com/team/searxng/' });
    const searx = web.planWebSearch(a.directories, state(a).webSearch, 'Search me');
    let captured;
    const searxResult = await web.performWebSearch(searx, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ results: [{ title: 'One', url: 'https://example.com/one', content: 'Body' }] });
        },
    });
    const searxUrl = new URL(captured.url);
    assert.equal(searxUrl.pathname, '/team/searxng/search');
    assert.equal(searxUrl.searchParams.get('q'), 'Search me');
    assert.equal(searxUrl.searchParams.get('format'), 'json');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(searxResult.results[0].snippet, 'Body');

    writeSecret(a.directories, SECRET_KEYS.NANOGPT, 'nano-secret');
    updateConfig(a, { provider: 'nanogpt', results: 3 });
    const nano = web.planWebSearch(a.directories, state(a).webSearch, 'Nano question');
    const nanoResult = await web.performWebSearch(nano, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ data: [{ name: 'Nano result', url: 'https://example.com/nano', content: 'Nano body' }],
                metadata: { provider: 'linkup', depth: 'standard' } });
        },
    });
    assert.equal(captured.url, 'https://api.nano-gpt.com/api/web');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers.Authorization, 'Bearer nano-secret');
    assert.deepEqual(JSON.parse(captured.options.body), {
        query: 'Nano question', provider: 'linkup', depth: 'standard', outputType: 'searchResults',
    });
    assert.equal(nanoResult.results[0].title, 'Nano result');
});

test('Exa and Tavily need their saved keys and send the documented requests', async t => {
    const a = account(t);
    updateConfig(a, { provider: 'exa', results: 6 });
    assert.equal(state(a).readiness.missing, 'exa-key');
    assert.equal(web.webSearchReadiness(a.directories, state(a).webSearch).message, 'Add an Exa API key in Context.');
    assert.throws(() => web.planWebSearch(a.directories, state(a).webSearch, 'A question'),
        { code: 'SCRATCHPAD_WEB_SEARCH_UNCONFIGURED' });
    writeSecret(a.directories, SECRET_KEYS.EXA, 'exa-secret');
    assert.equal(state(a).readiness.configured, true);
    const exa = web.planWebSearch(a.directories, state(a).webSearch, 'Exa question');
    assert.ok(!JSON.stringify(exa).includes('exa-secret'));
    let captured;
    const exaResult = await web.performWebSearch(exa, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ requestId: 'r1', results: [
                { title: 'Exa one', url: 'https://example.com/exa', highlights: ['First highlight.', 'Second highlight.'] },
                { title: 'Exa two', url: 'https://example.com/exa-two', text: 'Plain text body' },
            ] });
        },
    });
    assert.equal(captured.url, 'https://api.exa.ai/search');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers['x-api-key'], 'exa-secret');
    const exaBody = JSON.parse(captured.options.body);
    assert.equal(exaBody.query, 'Exa question');
    assert.equal(exaBody.numResults, 6);
    assert.equal(exaBody.type, 'auto');
    assert.ok(exaBody.contents.highlights.maxCharacters > 0);
    assert.deepEqual(exaResult.results.map(item => item.url), ['https://example.com/exa', 'https://example.com/exa-two']);
    assert.match(exaResult.results[0].snippet, /First highlight\. Second highlight\./);
    assert.equal(exaResult.results[1].snippet, 'Plain text body');

    updateConfig(a, { provider: 'tavily', results: 4 });
    assert.equal(state(a).readiness.missing, 'tavily-key');
    writeSecret(a.directories, SECRET_KEYS.TAVILY, 'tvly-secret');
    assert.equal(state(a).readiness.configured, true);
    const tavily = web.planWebSearch(a.directories, state(a).webSearch, 'Tavily question');
    const tavilyResult = await web.performWebSearch(tavily, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ query: 'Tavily question', results: [
                { title: 'Tavily one', url: 'https://example.com/tavily', content: 'Tavily body', score: 0.9 },
            ] });
        },
    });
    assert.equal(captured.url, 'https://api.tavily.com/search');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers.Authorization, 'Bearer tvly-secret');
    assert.deepEqual(JSON.parse(captured.options.body), { query: 'Tavily question', max_results: 4, search_depth: 'basic' });
    assert.equal(tavilyResult.results[0].title, 'Tavily one');
    assert.equal(tavilyResult.results[0].snippet, 'Tavily body');

    for (const [status, pattern] of [[401, /Tavily rejected the API key/], [432, /Tavily usage limit/], [433, /Tavily usage limit/]]) {
        await assert.rejects(web.performWebSearch(tavily, { directories: a.directories, fetch: async () => response('{}', status) }), pattern);
    }
    await assert.rejects(web.performWebSearch(exa, { directories: a.directories, fetch: async () => response('{}', 402) }),
        /Exa has no credit left/);
});

test('a custom address needs {query}, a plain web address and an administrator for private hosts', t => {
    const a = account(t);
    for (const [value, pattern] of [
        ['https://search.example.com/api', /\{query\}/],
        ['search.example.com/api?q={query}', /http:\/\/ or https:\/\//],
        ['ftp://search.example.com/?q={query}', /http:\/\/ or https:\/\//],
        ['https://user:pass@search.example.com/?q={query}', /sign-in details/],
        ['https://search.example.com/?q={query}#top', /fragment/],
        ['https://{query}.example.com/', /after the host name/],
    ]) {
        assert.throws(() => updateConfig(a, { provider: 'custom', customUrl: value }), error => {
            assert.equal(error.code, 'SCRATCHPAD_WEB_SEARCH_URL', value);
            assert.match(error.message, pattern, value);
            return true;
        });
    }
    assert.throws(() => updateConfig(a, { provider: 'custom', customUrl: 'http://127.0.0.1:9000/?q={query}' }, { admin: false }),
        { code: 'SCRATCHPAD_WEB_SEARCH_PRIVATE', status: 403 });
    assert.equal(updateConfig(a, { provider: 'custom', customUrl: 'http://127.0.0.1:9000/?q={query}' }, { admin: true }).customUrl,
        'http://127.0.0.1:9000/?q={query}');
    for (const header of ['X API Key', 'Cookie', 'host', 'x'.repeat(65)]) {
        assert.throws(() => updateConfig(a, { provider: 'custom', customHeader: header }), { code: 'SCRATCHPAD_WEB_SEARCH_HEADER' }, header);
    }
    assert.equal(updateConfig(a, { provider: 'custom', customHeader: ' X-API-Key ' }).customHeader, 'X-API-Key');
    updateConfig(a, { provider: 'custom', customUrl: '' });
    assert.equal(state(a).readiness.missing, 'custom-url');
    assert.throws(() => web.planWebSearch(a.directories, state(a).webSearch, 'A question'),
        { code: 'SCRATCHPAD_WEB_SEARCH_UNCONFIGURED' });
});

test('a custom address works without a key and sends a saved key in the chosen header', async t => {
    const a = account(t);
    updateConfig(a, { provider: 'custom', customUrl: 'https://search.example.com/v1/find?q={query}&limit={count}', results: 3 });
    assert.equal(state(a).readiness.configured, true, 'a custom address without a key is ready');
    const keyless = web.planWebSearch(a.directories, state(a).webSearch, 'Nova & friends?');
    let captured;
    const result = await web.performWebSearch(keyless, {
        directories: a.directories,
        fetch: async (url, options) => {
            captured = { url, options };
            return response({ hits: { items: [{ name: 'Custom one', link: 'https://example.com/custom', snippet: 'Custom body' }] } });
        },
    });
    const url = new URL(captured.url);
    assert.equal(url.origin, 'https://search.example.com');
    assert.equal(url.pathname, '/v1/find');
    assert.equal(url.searchParams.get('q'), 'Nova & friends?');
    assert.equal(url.searchParams.get('limit'), '3');
    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.equal(result.results[0].url, 'https://example.com/custom');
    assert.equal(result.results[0].title, 'Custom one');

    writeSecret(a.directories, SECRET_KEYS.CUSTOM_SEARCH, 'custom-secret');
    const bearer = web.planWebSearch(a.directories, state(a).webSearch, 'With a key');
    assert.ok(!JSON.stringify(bearer).includes('custom-secret'));
    await web.performWebSearch(bearer, { directories: a.directories, fetch: async (target, options) => {
        captured = { url: target, options };
        return response({ results: [] });
    } });
    assert.equal(captured.options.headers.Authorization, 'Bearer custom-secret');

    updateConfig(a, { provider: 'custom', customHeader: 'X-API-Key' });
    const raw = web.planWebSearch(a.directories, state(a).webSearch, 'Raw key');
    await web.performWebSearch(raw, { directories: a.directories, fetch: async (target, options) => {
        captured = { url: target, options };
        return response({ results: [] });
    } });
    assert.equal(captured.options.headers['X-API-Key'], 'custom-secret');
    assert.equal(captured.options.headers.Authorization, undefined);

    await assert.rejects(web.performWebSearch(raw, { directories: a.directories, fetch: async () => {
        const html = response('<html><body>Search</body></html>');
        html.headers.set('content-type', 'text/html');
        return html;
    } }), /web page instead of JSON/);
    await assert.rejects(web.performWebSearch(raw, { directories: a.directories, fetch: async () => response('{}', 401) }),
        /custom search service rejected the API key/i);
});

test('settings saved before the custom provider existed still load', t => {
    const a = account(t);
    updateConfig(a, { provider: 'searxng', searxngUrl: 'https://search.example.com' });
    const file = path.join(a.directories.root, 'scratchpad', 'web-search.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete stored.customUrl;
    delete stored.customHeader;
    fs.writeFileSync(file, JSON.stringify(stored));
    const loaded = state(a).webSearch;
    assert.equal(loaded.provider, 'searxng');
    assert.equal(loaded.customUrl, '');
    assert.equal(loaded.customHeader, '');
});

test('search errors, timeouts, cancellation and oversized responses are bounded', async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave', results: 5 });
    const plan = web.planWebSearch(a.directories, state(a).webSearch, 'Check errors');
    for (const [status, definite] of [[401, true], [429, true], [503, true], [504, false]]) {
        await assert.rejects(web.performWebSearch(plan, { directories: a.directories, fetch: async () => response('{}', status) }), error => {
            assert.equal(error.providerStatus, status);
            assert.equal(error.definite, definite);
            assert.match(error.message, status === 401 ? /API key/ : status === 429 ? /rate limit|HTTP 429/i : /unavailable|HTTP 503|HTTP 504/i);
            return true;
        });
    }
    writeSecret(a.directories, SECRET_KEYS.NANOGPT, 'nano-secret');
    updateConfig(a, { provider: 'nanogpt' });
    const nano = web.planWebSearch(a.directories, state(a).webSearch, 'Check balance');
    await assert.rejects(web.performWebSearch(nano, { directories: a.directories, fetch: async () => response('{}', 402) }),
        /no credit/);
    updateConfig(a, { provider: 'searxng', searxngUrl: 'https://search.example.com' });
    const searx = web.planWebSearch(a.directories, state(a).webSearch, 'Check JSON');
    await assert.rejects(web.performWebSearch(searx, { directories: a.directories, fetch: async () => response('{}', 403) }),
        /JSON output/);
    await assert.rejects(web.performWebSearch(searx, { directories: a.directories, fetch: async () => {
        const html = response('<html><body>Search</body></html>');
        html.headers.set('content-type', 'text/html; charset=utf-8');
        return html;
    } }), /JSON output/);

    updateConfig(a, { provider: 'brave' });
    braveKey(a);
    const brave = web.planWebSearch(a.directories, state(a).webSearch, 'Slow search');
    await assert.rejects(web.performWebSearch(brave, {
        directories: a.directories, timeoutMs: 10,
        fetch: (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    }), { code: 'SCRATCHPAD_WEB_SEARCH_TIMEOUT' });

    const stalled = () => ({ ok: true, status: 200, headers: new Headers(),
        body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } } });
    await assert.rejects(web.performWebSearch(brave, {
        directories: a.directories, timeoutMs: 15, fetch: async () => stalled(),
    }), error => error.code === 'SCRATCHPAD_WEB_SEARCH_TIMEOUT' && error.message === 'The web search timed out after 20 seconds.');

    const bodyController = new AbortController();
    const bodyCancel = web.performWebSearch(brave, {
        directories: a.directories, timeoutMs: 5000, signal: bodyController.signal, fetch: async () => stalled(),
    });
    setTimeout(() => bodyController.abort(), 10);
    await assert.rejects(bodyCancel, error => error.name === 'AbortError');

    const controller = new AbortController();
    const cancel = web.performWebSearch(brave, {
        directories: a.directories, signal: controller.signal,
        fetch: (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(cancel, error => error.name === 'AbortError');

    await assert.rejects(web.performWebSearch(brave, {
        directories: a.directories,
        fetch: async () => streamedResponse([Buffer.alloc(web.MAX_WEB_SEARCH_RESPONSE_BYTES + 1)]),
    }), { code: 'SCRATCHPAD_WEB_SEARCH_TOO_LARGE' });
});

test('provider results are capped, de-duplicated and stripped to plain text', () => {
    const items = Array.from({ length: 14 }, (_, index) => ({
        title: `<b>Title ${index}</b> &amp; more`, url: `https://example.com/${index}`, description: `<i>${'x'.repeat(900)}</i>`,
    }));
    items.push({ title: 'Duplicate', url: 'https://example.com/0', description: 'duplicate' });
    items.push({ title: 'Bad', url: 'https://user:pass@example.com/bad', description: 'credentials' });
    const results = web.normaliseWebSearchResults(items, 50);
    assert.equal(results.length, 10);
    assert.equal(results[0].title, 'Title 0 & more');
    assert.ok(results[0].snippet.length <= 500);
    assert.ok(results.every((item, index, list) => list.findIndex(other => other.url === item.url) === index));
    assert.ok(results.every(item => item.url.startsWith('https://example.com/')));
});

test('a reply with Web on and no provider fails before a job is scheduled', async t => {
    const a = account(t);
    const session = startSession(a, { webSearch: true });
    registerScratchpadJobs({ generate: async () => ({ text: 'Should not run.' }) });
    await assert.rejects(acceptScratchpadReply(a.request(sendBody(session)), sendBody(session)), { code: 'SCRATCHPAD_WEB_SEARCH_UNCONFIGURED' });
    assert.equal(listJobs(a.directories, { owner: a.base.owner, includeDismissed: true }).length, 0);
});

test('a round table searches once, cites numbered sources and saves compact metadata only', async t => {
    const a = account(t);
    braveKey(a, 'round-table-secret');
    updateConfig(a, { provider: 'brave', results: 2 });
    const session = startSession(a, { webSearch: true, roundTable: true });
    let searchCalls = 0;
    const seen = [];
    const searchFetch = async () => {
        searchCalls += 1;
        return response({ web: { results: [
            { title: '<b>One</b>', url: 'https://example.com/one', description: 'FULL-SNIPPET-ONE' },
            { title: 'Two', url: 'https://example.com/two', description: 'FULL-SNIPPET-TWO' },
        ] } });
    };
    registerScratchpadJobs({ searchFetch, generate: async options => {
        seen.push(options);
        return { text: `${options.characterName} says [1].` };
    } });
    const body = sendBody(session, { text: '  What   is\nNova hiding?  ' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const request = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(request.replies[0].webSearch.query, 'What is Nova hiding?');
    assert.equal(request.replies[0].webSearch.keyId, request.replies[1].webSearch.keyId);
    assert.ok(!JSON.stringify(request).includes('round-table-secret'));
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(searchCalls, 1, 'one shared search for the whole round table');
    assert.equal(seen.length, 3);
    for (const options of seen) {
        const searchIndex = options.messages.findIndex(message => message.content.startsWith('<web_search_results>'));
        assert.ok(searchIndex > 0);
        assert.match(options.messages[searchIndex].content, /\[1\] One/);
        assert.match(options.messages[searchIndex].content, /\[2\] Two/);
        assert.match(options.messages[searchIndex + 1].content, /untrusted evidence/);
        assert.equal(options.messages.at(-1).content, '  What   is\nNova hiding?  ');
        assert.match(options.macroEnvironment.evaluate(options.messages[searchIndex].content), /\[1\] One/);
    }
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(reply.state, 'done');
    assert.deepEqual(reply.webSearch.sources, [
        { title: 'One', url: 'https://example.com/one' },
        { title: 'Two', url: 'https://example.com/two' },
    ]);
    assert.equal(reply.webSearch.query, 'What is Nova hiding?');
    assert.equal(reply.webSearch.provider, 'brave');
    assert.ok(!JSON.stringify(reply.webSearch).includes('FULL-SNIPPET'), 'snippets stay out of reply metadata');
    assert.ok(!JSON.stringify(a.read(SOURCE)).includes('round-table-secret'));
    const artifact = readArtifact(a.directories, accepted.job.id, 'web-search');
    assert.equal(artifact.results.length, 2);
    assert.ok(!JSON.stringify(artifact).includes('round-table-secret'));
    assert.ok(readArtifact(a.directories, accepted.job.id, 'provider:web-search'));
});

test('retrying a reply searches the original user message again', async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave' });
    const session = startSession(a, { webSearch: true });
    const queries = [];
    registerScratchpadJobs({
        searchFetch: async url => {
            queries.push(new URL(url).searchParams.get('q'));
            return response({ web: { results: [{ title: 'One', url: 'https://example.com/one', description: 'Snippet' }] } });
        },
        generate: async () => ({ text: 'An answer.' }),
    });
    const body = sendBody(session, { text: 'An older question' });
    const first = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, first.job.id));
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    const retryBody = sendBody(session, { text: undefined, regenerate: reply.id });
    const retry = await acceptScratchpadReply(a.request(retryBody), retryBody);
    const request = readArtifact(a.directories, retry.job.id, 'request');
    assert.equal(request.webSearch.query, 'An older question');
    await runJob(getJob(a.directories, retry.job.id));
    assert.deepEqual(queries, ['An older question', 'An older question']);
});

function modelStepGenerate(text = 'The model answered without web results.') {
    return options => providerStep(options.jobContext, `model:${options.stepNamespace || 'single'}`, async () => ({ text }));
}

for (const [label, searchFetch] of [
    ['network failure', async () => { throw new Error('network down'); }],
    ['server error', async () => response('{}', 500)],
    ['invalid JSON', async () => response('{invalid JSON')],
    ['oversized body', async () => streamedResponse([Buffer.alloc(web.MAX_WEB_SEARCH_RESPONSE_BYTES + 1)])],
]) {
    test(`a recorded search failure lets the real provider step run after ${label}`, async t => {
        const a = account(t);
        braveKey(a);
        updateConfig(a, { provider: 'brave' });
        const session = startSession(a, { webSearch: true });
        registerScratchpadJobs({ searchFetch, generate: modelStepGenerate() });
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        assert.equal(a.read(SOURCE).sessions[0].messages.at(-1).text, 'The model answered without web results.');
        const failure = readArtifact(a.directories, accepted.job.id, 'web-search');
        assert.equal(failure.ok, false);
        assert.ok(readArtifact(a.directories, accepted.job.id, 'provider:web-search'));
        assert.equal(unresolvedProviderStep(a.directories, accepted.job.id), undefined);
    });
}

test('a crash before the search result is recorded still refuses replay and the model step', async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave' });
    const session = startSession(a, { webSearch: true });
    let searches = 0;
    let generated = 0;
    registerScratchpadJobs({ searchFetch: async () => { searches += 1; throw new Error('must not search'); },
        generate: async () => { generated += 1; return { text: 'must not answer' }; } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const context = { directories: a.directories, owner: a.base.owner, job: getJob(a.directories, accepted.job.id),
        signal: new AbortController().signal };
    const scoped = { ...context, providerScope: createProviderScope(context) };
    await assert.rejects(providerStep(scoped, 'web-search', async () => { throw new Error('connection lost'); }), /connection lost/);
    await assert.rejects(jobs.runScratchpadReply({ directories: a.directories, job: getJob(a.directories, accepted.job.id),
        signal: new AbortController().signal }, {
        searchFetch: async () => { searches += 1; throw new Error('must not search'); },
        generate: async () => { generated += 1; return { text: 'must not answer' }; },
    }), { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    assert.equal(searches, 0);
    assert.equal(generated, 0);
});

test('a failed search still produces an honest reply and a visible failure record', async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave' });
    const session = startSession(a, { webSearch: true });
    let seen;
    registerScratchpadJobs({
        searchFetch: async () => response('{}', 429),
        generate: async options => { seen = options; return { text: 'I could not search, so here is what I know.' }; },
    });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.match(seen.messages.find(message => message.content.startsWith('<web_search_results>')).content, /web search failed/i);
    assert.match(seen.messages.find(message => message.content.startsWith('No web search results') || message.content.startsWith('The web search returned'))?.content || '', /failed|no usable/i);
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(reply.state, 'done');
    assert.match(reply.webSearch.error, /rate limit/i);
    assert.deepEqual(reply.webSearch.sources, []);
});

test('a saved search failure is reused and never re-sent on later execution', async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave' });
    const session = startSession(a, { webSearch: true });
    registerScratchpadJobs({ generate: async () => ({ text: 'Not used.' }) });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const context = { directories: a.directories, owner: a.base.owner, job: getJob(a.directories, accepted.job.id), signal: new AbortController().signal };
    const scoped = { ...context, providerScope: createProviderScope(context) };
    const request = readArtifact(a.directories, accepted.job.id, 'request');
    let searches = 0;
    const failed = await jobs.resolveWebSearch(scoped, request, {
        searchFetch: async () => { searches += 1; throw new Error('network down'); },
    });
    assert.equal(searches, 1);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /could not be reached|completed/i);
    assert.ok(readArtifact(a.directories, accepted.job.id, 'provider:web-search'));
    assert.notEqual(getJob(a.directories, accepted.job.id).recoverability, 'unknown-outcome');
    const reused = await jobs.resolveWebSearch(scoped, request, {
        searchFetch: async () => { searches += 1; throw new Error('must not search again'); },
    });
    assert.equal(searches, 1, 'the saved failure prevents an automatic paid retry');
    assert.deepEqual(reused, failed);
});

test('stopping during the search aborts the reply before the model runs', { timeout: 10000 }, async t => {
    const a = account(t);
    braveKey(a);
    updateConfig(a, { provider: 'brave' });
    const session = startSession(a, { webSearch: true });
    const started = Promise.withResolvers();
    let generated = 0;
    registerScratchpadJobs({
        searchFetch: (url, { signal }) => new Promise((resolve, reject) => {
            started.resolve();
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
        generate: async () => { generated += 1; return { text: 'Must not appear.' }; },
    });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const running = runJob(getJob(a.directories, accepted.job.id));
    await started.promise;
    requestCancellation(a.directories, accepted.job.id, { reason: 'stop' });
    abortJob(accepted.job.id);
    await running;
    assert.equal(generated, 0, 'cancellation stops before the model');
    assert.equal(getJob(a.directories, accepted.job.id).state, 'cancelled');
});

test('custom assistant prompts still receive failure honesty rules and reply history keeps bounded sources', () => {
    const prompt = buildScratchpadSystemPrompt({ assistant: 'miso', userName: 'Kris', characterName: 'Nova',
        customPrompt: 'MY-CUSTOM-VOICE', webSearch: true }).text;
    assert.ok(prompt.startsWith('MY-CUSTOM-VOICE'));
    assert.match(prompt, /search failed/i);
    assert.match(prompt, /never pretend the search worked/i);
    const line = web.webSearchHistoryLine({ provider: 'brave', query: 'A query', sources: [
        { title: 'One', url: 'https://example.com/one' }, { title: 'Bad', url: 'javascript:alert(1)' },
    ] });
    assert.match(line, /\[1\] One - https:\/\/example\.com\/one/);
    assert.doesNotMatch(line, /javascript:/);
});

test('stored metadata is internal-only and imported metadata is never trusted evidence', () => {
    const input = { role: 'assistant', text: 'Answer.', webSearch: { provider: 'brave', query: 'A query',
        sources: [{ title: 'One', url: 'https://example.com/one' }, { title: 'Bad', url: 'https://user:pass@example.com/two' }],
        error: 'Search failed.' } };
    assert.equal(store.testExports.normaliseMessage(input, { allowInternalKeys: false }).webSearch, undefined);
    const stored = store.testExports.normaliseMessage(input, { allowInternalKeys: true }).webSearch;
    assert.deepEqual(stored, { provider: 'brave', query: 'A query', sources: [{ title: 'One', url: 'https://example.com/one' }], error: 'Search failed.' });
    assert.equal(web.normaliseStoredWebSearch({ provider: 'unknown', query: 'x', sources: [] }), undefined);
    assert.deepEqual(web.normaliseStoredWebSearch({ provider: 'off', query: 'x', sources: [] }), undefined);
});
