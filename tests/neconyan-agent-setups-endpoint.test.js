import { afterAll, beforeAll, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { readAgentCollection } from '../src/in-chat-agent-storage.js';
import { AGENT_STORAGE_LIMITS } from '../public/scripts/extensions/in-chat-agents/setup-presets.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/in-chat-agents.js');
const { router: settingsRouter } = await import('../src/endpoints/settings.js');
let server;
let root;
let baseUrl;

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-agent-setups-'));
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((request, _response, next) => {
        const profile = request.header('test-profile') === 'two' ? 'two' : 'one';
        request.user = { profile: { handle: profile }, directories: { inChatAgents: path.join(root, profile), inChatAgentGroups: path.join(root, profile, 'groups') } };
        next();
    });
    app.use('/settings', settingsRouter);
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

function post(route, data, profile = 'one', headers = {}) {
    return fetch(baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'test-profile': profile, ...headers }, body: JSON.stringify(data) });
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

test('conditional saves reject stale updates, deletions and resurrection after another client deleted the record', async () => {
    const original = { id: 'race', name: 'Race', prompt: 'original' };
    const created = await post('/save', original, 'one', { 'If-Match': 'missing', 'X-Neconyan-Account': 'one' });
    expect(created.status).toBe(200);
    const firstRevision = created.headers.get('X-Neconyan-Revision');
    const changed = await post('/save', { ...original, prompt: 'second client' }, 'one', { 'If-Match': firstRevision });
    expect(changed.status).toBe(200);
    expect((await post('/save', original, 'one', { 'If-Match': firstRevision })).status).toBe(409);
    expect((await post('/delete', { id: original.id }, 'one', { 'If-Match': firstRevision })).status).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'one/race.json'), 'utf8')).prompt).toBe('second client');
    const currentRevision = changed.headers.get('X-Neconyan-Revision');
    expect((await post('/delete', { id: original.id }, 'one', { 'If-Match': currentRevision })).status).toBe(200);
    expect((await post('/save', original, 'one', { 'If-Match': currentRevision })).status).toBe(409);
    expect(fs.existsSync(path.join(root, 'one/race.json'))).toBe(false);
});

test('a tab bound to the previous account cannot write into the newly authenticated account', async () => {
    for (const route of ['/save', '/groups/save', '/presets/save']) {
        const record = route === '/presets/save' ? { ...setup, id: 'account-race' } : { id: 'account-race', name: 'Account' };
        expect((await post(route, record, 'two', { 'If-Match': 'missing', 'X-Neconyan-Account': 'one' })).status).toBe(409);
    }
    expect(fs.existsSync(path.join(root, 'two/account-race.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'two/presets/account-race.json'))).toBe(false);
    const settingsResponse = await post('/settings/save', { _version: 0, extension_settings: { inChatAgents: {} } }, 'two', { 'X-Neconyan-Account': 'one' });
    expect(settingsResponse.status).toBe(409);
    expect(await settingsResponse.json()).toEqual({ error: 'account_changed' });
});

test('lossy, reserved and overlong identifiers never alias a valid record', async () => {
    const record = { id: 'ab', name: 'Keep me' };
    expect((await post('/save', record)).status).toBe(200);
    for (const id of ['a?b', 'a/b', 'CON', 'NUL.txt', '...', 1, 'x'.repeat(251), '猫'.repeat(85)]) {
        expect((await post('/save', { ...record, id })).status).toBe(400);
        expect((await post('/groups/save', { ...record, id })).status).toBe(400);
        expect((await post('/delete', { id })).status).toBe(400);
    }
    expect(JSON.parse(fs.readFileSync(path.join(root, 'one/ab.json'), 'utf8'))).toEqual(record);
    expect((await post('/save', { ...record, id: 'valid-shape', tools: [null] })).status).toBe(400);
    expect((await post('/presets/save', { ...setup, globalSettings: { enabledAgentIdsByChatType: { individual: ['excluded-agent'] } } })).status).toBe(400);
});

test('partially damaged libraries report each affected file while keeping healthy records and original files', async () => {
    const directory = path.join(root, 'damaged');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'healthy.json'), JSON.stringify({ id: 'healthy', prompt: 'Good' }));
    fs.writeFileSync(path.join(directory, 'broken.json'), '{');
    fs.writeFileSync(path.join(directory, 'bad-tools.json'), JSON.stringify({ id: 'bad-tools', tools: [null] }));
    fs.writeFileSync(path.join(directory, 'mismatch.json'), JSON.stringify({ id: 'different' }));
    const result = readAgentCollection(directory);
    expect(result.records.map(record => record.id)).toEqual(['healthy']);
    expect(result.errors.map(error => error.file).sort()).toEqual(['bad-tools.json', 'broken.json', 'mismatch.json']);
    expect(result.revisions.healthy).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(directory, 'broken.json'), 'utf8')).toBe('{');
    expect(fs.readdirSync(directory)).toHaveLength(4);
});

test('oversized records and collections stop bounded loading without deleting recovery files', async () => {
    expect((await post('/save', { id: 'huge', prompt: 'x'.repeat(AGENT_STORAGE_LIMITS.agentBytes) })).status).toBe(413);
    const directory = path.join(root, 'large-setups');
    fs.mkdirSync(directory);
    for (let i = 0; i < AGENT_STORAGE_LIMITS.presetCount + 10; i++) {
        fs.writeFileSync(path.join(directory, `setup-${i}.json`), JSON.stringify({ ...setup, id: `setup-${i}`, recoveryFor: 'interrupted' }));
    }
    const result = readAgentCollection(directory, 'preset');
    expect(result.records.length).toBeLessThanOrEqual(AGENT_STORAGE_LIMITS.presetCount);
    expect(result.errors).toContainEqual(expect.objectContaining({ file: 'Collection' }));
    expect(fs.readdirSync(directory)).toHaveLength(AGENT_STORAGE_LIMITS.presetCount + 10);
});

test('custom kits retain local identities and references through the real server', async () => {
    const kit = { id: 'linked', name: 'Linked', customAgents: [
        { id: 'Agent-A', name: 'A', companion: { dependencies: ['agent-a'] } },
        { id: 'agent-a', name: 'B', companion: { contextRecipientAgentIds: ['Agent-A'] } },
    ] };
    expect((await post('/groups/save', kit)).status).toBe(200);
    const response = await post('/groups/list', { withDiagnostics: true });
    expect(response.headers.get('X-Neconyan-Account')).toBe('one');
    const stored = (await response.json()).records.find(record => record.id === kit.id);
    expect(stored.customAgents.map(agent => agent.id)).toEqual(['Agent-A', 'agent-a']);
    expect(stored.customAgents[0].companion.dependencies).toEqual(['agent-a']);
});
