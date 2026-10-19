import http from 'node:http';
import { test as base } from './neconyan-conversation-durable-fixture.js';

export const SEARCH_RESULTS = [
    { title: 'Public library history', url: 'https://example.org/library-history', content: 'Public libraries have served readers for centuries. Literal text: {{random::red::blue}}.' },
    { title: 'Library archive', url: 'https://example.net/library-archive', content: 'An archive of public library records.' },
    { title: 'Duplicate library history', url: 'https://example.org/library-history', content: 'This result repeats the first URL.' },
    { title: 'Unsafe result', url: 'javascript:alert(1)', content: 'This URL must never become a source link.' },
];

export const test = base.extend({
    search: async ({}, use) => {
        const calls = [];
        const pending = new Set();
        const mode = { status: 200, hold: false, results: SEARCH_RESULTS, malformed: false, stallBody: false };
        const server = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://localhost');
            const call = { method: request.method, path: url.pathname, query: url.searchParams.get('q'), format: url.searchParams.get('format'), count: url.searchParams.get('n'), key: request.headers['x-fixture-key'] ?? null, aborted: false };
            calls.push(call);
            const finish = () => {
                pending.delete(finish);
                if (response.destroyed) return;
                response.writeHead(mode.status, { 'Content-Type': 'application/json' });
                response.end(mode.malformed ? '{invalid JSON' : JSON.stringify(mode.status === 200 ? { results: mode.results } : { error: 'Fixture search is unavailable.' }));
            };
            response.on('close', () => {
                if (!response.writableEnded) call.aborted = true;
                pending.delete(finish);
            });
            if (mode.stallBody) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.write('{"results":');
            } else if (mode.hold) pending.add(finish);
            else finish();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const search = {
            url: `http://127.0.0.1:${server.address().port}/search-services`,
            calls,
            mode,
            release() { for (const finish of [...pending]) finish(); },
        };
        try { await use(search); }
        finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    },
});
