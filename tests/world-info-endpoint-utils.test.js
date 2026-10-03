import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUploadStorage } from '../src/middleware/uploadStorage.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { getWorldInfoFilename, getWorldInfoName, isValidWorldInfoData, router } = await import('../src/endpoints/worldinfo.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');

describe('World Info endpoint helpers', () => {
    test('canonicalizes names the same way for reads and writes', () => {
        expect(getWorldInfoFilename('A/B')).toBe('AB.json');
        expect(getWorldInfoName('A/B')).toBe('AB');
    });

    test('rejects names that sanitize to an empty stem', () => {
        expect(getWorldInfoFilename('/')).toBe('');
        expect(getWorldInfoName('CON')).toBe('');
    });

    test('reserves filename bytes for the JSON extension', () => {
        const filename = getWorldInfoFilename('a'.repeat(255));
        expect(filename.endsWith('.json')).toBe(true);
        expect(Buffer.byteLength(filename) + 16).toBeLessThanOrEqual(255);
        expect(getWorldInfoName('a'.repeat(255))).toHaveLength(234);
    });

    test('accepts native entry objects', () => {
        expect(isValidWorldInfoData({ entries: {} })).toBe(true);
        expect(isValidWorldInfoData({ entries: { 0: { uid: 0, content: '' } } })).toBe(true);
    });

    test('rejects malformed entry containers and values', () => {
        expect(isValidWorldInfoData({ entries: null })).toBe(false);
        expect(isValidWorldInfoData({ entries: [] })).toBe(false);
        expect(isValidWorldInfoData({ entries: { 0: null } })).toBe(false);
        expect(isValidWorldInfoData({ entries: { 0: 'bad' } })).toBe(false);
    });
});

