import { afterAll, beforeAll, expect, test } from '@jest/globals';
import express from 'express';
import { router } from '../src/endpoints/chat-archive.js';

let server;
let baseUrl;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chats/archive', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));

test('expired browser inventory and read tokens cannot start or release new archive work', async () => {
    for (const [method, route] of [['POST', 'inventory'], ['POST', 'release'], ['GET', 'view?token=old&hash=old']]) {
        const response = await fetch(`${baseUrl}/api/chats/archive/${route}`, { method,
            ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'archive', token: 'old' }) } : {}) });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'NATIVE_OPERATION_REQUIRED' });
    }
});
