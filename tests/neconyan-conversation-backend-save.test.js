import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SETTINGS_FILE } from '../src/constants.js';
import { CONVERSATION_STORE_KEY, DEFAULT_BRANCH_ID } from '../public/scripts/neconyan-conversation/constants.js';
import { MAX_CONVERSATION_STORE_ENTRIES, validateStoreStructure } from '../src/endpoints/conversation-utils.js';

const triggerAutoSave = jest.fn();
await jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ triggerAutoSave }));
const { readConversationStoreForWrite, saveConversationStore } = await import('../src/endpoints/conversation-store.js');

describe('Conversation backend store commits', () => {
    const tempDirs = [];

    afterEach(() => {
        triggerAutoSave.mockClear();
        for (const directory of tempDirs.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    function createRequest() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-backend-save-'));
        tempDirs.push(root);
        fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({ _version: 0, extension_settings: {} }));
        return {
            user: {
                profile: { handle: 'backend-save-user' },
                directories: { root },
            },
        };
    }

    function createStore() {
        return {
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {},
            groups: [],
            legacyThreadPersonaAssignments: {},
            reminders: [],
        };
    }

    function createBranchStore(messages) {
        const store = createStore();
        store.characters['nova.png'] = {
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: { createdAt: '1', messages },
            },
        };
        return store;
    }

    function readSettings(request) {
        return JSON.parse(fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8'));
    }

    const normalizeGroup = group => group;

    test('triggers the existing settings backup service only after a successful write', async () => {
        const request = createRequest();
        const result = await saveConversationStore(request, createStore(), 0);

        expect(result.ok).toBe(true);
        expect(triggerAutoSave).toHaveBeenCalledTimes(1);
        expect(triggerAutoSave).toHaveBeenCalledWith('backend-save-user');
        const settings = JSON.parse(fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8'));
        expect(settings._version).toBe(1);
        expect(settings.extension_settings[CONVERSATION_STORE_KEY]).toEqual(createStore());

        const conflict = await saveConversationStore(request, createStore(), 0);
        expect(conflict).toMatchObject({ ok: false, status: 409 });
        expect(triggerAutoSave).toHaveBeenCalledTimes(1);
    });

    test('validates the final store before writing or triggering a backup', async () => {
        const request = createRequest();
        const store = createStore();
        store.characters['nova.png'] = {
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: [],
        };

        const result = await saveConversationStore(request, store, 0);
        expect(result).toEqual({ ok: false, status: 400, body: { error: 'invalid_branches' } });
        expect(triggerAutoSave).not.toHaveBeenCalled();
        const settings = JSON.parse(fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8'));
        expect(settings).toEqual({ _version: 0, extension_settings: {} });
    });

    test('server-added history metadata cannot write a store beyond the accepted entry budget', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const before = fs.readFileSync(file, 'utf8');
        const store = createStore();
        store.characters['nova.png'] = { activeBranchId: 'main', branches: { main: { createdAt: '1', messages: [] } } };
        store.padding = Array.from({ length: 500 }, () => Array(998).fill(null));
        const count = value => value && typeof value === 'object'
            ? Object.keys(value).length + Object.values(value).reduce((sum, child) => sum + count(child), 0) : 0;
        store.padding.push(Array(MAX_CONVERSATION_STORE_ENTRIES - count(store) - 2).fill(null));
        expect(validateStoreStructure(store)).toEqual({ valid: true });
        await expect(saveConversationStore(request, store, 0)).rejects.toMatchObject({ status: 400, message: 'payload_too_complex' });
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        expect(triggerAutoSave).not.toHaveBeenCalled();
    });

    test('a preflight snapshot avoids a second settings parse on save', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const marker = 'backend-snapshot-parse-marker';
        fs.writeFileSync(file, JSON.stringify({
            _version: 0,
            snapshotMarker: marker,
            extension_settings: {},
        }));

        const originalParse = JSON.parse;
        let settingsParses = 0;
        JSON.parse = function (text, reviver) {
            if (typeof text === 'string' && text.includes(marker)) settingsParses++;
            return originalParse.call(this, text, reviver);
        };
        let written;
        try {
            const context = readConversationStoreForWrite(request, 0, normalizeGroup);
            expect(context.ok).toBe(true);
            const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
            expect(result).toMatchObject({ ok: true, version: 1 });
            written = fs.readFileSync(file, 'utf8');
            expect(settingsParses).toBe(1);
        } finally {
            JSON.parse = originalParse;
        }
        expect(JSON.parse(written)).toMatchObject({ _version: 1, snapshotMarker: marker });
    });

    test('a file changed during the preflight read cannot become a reusable snapshot', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const external = { _version: 1, externalField: 'changed during read', extension_settings: {} };
        const originalRead = fs.readFileSync;
        let context;
        let replaced = false;
        fs.readFileSync = function (filename, ...args) {
            const content = originalRead.call(this, filename, ...args);
            if (filename === file && !replaced) {
                replaced = true;
                fs.writeFileSync(file, JSON.stringify(external));
            }
            return content;
        };
        try {
            context = readConversationStoreForWrite(request, 0, normalizeGroup);
        } finally {
            fs.readFileSync = originalRead;
        }
        expect(replaced).toBe(true);
        expect(context.ok).toBe(true);
        expect(context.snapshot).toBeNull();
        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toEqual({ ok: false, status: 409, body: { error: 'settings_conflict', version: 1 } });
        expect(readSettings(request)).toEqual(external);
        expect(triggerAutoSave).not.toHaveBeenCalled();
    });

    test('a settings write between preflight and save still returns the version conflict', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const context = readConversationStoreForWrite(request, 0, normalizeGroup);
        expect(context.ok).toBe(true);

        const external = { _version: 1, externalField: 'newer', extension_settings: { marker: { value: 1 } } };
        fs.writeFileSync(file, JSON.stringify(external));

        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toEqual({ ok: false, status: 409, body: { error: 'settings_conflict', version: 1 } });
        expect(readSettings(request)).toEqual(external);
        expect(triggerAutoSave).not.toHaveBeenCalled();
    });

    test('a stale snapshot falls back to disk and preserves fresh external settings', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const before = JSON.stringify({
            _version: 0,
            snapshotPadding: 'A'.repeat(400),
            externalField: 'BBBBBBBBBB',
            extension_settings: {},
        });
        fs.writeFileSync(file, before);
        const beforeStat = fs.statSync(file);
        const context = readConversationStoreForWrite(request, 0, normalizeGroup);
        expect(context.ok).toBe(true);

        const external = before.replace('"externalField":"BBBBBBBBBB"', '"externalField":"CCCCCCCCCC"');
        expect(Buffer.byteLength(external)).toBe(Buffer.byteLength(before));
        fs.writeFileSync(file, external);
        fs.utimesSync(file, beforeStat.atime, beforeStat.mtime);

        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toMatchObject({ ok: true, version: 1 });
        expect(readSettings(request)).toMatchObject({
            _version: 1,
            snapshotPadding: 'A'.repeat(400),
            externalField: 'CCCCCCCCCC',
        });
    });

    test('the writable store is detached from the validated snapshot', async () => {
        const request = createRequest();
        const seeded = createBranchStore([{ id: 'm1', role: 'user', mes: 'Hello', name: 'User' }]);
        expect(await saveConversationStore(request, seeded, 0)).toMatchObject({ ok: true, version: 1 });

        const context = readConversationStoreForWrite(request, 1, normalizeGroup);
        expect(context.ok).toBe(true);
        const snapshotBranch = context.snapshot.settings.extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png'].branches[DEFAULT_BRANCH_ID];
        const branch = context.store.characters['nova.png'].branches[DEFAULT_BRANCH_ID];
        branch.messages.push({ id: 'm2', role: 'character', mes: 'Reply', name: 'Nova' });

        expect(snapshotBranch.messages).toHaveLength(1);
        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toMatchObject({ ok: true, version: 2 });

        const savedBranch = readSettings(request).extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png'].branches[DEFAULT_BRANCH_ID];
        expect(savedBranch.messages).toHaveLength(2);
        // Appending to the preflight store must stay append-only; a shared
        // snapshot would see the appended message as an edit and bump this.
        expect(savedBranch.messageEditRevision).toBe(1);
    });

    test('an unchanged preflight store save keeps the message revision', async () => {
        const request = createRequest();
        const seeded = createBranchStore([{ id: 'm1', role: 'user', mes: 'Hello', name: 'User' }]);
        expect(await saveConversationStore(request, seeded, 0)).toMatchObject({ ok: true, version: 1 });

        const context = readConversationStoreForWrite(request, 1, normalizeGroup);
        expect(context.ok).toBe(true);
        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toMatchObject({ ok: true, version: 2 });

        const savedBranch = readSettings(request).extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png'].branches[DEFAULT_BRANCH_ID];
        expect(savedBranch.messageEditRevision).toBe(1);
        expect(savedBranch.messages).toEqual([{ id: 'm1', role: 'user', mes: 'Hello', name: 'User' }]);
    });

    test('a snapshot whose file becomes unreadable falls back to the read error', async () => {
        const request = createRequest();
        const file = path.join(request.user.directories.root, SETTINGS_FILE);
        const context = readConversationStoreForWrite(request, 0, normalizeGroup);
        expect(context.ok).toBe(true);
        fs.writeFileSync(file, '{broken');

        const result = await saveConversationStore(request, context.store, context.version, { settingsSnapshot: context.snapshot });
        expect(result).toEqual({ ok: false, status: 500, body: { error: 'settings_read_failed' } });
        expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
        expect(triggerAutoSave).not.toHaveBeenCalled();
    });

    test('a snapshot from another settings path is never trusted', async () => {
        const first = createRequest();
        const second = createRequest();
        const firstFile = path.join(first.user.directories.root, SETTINGS_FILE);
        const secondFile = path.join(second.user.directories.root, SETTINGS_FILE);
        fs.writeFileSync(firstFile, JSON.stringify({ _version: 0, snapshotMarker: 'first', extension_settings: {} }));
        fs.writeFileSync(secondFile, JSON.stringify({ _version: 0, snapshotMarker: 'second', extension_settings: {} }));

        const context = readConversationStoreForWrite(first, 0, normalizeGroup);
        expect(context.ok).toBe(true);
        const result = await saveConversationStore(second, context.store, 0, { settingsSnapshot: context.snapshot });
        expect(result).toMatchObject({ ok: true, version: 1 });

        expect(readSettings(first)).toMatchObject({ _version: 0, snapshotMarker: 'first' });
        expect(readSettings(second)).toMatchObject({ _version: 1, snapshotMarker: 'second' });
    });
});