describe('World Info endpoints', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;
    let uploadsPath;

    beforeAll(async () => {
        uploadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-world-info-uploads-'));
        const app = express();
        app.use(express.json());
        app.use(multer({ storage: createUploadStorage(uploadsPath) }).single('avatar'));
        app.use((request, _response, next) => {
            request.user = { directories, profile: { handle: 'world-info-test' } };
            next();
        });
        app.use('/api/worldinfo', router);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-world-info-endpoints-'));
        const root = path.join(tempRoot, 'world-info-test');
        directories = { ...Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)])), root };
        for (const folder of Object.values(directories)) fs.mkdirSync(folder, { recursive: true });
        initialiseRoleplayAccount({ owner: 'world-info-test', directories });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(uploadsPath, { recursive: true, force: true });
    });

    test('rejects empty canonical edit names without creating a file', async () => {
        const response = await postJson('/api/worldinfo/edit', { name: '/', data: { entries: {} } });
        expect(response.status).toBe(400);
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('keeps maximum-length edit names discoverable as JSON files', async () => {
        const response = await postJson('/api/worldinfo/edit', { name: 'a'.repeat(255), data: { entries: {} } });
        expect(response.status).toBe(200);
        const [filename] = fs.readdirSync(directories.worlds);
        expect(filename.endsWith('.json')).toBe(true);
        expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
    });

    test('returns not found for missing worlds', async () => {
        const response = await postJson('/api/worldinfo/get', { name: 'Missing' });
        expect(response.status).toBe(404);
    });

    test('a null revision creates only an absent book and reads expose its exact revision', async () => {
        const data = { entries: { 0: { uid: 0, content: 'First writer' } } };
        const created = await postJson('/api/worldinfo/edit', { name: 'Guarded creation', data, revision: null });
        expect(created.status).toBe(200);
        const saved = await created.json();
        expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
        const loaded = await postJson('/api/worldinfo/get', { name: 'Guarded creation' });
        expect(loaded.headers.get('X-World-Info-Revision')).toBe(saved.revision);
        expect(await loaded.json()).toEqual(data);
        expect((await postJson('/api/worldinfo/edit', { name: 'Guarded creation', data: { entries: {} }, revision: null })).status).toBe(409);
        expect(JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Guarded creation.json'), 'utf8'))).toEqual(data);
    });

    test('guarded renames reject a stale loaded copy without changing either path', async () => {
        const original = { entries: { 0: { uid: 0, content: 'Loaded copy' } } };
        const first = await (await postJson('/api/worldinfo/edit', { name: 'Before rename', data: original })).json();
        const current = { entries: { 0: { uid: 0, content: 'Newer publication' } } };
        const updated = await (await postJson('/api/worldinfo/edit', { name: 'Before rename', data: current, revision: first.revision })).json();
        expect((await postJson('/api/worldinfo/rename', { oldName: 'Before rename', newName: 'After rename', data: original, revision: first.revision })).status).toBe(409);
        expect(JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Before rename.json'), 'utf8'))).toEqual(current);
        expect(fs.existsSync(path.join(directories.worlds, 'After rename.json'))).toBe(false);
        const renamed = await postJson('/api/worldinfo/rename', { oldName: 'Before rename', newName: 'After rename', data: current, revision: updated.revision });
        expect(renamed.status).toBe(200);
        expect((await renamed.json()).revision).toBe(updated.revision);
    });

    test('guarded file imports reject stale replacements and absent-only collisions', async () => {
        const original = { entries: { 0: { uid: 0, content: 'First' } } };
        const created = await postImport({ filename: 'Guarded import.json', contents: JSON.stringify(original), revision: '' });
        expect(created.status).toBe(200);
        const initial = await created.json();
        const current = { entries: { 0: { uid: 0, content: 'Published after preview' } } };
        const updated = await (await postJson('/api/worldinfo/edit', { name: 'Guarded import', data: current, revision: initial.revision })).json();
        expect((await postImport({ filename: 'Guarded import.json', contents: JSON.stringify(original), revision: initial.revision })).status).toBe(409);
        expect((await postImport({ filename: 'Guarded import.json', contents: JSON.stringify(original), revision: '' })).status).toBe(409);
        expect(JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Guarded import.json'), 'utf8'))).toEqual(current);
        const replacement = await postImport({ filename: 'Guarded import.json', contents: JSON.stringify(original), revision: updated.revision });
        expect(replacement.status).toBe(200);
        expect((await replacement.json()).revision).toBe(initial.revision);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('renames a world without leaving the source file behind', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Old', data: { entries: {} } });
        const response = await postJson('/api/worldinfo/rename', { oldName: 'Old', newName: 'New', data: { entries: {} } });
        expect(response.status).toBe(200);
        expect(fs.existsSync(path.join(directories.worlds, 'Old.json'))).toBe(false);
        expect(fs.existsSync(path.join(directories.worlds, 'New.json'))).toBe(true);
    });

    test('reads, edits, and renames legacy long filenames without truncating the source', async () => {
        const legacyName = 'l'.repeat(240);
        const legacyFilename = `${legacyName}.json`;
        const legacyPath = path.join(directories.worlds, legacyFilename);
        fs.writeFileSync(legacyPath, JSON.stringify({ entries: {}, marker: 'old' }));

        const getResponse = await postJson('/api/worldinfo/get', { name: legacyName });
        expect(getResponse.status).toBe(200);
        expect((await getResponse.json()).marker).toBe('old');

        const editResponse = await postJson('/api/worldinfo/edit', { name: legacyName, data: { entries: {}, marker: 'edited' } });
        expect(editResponse.status).toBe(200);
        expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).marker).toBe('edited');

        const renameResponse = await postJson('/api/worldinfo/rename', { oldName: legacyName, newName: 'Renamed Legacy', data: { entries: {}, marker: 'renamed' } });
        expect(renameResponse.status).toBe(200);
        expect(fs.existsSync(legacyPath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Renamed Legacy.json'), 'utf8')).marker).toBe('renamed');
    });

    test('imports a native world info JSON file', async () => {
        const contents = JSON.stringify({ entries: { 0: { uid: 0, content: 'hello' } } });
        const response = await postImport({ filename: 'My World.json', contents });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'My World', revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(fs.readFileSync(path.join(directories.worlds, 'My World.json'), 'utf8')).toBe(contents);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('prefers the requested name from the form body over the filename', async () => {
        const contents = JSON.stringify({ entries: {} });
        const response = await postImport({ filename: 'Ignored.json', contents, name: 'Renamed' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'Renamed', revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(fs.existsSync(path.join(directories.worlds, 'Renamed.json'))).toBe(true);
        expect(fs.existsSync(path.join(directories.worlds, 'Ignored.json'))).toBe(false);
    });

    test('uses convertedData over the uploaded file body', async () => {
        const convertedData = JSON.stringify({ entries: {} });
        const response = await postImport({ filename: 'Converted.json', contents: 'not json at all', convertedData });
        expect(response.status).toBe(200);
        expect(fs.readFileSync(path.join(directories.worlds, 'Converted.json'), 'utf8')).toBe(convertedData);
    });

    test('rejects invalid JSON uploads with a 400', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await postImport({ filename: 'Broken.json', contents: '{ not json' });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('Is not a valid world info file');
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('rejects JSON without an entries object', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const noEntries = await postImport({ filename: 'NoEntries.json', contents: JSON.stringify({ name: 'x' }) });
        expect(noEntries.status).toBe(400);
        const arrayEntries = await postImport({ filename: 'ArrayEntries.json', contents: JSON.stringify({ entries: [] }) });
        expect(arrayEntries.status).toBe(400);
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('rejects import names that sanitize to an empty stem', async () => {
        const response = await postImport({ filename: 'Valid.json', contents: JSON.stringify({ entries: {} }), name: '/' });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('World file must have a name');
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('reports import storage failures as a 500 instead of an invalid file', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fs.mkdirSync(path.join(directories.worlds, 'Blocked.json'));
        const response = await postImport({ filename: 'Blocked.json', contents: JSON.stringify({ entries: {} }) });
        expect(response.status).toBe(409);
        expect(fs.statSync(path.join(directories.worlds, 'Blocked.json')).isDirectory()).toBe(true);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('rejects import requests without an uploaded file', async () => {
        const response = await postJson('/api/worldinfo/import', {});
        expect(response.status).toBe(400);
    });

    test('history commits, guarded edits, and rollback preserve uncommitted data', async () => {
        const original = { entries: { 4: { uid: 4, content: 'Original', custom: { retained: true } } } };
        await postJson('/api/worldinfo/edit', { name: 'History', data: original });
        const initial = await (await postJson('/api/worldinfo/history', { name: 'History', includeBook: true })).json();
        expect(initial.data).toEqual(original);
        const committed = await (await postJson('/api/worldinfo/history', {
            name: 'History', action: 'commit', revision: initial.revision, headCommitId: null, message: 'First',
        })).json();
        expect(committed.history.commits).toHaveLength(1);
        expect(committed.history.headCommitId).toMatch(/^[a-f0-9]{64}$/);
        const current = { entries: { 4: { uid: 4, content: 'Uncommitted' } } };
        expect((await postJson('/api/worldinfo/edit', { name: 'History', data: current, revision: initial.revision })).status).toBe(200);
        expect((await postJson('/api/worldinfo/edit', { name: 'History', data: original, revision: initial.revision })).status).toBe(409);
        expect((await postJson('/api/worldinfo/history', {
            name: 'History', action: 'restore', revision: committed.revision, headCommitId: committed.history.headCommitId, commitId: committed.history.headCommitId,
        })).status).toBe(409);
        const staged = await (await postJson('/api/worldinfo/history', { name: 'History' })).json();
        const restored = await (await postJson('/api/worldinfo/history', {
            name: 'History', action: 'restore', revision: staged.revision, headCommitId: staged.history.headCommitId, commitId: committed.history.headCommitId,
        })).json();
        expect(restored.data).toEqual(original);
        expect(restored.history.commits).toHaveLength(3);
        expect(restored.history.commits[1].snapshot).toEqual(current);
        expect(restored.history.commits[2].parentId).toBe(restored.history.commits[1].id);
        const persisted = await (await postJson('/api/worldinfo/get', { name: 'History' })).json();
        expect(persisted).toEqual(original);
        expect(persisted).not.toHaveProperty('commits');
    });

    test('health check choices are sanitised, kept beside commits, and cleared when empty', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Health', data: { entries: {} } });
        const initial = await (await postJson('/api/worldinfo/history', { name: 'Health' })).json();
        await postJson('/api/worldinfo/history', { name: 'Health', action: 'commit', revision: initial.revision, headCommitId: null, message: 'Base' });
        const saved = await (await postJson('/api/worldinfo/history', {
            name: 'Health', action: 'lint', lintPrefs: { ignoredSignatures: ['duplicate-key|0,1|paris', '', 4], mutedRules: ['self-trigger', 'made-up'] },
        })).json();
        expect(saved.history.lintPrefs).toEqual({ ignoredSignatures: ['duplicate-key|0,1|paris'], mutedRules: ['self-trigger'] });
        expect(saved.history.commits).toHaveLength(1);
        expect(saved.history.commits[0]).not.toHaveProperty('lintPrefs');
        const summary = await (await postJson('/api/worldinfo/history', { name: 'Health', summary: true })).json();
        expect(summary.history.lintPrefs).toEqual(saved.history.lintPrefs);
        const cleared = await (await postJson('/api/worldinfo/history', { name: 'Health', action: 'lint', lintPrefs: { ignoredSignatures: [], mutedRules: [] } })).json();
        expect(cleared.history).not.toHaveProperty('lintPrefs');
    });

    test('history follows renames and does not attach to a newly created book after deletion', async () => {
        const data = { entries: {} };
        await postJson('/api/worldinfo/edit', { name: 'Old history', data });
        const initial = await (await postJson('/api/worldinfo/history', { name: 'Old history' })).json();
        const committed = await (await postJson('/api/worldinfo/history', {
            name: 'Old history', action: 'commit', revision: initial.revision, headCommitId: null, message: 'Empty book',
        })).json();
        expect((await postJson('/api/worldinfo/rename', { oldName: 'Old history', newName: 'New history', data })).status).toBe(200);
        const renamed = await (await postJson('/api/worldinfo/history', { name: 'New history' })).json();
        expect(renamed.history).toEqual(committed.history);
        expect((await postJson('/api/worldinfo/list', {})).status).toBe(200);
        expect((await (await postJson('/api/worldinfo/list', {})).json()).map(item => item.file_id)).toEqual(['New history']);
        await postJson('/api/worldinfo/delete', { name: 'New history' });
        await postJson('/api/worldinfo/edit', { name: 'New history', data });
        expect((await (await postJson('/api/worldinfo/history', { name: 'New history' })).json()).history.commits).toEqual([]);
    });

    test('project imports validate history before replacing data and preserve existing commits', async () => {
        const original = { entries: { 0: { uid: 0, content: 'Local' } } };
        await postJson('/api/worldinfo/edit', { name: 'Project', data: original });
        const initial = await (await postJson('/api/worldinfo/history', { name: 'Project' })).json();
        const local = await (await postJson('/api/worldinfo/history', {
            name: 'Project', action: 'commit', revision: initial.revision, headCommitId: null, message: 'Local',
        })).json();
        const incoming = { entries: { 7: { uid: 7, content: 'Incoming' } } };
        const history = { version: 1, id: 'imported', headCommitId: 'a'.repeat(64), commits: [{
            id: 'a'.repeat(64), parentId: null, timestamp: 123, message: 'Imported', snapshot: incoming,
        }] };
        const invalid = structuredClone(history);
        invalid.commits[0].parentId = 'b'.repeat(64);
        expect((await postImport({ filename: 'Project.stproj', contents: '{}', convertedData: JSON.stringify(incoming), history: invalid })).status).toBe(400);
        expect(await (await postJson('/api/worldinfo/get', { name: 'Project' })).json()).toEqual(original);
        expect((await postImport({ filename: 'Project.stproj', contents: '{}', convertedData: JSON.stringify(incoming), history })).status).toBe(200);
        const result = await (await postJson('/api/worldinfo/history', { name: 'Project' })).json();
        expect(result.history.commits.map(commit => commit.id)).toEqual([local.history.headCommitId, history.headCommitId]);
        expect(result.history.headCommitId).toBe(history.headCommitId);
        expect(await (await postJson('/api/worldinfo/get', { name: 'Project' })).json()).toEqual(incoming);
    });

    test('a failed rollback keeps the previous book and history', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const data = { entries: { 0: { uid: 0, content: 'Original' } } };
        await postJson('/api/worldinfo/edit', { name: 'Failed restore', data });
        const initial = await (await postJson('/api/worldinfo/history', { name: 'Failed restore' })).json();
        const committed = await (await postJson('/api/worldinfo/history', {
            name: 'Failed restore', action: 'commit', revision: initial.revision, headCommitId: null, message: 'First',
        })).json();
        const current = { entries: { 0: { uid: 0, content: 'Current' } } };
        await postJson('/api/worldinfo/edit', { name: 'Failed restore', data: current });
        const staged = await (await postJson('/api/worldinfo/history', { name: 'Failed restore' })).json();
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (to === path.join(directories.worlds, 'Failed restore.json')) throw new Error('Disk write failed');
            return rename(from, to);
        });
        expect((await postJson('/api/worldinfo/history', {
            name: 'Failed restore', action: 'restore', revision: staged.revision, headCommitId: staged.history.headCommitId, commitId: committed.history.headCommitId,
        })).status).toBe(500);
        expect(await (await postJson('/api/worldinfo/get', { name: 'Failed restore' })).json()).toEqual(current);
        expect((await (await postJson('/api/worldinfo/history', { name: 'Failed restore' })).json()).history).toEqual(staged.history);
    });

    function postImport({ filename, contents, name, convertedData, history, revision }) {
        const formData = new FormData();
        formData.append('avatar', new Blob([contents], { type: 'application/json' }), filename);
        if (name !== undefined) {
            formData.set('name', name);
        }
        if (convertedData !== undefined) {
            formData.set('convertedData', convertedData);
        }
        if (history !== undefined) formData.set('history', JSON.stringify(history));
        if (revision !== undefined) formData.set('revision', revision);
        return fetch(`${baseUrl}/api/worldinfo/import`, { method: 'POST', body: formData });
    }

    function postJson(route, body) {
        return fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
});
