import { afterAll, beforeAll, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/in-chat-agents.js');
let server;
let root;
let baseUrl;

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-agent-setups-'));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const profile = request.header('test-profile') === 'two' ? 'two' : 'one';
        request.user = { profile: { handle: profile }, directories: { inChatAgents: path.join(root, profile) } };
        next();
    });
    app.use(router);
    await new Promise((resolve, reject) => {
        server = app.listen(0, '127.0.0.1', resolve);
        server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

function post(route, data, profile = 'one') {
    return fetch(baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'test-profile': profile }, body: JSON.stringify(data) });
}

const setup = {
    id: 'scene', name: 'Scene', version: 1, metadata: { keep: ['custom'] },
    agents: [{ id: 'agent-a', name: 'A', settings: { apiKey: 'test-only', secretId: 'credential-reference' }, schema: { properties: { password: { type: 'string' } } } }],
    globalSettings: { enabled: false, connectionProfile: 'profile-reference', enabledAgentIdsByChatType: { individual: ['agent-a'], group: [] } },
};

test('real preset files round trip and remain isolated by profile; deleting a setup leaves agents intact', async () => {
    expect((await post('/presets/save', setup)).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'one/presets/scene.json'), 'utf8'))).toEqual(setup);
    expect(await (await post('/presets/list', {})).json()).toEqual([setup]);
    expect(await (await post('/presets/list', {}, 'two')).json()).toEqual([]);
    expect((await post('/presets/save', { ...setup, name: 'Other profile' }, 'two')).status).toBe(200);
    fs.writeFileSync(path.join(root, 'one/agent-a.json'), JSON.stringify(setup.agents[0]));
    expect((await post('/presets/delete', { id: 'scene' })).status).toBe(200);
    expect(fs.existsSync(path.join(root, 'one/agent-a.json'))).toBe(true);
    expect(await (await post('/presets/list', {})).json()).toEqual([]);
    expect((await (await post('/presets/list', {}, 'two')).json())[0].name).toBe('Other profile');
});

test('invalid identifiers and duplicate agents are rejected without writing outside preset storage', async () => {
    for (const payload of [
        { ...setup, id: '../outside' }, { ...setup, id: ['scene'] },
        { ...setup, agents: [...setup.agents, setup.agents[0]] },
        { ...setup, agents: [{ id: '../agent' }] }, { ...setup, globalSettings: [] },
    ]) {
        expect((await post('/presets/save', payload)).status).toBe(400);
    }
    expect(fs.existsSync(path.join(root, 'outside.json'))).toBe(false);
    expect((await post('/presets/delete', { id: '../agent-a' })).status).toBe(400);
    expect(fs.existsSync(path.join(root, 'one/agent-a.json'))).toBe(true);
});

test('a filesystem write failure returns an error and the same save succeeds after retry', async () => {
    const filename = path.join(root, 'one/presets/blocked.json');
    fs.mkdirSync(filename);
    expect((await post('/presets/save', { ...setup, id: 'blocked' })).status).toBe(500);
    expect(fs.statSync(filename).isDirectory()).toBe(true);
    fs.rmdirSync(filename);
    expect((await post('/presets/save', { ...setup, id: 'blocked' })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).agents).toEqual(setup.agents);
});
