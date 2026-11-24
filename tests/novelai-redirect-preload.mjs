import http from 'node:http';
import https from 'node:https';

// Test-only server preload: sends the app server's HTTPS calls to the fixed NovelAI hosts to a local mock,
// so the real NovelAI route and the real forwarding code run against a backend the test controls.
const mock = process.env.NECONYAN_TEST_NOVELAI_MOCK;
const hosts = new Set(['api.novelai.net', 'text.novelai.net']);

if (mock) {
    const target = new URL(mock);
    const original = https.request;
    https.request = function (first, ...rest) {
        const url = typeof first === 'string' || first instanceof URL ? new URL(String(first)) : null;
        if (!url || !hosts.has(url.hostname)) return original.call(this, first, ...rest);
        const options = rest.find(item => item && typeof item === 'object' && typeof item !== 'function') ?? {};
        const callback = rest.find(item => typeof item === 'function');
        const headers = { ...options.headers, host: url.host };
        return http.request({
            host: target.hostname, port: target.port, path: target.pathname.replace(/\/$/, '') + url.pathname + url.search,
            method: options.method, headers, signal: options.signal,
        }, callback);
    };
}
