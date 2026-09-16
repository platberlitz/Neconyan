import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('the service worker never serves cached documents or stores sign-in responses', async () => {
    const listeners = {};
    const context = vm.createContext({
        URL,
        self: { location: { origin: 'https://example.test' }, addEventListener: (name, handler) => { listeners[name] = handler; } },
    });
    vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
    for (const pathname of ['/', '/login', '/login.html', '/index.html', '/settings']) {
        listeners.fetch({
            request: { method: 'GET', mode: 'navigate', url: `https://example.test${pathname}` },
            respondWith: () => assert.fail('Document navigation must reach the server'),
        });
    }
    const stored = [];
    const cache = { put: async (request, response) => stored.push([request, response]) };
    const response = { ok: true, type: 'basic', redirected: false, headers: { get: () => '' }, clone: () => 'asset' };
    await context.putCache(cache, 'redirect', { ...response, redirected: true });
    await context.putCache(cache, 'private', { ...response, headers: { get: () => 'private, no-store' } });
    await context.putCache(cache, 'unauthorised', { ...response, ok: false });
    await context.putCache(cache, 'stylesheet', response);
    assert.deepEqual(stored, [['stylesheet', 'asset']]);
});
