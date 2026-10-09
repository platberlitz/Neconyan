import { test, expect } from '@playwright/test';
import http from 'node:http';
import { openWorkspace } from './notebooks-browser-fixture.js';

let server;
let baseURL;
let slowReadArrived;

test.beforeAll(async () => {
    server = http.createServer((request, response) => {
        if (request.url === '/api/settings/get') {
            const delay = request.headers['x-slow'] ? 1500 : 0;
            if (delay) slowReadArrived();
            setTimeout(() => {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ settings: JSON.stringify({ firstRun: true, accountStorage: {} }) }));
            }, delay);
            return;
        }
        response.setHeader('content-type', 'text/html');
        response.end(`<!doctype html><body><script>
            fetch('/api/settings/get', { method: 'POST' }).then(r => r.json()).then(envelope => {
                document.body.dataset.firstRun = JSON.parse(envelope.settings).firstRun;
                const cat = document.createElement('div');
                cat.dataset.neconyanCat = '';
                cat.textContent = 'ready';
                document.body.append(cat);
            });
        </script></body>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => new Promise(resolve => server.close(resolve)));

test('closing the context during a background settings read does not fail the test', async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    try {
        const page = await context.newPage();
        await openWorkspace(page);
        await expect(page.locator('body')).toHaveAttribute('data-first-run', 'false');
        const arrived = new Promise(resolve => { slowReadArrived = resolve; });
        await page.evaluate(() => { void fetch('/api/settings/get', { method: 'POST', headers: { 'x-slow': '1' } }).catch(() => {}); });
        // The server has the read, so the helper's route.fetch is still waiting when the context closes.
        await arrived;
    } finally { await context.close(); }
});
