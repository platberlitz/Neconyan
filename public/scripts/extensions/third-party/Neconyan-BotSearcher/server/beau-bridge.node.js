import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startBeauBridge } from './beau-bridge.js';
import { createJannyBrowser } from './janny-browser.js';

test('Popular uses the existing serialised Janitor browser and a private fixed route', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beau-janitor-'));
    const socketPath = path.join(directory, 'popular.sock');
    let launches = 0;
    let reads = 0;
    const requests = [];
    const payload = { data: [{ id: '6dd3bdec-8aa2-463b-a592-dc31d078708a', name: 'Example' }] };
    const page = {
        url: () => 'https://janitorai.com/characters/example',
        setDefaultTimeout() {},
        async goto(url) { assert.equal(url, 'https://janitorai.com'); },
        async waitForFunction() {},
        async evaluate(_operation, args) {
            reads++;
            const target = new URL(args.target);
            assert.equal(target.origin + target.pathname, 'https://janitorai.com/hampter/characters');
            requests.push(Object.fromEntries(target.searchParams));
            assert.deepEqual(args.request, {});
            return { status: 200, body: JSON.stringify(payload) };
        },
    };
    const browser = createJannyBrowser({ profileDir: directory, launchContext: async () => {
        launches++;
        return { pages: () => [page], on() {}, async close() {} };
    } });
    let bridge;
    const get = (url = '/popular', method = 'GET') => new Promise((resolve, reject) => {
        const request = http.request({ socketPath, path: url, method }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
        });
        request.on('error', reject);
        request.end();
    });
    try {
        assert.equal(await startBeauBridge(browser, ''), null);
        bridge = await startBeauBridge(browser, socketPath);
        assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
        assert.deepEqual((await get()).data, payload);
        assert.equal((await get()).status, 200);
        assert.equal(launches, 1);
        assert.equal(reads, 2);
        assert.match((await get('/filters')).data.sections.trending24, /24 hours/);
        for (const section of ['popular', 'trending24', 'trending', 'latest']) {
            assert.equal((await get(`/characters?section=${section}&mode=sfw`)).status, 200);
            const query = requests.at(-1);
            assert.equal(query.mode, 'sfw');
            assert.equal(query[section.startsWith('trending') ? 'special_mode' : 'sort'], section);
            assert.equal(query[section.startsWith('trending') ? 'sort' : 'special_mode'], undefined);
        }
        for (const query of ['section=following', 'mode=private', 'section=popular&section=trending', 'url=https://example.com']) {
            assert.equal((await get('/characters?' + query)).status, 400);
        }
        assert.equal((await get('/filters?url=https://example.com')).status, 404);
        assert.equal((await get('/popular?url=https://example.com')).status, 404);
        assert.equal((await get('/popular', 'POST')).status, 404);
        await assert.rejects(startBeauBridge(browser, socketPath), /already active/);
        assert.equal(reads, 6);
        await assert.rejects(browser.frontpage('favorites'), /Unsupported/);
    } finally {
        await bridge?.close();
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
