import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://example.test';

function makeResponse(body = 'asset') {
    const response = {
        body,
        ok: true,
        type: 'basic',
        redirected: false,
        headers: { get: () => '' },
        clone: () => response,
    };
    return response;
}

function loadWorker({ cache = new Map(), cacheNames = [], responseFor = () => makeResponse() } = {}) {
    const listeners = {};
    const fetched = [];
    const opened = [];
    const deleted = [];
    const context = vm.createContext({
        URL,
        console,
        self: {
            location: { origin: ORIGIN },
            addEventListener: (name, handler) => { listeners[name] = handler; },
            clients: { claim: async () => {} },
        },
        caches: {
            open: async (name) => {
                opened.push(name);
                return {
                    match: async request => cache.get(request.url || request),
                    put: async (request, response) => { cache.set(request.url || request, response); },
                };
            },
            keys: async () => cacheNames,
            delete: async name => { deleted.push(name); },
        },
        fetch: async (request) => {
            fetched.push(request.url || request);
            return responseFor(request);
        },
    });
    vm.runInContext(workerSource, context);
    return { listeners, context, fetched, opened, deleted, cache, cacheNames };
}

function requestFor(pathname, mode = 'same-origin') {
    return { method: 'GET', mode, url: `${ORIGIN}${pathname}` };
}

test('the service worker never serves cached documents or stores sign-in responses', async () => {
    const listeners = {};
    const context = vm.createContext({
        URL,
        self: { location: { origin: ORIGIN }, addEventListener: (name, handler) => { listeners[name] = handler; } },
    });
    vm.runInContext(workerSource, context);
    for (const pathname of ['/', '/login', '/login.html', '/index.html', '/settings',
        '/?chat=11111111-1111-4111-8111-111111111111&mode=roleplay',
        '/neconyan/?chat=22222222-2222-4222-8222-222222222222&mode=conversation', '/?view=home']) {
        listeners.fetch({
            request: requestFor(pathname, 'navigate'),
            respondWith: () => assert.fail('Document navigation must reach the server'),
        });
    }
    for (const action of ['state', 'resolve', 'establish', 'remember']) {
        listeners.fetch({
            request: requestFor(`/api/chat-navigation/${action}`, 'cors'),
            respondWith: () => assert.fail('Account navigation requests must never use a service-worker cache'),
        });
    }
    for (const mode of ['navigate', 'cors', 'same-origin']) {
        for (const pathname of ['/sandbox/card-script?v=2', '/sandbox/card-script/extra.js']) listeners.fetch({
            request: requestFor(pathname, mode),
            respondWith: () => assert.fail('Reserved sandbox responses must always reach the server'),
        });
    }
    const stored = [];
    const cache = { put: async (request, response) => stored.push([request, response]) };
    const response = { ok: true, type: 'basic', redirected: false, headers: { get: () => '' }, clone: () => 'asset' };
    await context.putCache(cache, 'redirect', { ...response, redirected: true });
    await context.putCache(cache, 'private', { ...response, headers: { get: () => 'private, no-store' } });
    await context.putCache(cache, 'unauthorised', { ...response, ok: false });
    await context.putCache(cache, 'cross-origin', { ...response, type: 'cors' });
    await context.putCache(cache, 'stylesheet', response);
    assert.deepEqual(stored, [['stylesheet', 'asset']]);
});

test('unhashed application scripts are left to the browser HTTP cache', () => {
    const worker = loadWorker();
    for (const pathname of [
        '/script.js',
        '/scripts/neconyan-tabs.js',
        '/scripts/extensions/in-chat-agents/index.js',
        '/scripts/extensions/third-party/Neconyan-Hopper/index.js',
        '/frontend-assets/scripts/unhashed.js',
        '/frontend-assets/scripts/unhashed.mjs',
    ]) {
        worker.listeners.fetch({
            request: requestFor(pathname),
            respondWith: () => assert.fail(`${pathname} must not be rewritten by the service worker`),
        });
    }
    assert.deepEqual(worker.fetched, []);
});

test('content-hashed frontend assets remain cache-first', async () => {
    const cached = makeResponse('cached');
    const url = `${ORIGIN}/frontend-assets/scripts/neconyan-tabs-abcdef12.js`;
    const worker = loadWorker({ cache: new Map([[url, cached]]) });
    let response;
    worker.listeners.fetch({
        request: requestFor('/frontend-assets/scripts/neconyan-tabs-abcdef12.js'),
        respondWith: promise => { response = promise; },
    });
    assert.equal(await response, cached);
    assert.deepEqual(worker.fetched, [], 'a hashed asset cache hit must not fetch or rewrite');
    assert.match(worker.opened[0], /-static$/);
});

test('library, stylesheet, image and font requests stay stale-while-revalidate', async () => {
    const worker = loadWorker();
    const paths = [
        '/lib/jquery-3.7.1.min.js',
        '/css/neconyan.css',
        '/img/neconyan-pixel-cat-running.webp',
        '/webfonts/Nunito/Nunito[wght].woff2',
    ];
    const responses = [];
    for (const pathname of paths) {
        worker.listeners.fetch({
            request: requestFor(pathname),
            respondWith: promise => responses.push(promise),
        });
    }
    const resolved = await Promise.all(responses);
    assert.equal(resolved.length, paths.length);
    assert.deepEqual(worker.fetched, paths.map(pathname => `${ORIGIN}${pathname}`));
});

test('a stale library response is served while its newer copy is fetched', async () => {
    const cached = makeResponse('cached library');
    const url = `${ORIGIN}/lib/jquery-3.7.1.min.js`;
    const worker = loadWorker({ cache: new Map([[url, cached]]) });
    let response;
    worker.listeners.fetch({
        request: requestFor('/lib/jquery-3.7.1.min.js'),
        respondWith: promise => { response = promise; },
    });
    assert.equal(await response, cached);
    assert.deepEqual(worker.fetched, [url]);
});

test('activation removes every older service-worker cache generation and keeps the current one', async () => {
    const worker = loadWorker({
        cache: new Map([[`${ORIGIN}/frontend-assets/scripts/neconyan-tabs-abcdef12.js`, makeResponse('cached')]]),
        cacheNames: [
            'neconyan-cache-v20261017e-image-review-static',
            'neconyan-cache-v20261017e-image-review-shell',
            'another-app-cache',
        ],
    });
    let response;
    worker.listeners.fetch({
        request: requestFor('/frontend-assets/scripts/neconyan-tabs-abcdef12.js'),
        respondWith: promise => { response = promise; },
    });
    await response;
    const current = worker.opened[0];
    assert.match(current, /-static$/);
    assert.notEqual(current, 'neconyan-cache-v20261017e-image-review-static');
    worker.cacheNames.push(current);
    let activation;
    worker.listeners.activate({ waitUntil: promise => { activation = promise; } });
    await activation;
    assert.deepEqual(worker.deleted, [
        'neconyan-cache-v20261017e-image-review-static',
        'neconyan-cache-v20261017e-image-review-shell',
    ]);
    assert.equal(worker.deleted.includes(current), false, 'the current static cache must be kept');
});
