import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES, SETTINGS_FILE, TEXTGEN_TYPES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { CONVERSATION_STORE_KEY, DEFAULT_BRANCH_ID } from '../public/scripts/neconyan-conversation/constants.js';
import { validateStoreStructure } from '../src/endpoints/conversation-utils.js';
import { resumableGenerationMiddleware } from '../src/resumable-generations.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const triggerSettingsBackup = jest.fn();
await jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ triggerAutoSave: triggerSettingsBackup }));

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address()));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        if (!server) {
            resolve();
            return;
        }

        server.close((error) => error ? reject(error) : resolve());
    });
}

async function readRequestJson(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

describe('Neconyan Conversation REST API', () => {
    /** @type {import('http').Server} */
    let appServer;
    /** @type {import('http').Server} */
    let upstreamServer;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;
    let baseUrl;
    let upstreamUrl;
    let upstreamReplyText;
    let upstreamResponseDelayMs;
    let upstreamResponseStatus;
    let userHandle;
    let clientNumber = 0;
    const upstreamRequests = [];
    const tempDirs = [];

    beforeAll(async () => {
        const { router } = await import('../src/endpoints/neconyan-conversation.js');

        upstreamServer = http.createServer(async (request, response) => {
            if (request.method !== 'POST' || !['/v1/responses', '/v1/completions', '/v1/chat/completions'].includes(request.url)) {
                response.writeHead(404);
                response.end();
                return;
            }

            const body = await readRequestJson(request);
            upstreamRequests.push(body);
            if (upstreamResponseDelayMs) {
                await new Promise(resolve => setTimeout(resolve, upstreamResponseDelayMs));
            }
            if (upstreamResponseStatus !== 200) {
                response.writeHead(upstreamResponseStatus, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { type: 'upstream_test_error', message: 'Upstream rejected the request' } }));
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            if (request.url === '/v1/completions') {
                response.end(JSON.stringify({ choices: [{ text: upstreamReplyText }] }));
                return;
            }
            if (request.url === '/v1/chat/completions') {
                response.end(JSON.stringify({ choices: [{ message: { content: upstreamReplyText } }] }));
                return;
            }
            response.end(JSON.stringify({
                id: 'resp-conversation-test',
                model: body.model,
                status: 'completed',
                output: [{
                    type: 'message',
                    content: [{
                        type: 'output_text',
                        text: upstreamReplyText,
                    }],
                }],
                usage: {
                    input_tokens: 7,
                    output_tokens: 3,
                },
            }));
        });
        const upstreamAddress = await listen(upstreamServer);
        upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/v1/`;

        const app = express();
        app.use(express.json({ limit: '150mb' }));
        app.use((request, _response, next) => {
            request.user = { directories: userDirectories, profile: { handle: userHandle } };
            Object.defineProperty(request.socket, 'remoteAddress', { value: `192.0.2.${clientNumber}`, configurable: true });
            next();
        });
        app.use(resumableGenerationMiddleware);
        app.use('/api/neconyan-conversation', router);
        app.use('/api/neconyan/conversation', router);

        appServer = http.createServer(app);
        const appAddress = await listen(appServer);
        baseUrl = `http://127.0.0.1:${appAddress.port}/api/neconyan-conversation`;
    });

    beforeEach(() => {
        clientNumber++;
        triggerSettingsBackup.mockClear();
        upstreamRequests.length = 0;
        upstreamReplyText = 'Hello from Nova.';
        upstreamResponseDelayMs = 0;
        upstreamResponseStatus = 200;

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-conversation-api-'));
        tempDirs.push(root);
        userHandle = path.basename(root);
        userDirectories = {
            root,
            backups: path.join(root, 'backups'),
            characters: path.join(root, 'characters'),
            groups: path.join(root, 'groups'),
            userImages: path.join(root, 'user', 'images'),
        };
        fs.mkdirSync(userDirectories.backups, { recursive: true });
        fs.mkdirSync(userDirectories.characters, { recursive: true });
        fs.mkdirSync(userDirectories.groups, { recursive: true });
        fs.mkdirSync(userDirectories.userImages, { recursive: true });
        fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {},
        }, null, 4));
    });

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        userDirectories = undefined;
    });

    afterAll(async () => {
        await close(appServer);
        await close(upstreamServer);
    });

    async function postJson(endpoint, body) {
        return fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function readSettings() {
        return JSON.parse(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8'));
    }

    function readConversationStore() {
        return readSettings().extension_settings[CONVERSATION_STORE_KEY];
    }

    function getChatGeneration() {
        return {
            backend: 'chat',
            payload: {
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: upstreamUrl,
                proxy_password: 'test-key',
                model: 'gpt-5.4',
                temperature: 1,
                top_p: 1,
                max_tokens: 64,
            },
        };
    }

    async function waitForUpstreamRequests(count) {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (upstreamRequests.length >= count) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Timed out waiting for upstream request');
    }

    test('native job effects retain receipts with messages, preserve other writes and reject edited or deleted targets', async () => {
        const { captureConversationTarget, appendConversationJobMessage, commitConversationEffect, commitConversationJobCommands } = await import('../src/generation/conversation-effects.js');
        const { acceptJob, requestCancellation } = await import('../src/jobs/store.js');
        const created = await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', mes: 'Hello', name: 'User' }] });
        expect(created.status).toBe(200);
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = captureConversationTarget(request, { avatar: 'nova.png', branchId: DEFAULT_BRANCH_ID });
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'native-effects', intent: {} }).job;
        const context = { job, owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        const message = { role: 'character', name: 'Nova', mes: 'First bubble' };
        const first = await appendConversationJobMessage(context, target, 'bubble-0', message);
        expect(await appendConversationJobMessage(context, target, 'bubble-0', message)).toEqual(first);
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(2);
        expect(readConversationStore().characters['nova.png'].branches.main.unread).toBe(1);
        expect(Object.keys(readConversationStore().characters['nova.png'].branches.main.pendingPresentations)).toEqual([first.id]);
        const settings = readSettings();
        settings.unrelatedSetting = 'preserved';
        settings._version++;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(settings));
        await commitConversationJobCommands(context, target, 'commands-0', {
            reminders: [{ delay: '21:30', memo: 'Already committed' }], scheduleUpdates: ['status="dnd" activity="working" duration="1h"'],
        }, 'nova.png', 'Asia/Manila', Date.parse('2026-09-19T12:00:00Z'));
        await commitConversationEffect(context, target, 'commands-0', () => { throw new Error('An applied command must not run twice.'); });
        expect(readSettings().unrelatedSetting).toBe('preserved');
        expect(readConversationStore().reminders).toHaveLength(1);
        expect(readConversationStore().reminders[0].triggerAt).toBe(Date.parse('2026-09-19T13:30:00Z'));
        expect(readConversationStore().runtimeStatusOverrides['\u001fnova.png']).toMatchObject({ status: 'dnd', activity: 'working' });
        const edited = readSettings();
        edited.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main.messages[0].mes = 'Edited';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(edited));
        await expect(appendConversationJobMessage(context, target, 'bubble-1', message)).rejects.toMatchObject({ status: 409 });
        delete edited.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'];
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(edited));
        await expect(appendConversationJobMessage(context, target, 'bubble-1', message)).rejects.toMatchObject({ status: 409 });
        expect(readConversationStore().characters['nova.png']).toBeUndefined();
        requestCancellation(userDirectories, job.id);
        await expect(appendConversationJobMessage(context, target, 'bubble-1', message)).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('native outgoing messages do not mark identifier-less read history unread', async () => {
        const { prepareConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
        const { acceptJob } = await import('../src/jobs/store.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'character', mes: 'Old one' }, { role: 'character', mes: 'Old two' }] });
        const settings = readSettings();
        const branch = settings.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main;
        for (const message of branch.messages) delete message.id;
        delete branch.messageContentHash;
        delete branch.messageEditRevision;
        delete branch.readThrough;
        branch.unread = 0;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(settings));
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = await prepareConversationTarget(request, { avatar: 'nova.png', branchId: 'main' });
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'legacy-read', intent: {} }).job;
        const context = { job, owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        await appendConversationJobMessage(context, target, 'outgoing', { role: 'user', mes: 'New outgoing' });
        expect(readConversationStore().characters['nova.png'].branches.main.unread).toBe(0);
        await appendConversationJobMessage(context, target, 'incoming', { role: 'character', mes: 'New incoming' });
        expect(readConversationStore().characters['nova.png'].branches.main.unread).toBe(1);
    });

    test('presentation claims are consumed exactly once and can clear unread', async () => {
        const { captureConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
        const { acceptJob } = await import('../src/jobs/store.js');
        expect((await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', mes: 'Hello', name: 'User' }] })).status).toBe(200);
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = captureConversationTarget(request, { avatar: 'nova.png', branchId: DEFAULT_BRANCH_ID });
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'presentation-claim', intent: {} }).job;
        const context = { job, owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        const appended = await appendConversationJobMessage(context, target, 'bubble-0', { role: 'character', name: 'Nova', mes: 'First bubble' });
        const branch = readConversationStore().characters['nova.png'].branches.main;
        expect(branch.unread).toBe(1);
        expect(Object.keys(branch.pendingPresentations)).toEqual([appended.id]);

        const claim = { target: { avatar: 'nova.png', branchId: DEFAULT_BRANCH_ID, createdAt: branch.createdAt }, messageIds: [appended.id], readThrough: appended.id };
        const first = await postJson('/presentation/claim', claim);
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ won: { [appended.id]: null }, version: expect.any(Number), unread: 0, readThrough: appended.id });
        const after = readConversationStore().characters['nova.png'].branches.main;
        expect(after.unread).toBe(0);
        expect(after.pendingPresentations).toBeUndefined();

        const second = await postJson('/presentation/claim', claim);
        expect(second.status).toBe(200);
        expect((await second.json()).won).toEqual({});
        expect((await postJson('/presentation/claim', { target: { avatar: 'nova.png', branchId: DEFAULT_BRANCH_ID }, messageIds: [1] })).status).toBe(400);
        expect((await postJson('/presentation/claim', { target: { avatar: 'nova.png', branchId: 'missing', createdAt: branch.createdAt } })).status).toBe(409);
        expect((await postJson('/presentation/claim', { ...claim, target: { ...claim.target, createdAt: branch.createdAt + 1 } })).status).toBe(409);
        const unseen = await appendConversationJobMessage(context, target, 'bubble-1', { role: 'character', name: 'Nova', mes: 'Not seen yet' });
        expect((await (await postJson('/presentation/claim', claim)).json()).unread).toBe(1);
        const latest = readConversationStore().characters['nova.png'].branches.main;
        expect(latest.pendingPresentations).toHaveProperty(unseen.id);
        expect((await (await postJson('/presentation/claim', { ...claim, messageIds: [], readThrough: unseen.id })).json()).unread).toBe(0);
        // An older tab cannot move the read boundary backwards.
        expect((await (await postJson('/presentation/claim', claim)).json()).readThrough).toBe(unseen.id);
    });

    test('a legacy capture cannot acquire trusted revision metadata after a raw history edit', async () => {
        const { captureConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
        const { acceptJob } = await import('../src/jobs/store.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ id: 'original', role: 'user', mes: 'Original' }] });
        const file = path.join(userDirectories.root, SETTINGS_FILE);
        const legacy = readSettings();
        const branch = legacy.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main;
        delete branch.messageContentHash;
        delete branch.messageEditRevision;
        fs.writeFileSync(file, JSON.stringify(legacy));
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = captureConversationTarget(request, { avatar: 'nova.png', branchId: 'main' });
        expect(target).not.toHaveProperty('messageEditRevision');
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'legacy-target', intent: {} }).job;
        branch.messages[0].mes = 'Raw replacement';
        fs.writeFileSync(file, JSON.stringify(legacy));
        const store = readConversationStore();
        store.settings.fixtureChange = true;
        expect((await postJson('/store/save', { store, version: legacy._version })).status).toBe(200);
        const before = fs.readFileSync(file, 'utf8');
        const context = { job, owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        await expect(appendConversationJobMessage(context, target, 'late', { role: 'character', mes: 'Must not appear' })).rejects.toMatchObject({ status: 409 });
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    test.each([[249, false], [250, false], [249, true], [250, true]])('native effects and sibling appends survive retention from %i messages, legacy=%s', async (count, legacy) => {
        const { prepareConversationTarget, appendConversationJobMessage, commitConversationJobCommands } = await import('../src/generation/conversation-effects.js');
        const { acceptJob, acceptChildJobs } = await import('../src/jobs/store.js');
        const messages = Array.from({ length: count }, (_, i) => ({ id: `old-${i}`, role: 'user', name: 'User', mes: `Original ${i}` }));
        expect((await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages })).status).toBe(200);
        if (legacy) {
            const saved = readSettings();
            const branch = saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main;
            delete branch.messageContentHash;
            delete branch.messageEditRevision;
            fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        }
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = await prepareConversationTarget(request, { avatar: 'nova.png', branchId: 'main' });
        expect(Number.isSafeInteger(target.messageEditRevision)).toBe(true);
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'retention', intent: {} }).job;
        const children = acceptChildJobs(userDirectories, job.id, [{ participantKey: 'first' }, { participantKey: 'second' }]);
        const context = { job: children[0], owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        const sibling = { ...context, job: children[1] };
        const later = await postJson('/message/append', { avatar: 'nova.png', version: readSettings()._version, message: { id: 'later-input', role: 'user', name: 'User', mes: 'Later input' } });
        expect(later.status).toBe(200);
        const first = await appendConversationJobMessage(context, target, 'first', { role: 'character', name: 'Nova', mes: 'First' });
        const second = await appendConversationJobMessage(sibling, target, 'second', { role: 'character', name: 'Nova', mes: 'Second' });
        const commands = { reminders: [{ delay: '1h', memo: 'Once' }], scheduleUpdates: [] };
        await commitConversationJobCommands(context, target, 'commands', commands, 'nova.png', 'UTC');
        await commitConversationJobCommands(context, target, 'commands', commands, 'nova.png', 'UTC');
        expect(await appendConversationJobMessage(sibling, target, 'second', {})).toEqual(second);
        const branch = readConversationStore().characters['nova.png'].branches.main;
        expect(branch.messages.map(item => item.id)).toEqual([...messages.map(item => item.id), 'later-input', first.id, second.id].slice(-250));
        expect(readConversationStore().reminders).toHaveLength(1);
        const edited = readConversationStore();
        edited.characters['nova.png'].branches.main.messages[0].mes = 'Edited before eviction';
        expect((await postJson('/store/save', { store: edited, version: readSettings()._version })).status).toBe(200);
        expect((await postJson('/message/append', { avatar: 'nova.png', version: readSettings()._version,
            message: { role: 'user', name: 'User', mes: 'Evicts the edited message' } })).status).toBe(200);
        await expect(appendConversationJobMessage(context, target, 'late', { role: 'character', name: 'Nova', mes: 'Must not save' })).rejects.toMatchObject({ status: 409 });
    });

    test('accepted replies use a saved profile and finish native bubbles and reminders after acceptance without another client request', async () => {
        const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
        const { getJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
        const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
        const created = await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', name: 'User', mes: 'Please reply' }] });
        expect(created.status).toBe(200);
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const input = { submissionKey: 'accepted-reply', target: { avatar: 'nova.png', branchId: 'main' }, timeZone: 'Asia/Manila' };
        const response = await postJson('/reply/submit', input);
        expect([response.status, await response.clone().text()]).toEqual([202, expect.any(String)]);
        const { job } = await response.json();
        expect(upstreamRequests).toHaveLength(0);
        const duplicate = await postJson('/reply/submit', input);
        expect(duplicate.status).toBe(200);
        expect((await duplicate.json()).job.id).toBe(job.id);
        expect(JSON.stringify(readArtifact(userDirectories, job.id, 'request'))).not.toContain('fixture-private-token');
        upstreamReplyText = 'First reply. [reminder: 1h | Saved reminder]\n\nSecond reply.';
        setDirectoriesResolver(() => userDirectories);
        const { reconcileConversationJob } = (await import('../src/generation/conversation-worker.js')).testExports;
        const runFamily = async rootId => {
            await runJob(getJob(userDirectories, rootId));
            for (const childId of getJob(userDirectories, rootId).children || []) await runJob(getJob(userDirectories, childId));
        };
        await runFamily(job.id);
        let root = getJob(userDirectories, job.id);
        expect(root.children).toHaveLength(1);
        expect(root.error).toBeNull();
        await reconcileConversationJob(userDirectories, root);
        root = getJob(userDirectories, job.id);
        expect(root.state).toBe('completed');
        expect(root.result.participants).toHaveLength(1);
        const branch = readConversationStore().characters['nova.png'].branches.main;
        expect(branch.messages.map(message => message.mes)).toEqual(['Please reply', 'First reply.', 'Second reply.']);
        expect(branch.unread).toBe(2);
        expect(Object.keys(branch.pendingPresentations)).toHaveLength(2);
        expect(readConversationStore().reminders).toHaveLength(1);
        expect(upstreamRequests).toHaveLength(1);
        // Model work and native effects survived, but the participant's final marker did not.
        const childId = root.children[0];
        writeArtifact(userDirectories, childId, 'result', null);
        const changed = readSettings();
        changed.extension_settings.connectionManager.profiles = [];
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(changed));
        updateJob(userDirectories, childId, { state: 'running', resume: 'delivery', recoverability: 'resumable' });
        recoverJobs(userDirectories);
        await runJob(getJob(userDirectories, childId));
        expect(getJob(userDirectories, childId).state).toBe('completed');
        await reconcileConversationJob(userDirectories, getJob(userDirectories, job.id));
        expect(getJob(userDirectories, job.id).state).toBe('completed');
        expect(upstreamRequests).toHaveLength(1);
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(3);
        expect(readConversationStore().reminders).toHaveLength(1);
    });

    test('an autonomous occurrence runs as a family and claims its bookkeeping once', async () => {
        const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
        const { getJob } = await import('../src/jobs/store.js');
        const { acceptConversationAutonomousReply } = await import('../src/generation/conversation-jobs.js');
        const { reconcileConversationJob } = (await import('../src/generation/conversation-worker.js')).testExports;
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', name: 'User', mes: 'Are you there?' }] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.idle_followup = true;
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.enabled = true;
        saved.extension_settings[CONVERSATION_STORE_KEY].automation = { mode: 'server', timeZone: 'UTC' };
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));

        const request = { user: { profile: { handle: userHandle }, directories: userDirectories } };
        const occurrence = {
            kind: 'idle-followup', key: 'conv-auto|idle|test', directive: '[System directive: ping.]',
            target: { avatar: 'nova.png', branchId: 'main' },
            participants: [{ avatar: 'nova.png', purpose: 'idle', extra: { conversation_mode_auto: true, idle_action: 'followup' } }],
            bookkeeping: { sessionMarkers: { sb_conv_last_idle_session_followup: '123' }, lastAutoMessageAt: 4242 },
        };
        upstreamReplyText = 'Autonomous hello.';
        const accepted = await acceptConversationAutonomousReply(request, occurrence);
        expect(accepted.created).toBe(true);
        expect(upstreamRequests).toHaveLength(0);
        const duplicate = await acceptConversationAutonomousReply(request, occurrence);
        expect(duplicate.created).toBe(false);
        expect(duplicate.job.id).toBe(accepted.job.id);

        setDirectoriesResolver(() => userDirectories);
        await runJob(getJob(userDirectories, accepted.job.id));
        for (const childId of getJob(userDirectories, accepted.job.id).children || []) await runJob(getJob(userDirectories, childId));
        await reconcileConversationJob(userDirectories, getJob(userDirectories, accepted.job.id));
        expect(getJob(userDirectories, accepted.job.id).state).toBe('completed');
        expect(upstreamRequests).toHaveLength(1);
        const branch = readConversationStore().characters['nova.png'].branches.main;
        expect(branch.messages.map(message => message.role)).toEqual(['user', 'character']);
        expect(branch.messages[1].extra.conversation_mode_auto).toBe(true);
        expect(branch.sessionMarkers.sb_conv_last_idle_session_followup).toBe('123');
        expect(branch.lastAutoMessageAt).toBe(4242);
        const { mutateJobs } = await import('../src/jobs/store.js');
        mutateJobs(userDirectories, store => { store.jobs = {}; });
        await expect(acceptConversationAutonomousReply(request, occurrence)).rejects.toThrow('already ran');
        expect(upstreamRequests).toHaveLength(1);
    });

    test('ownership capture migrates every legacy branch and validates its saved-settings acknowledgement', async () => {
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'character', mes: 'Read' }, { role: 'character', mes: 'Unread' }] });
        const saved = readSettings();
        const branch = saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main;
        delete branch.readThrough;
        delete branch.messageContentHash;
        delete branch.messageEditRevision;
        branch.unread = 1;
        branch.messages.forEach(message => { delete message.id; });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const body = { mode: 'server', timeZone: 'Asia/Manila', version: saved._version,
            acknowledgement: { account: userHandle, settingsRevision: saved._settingsRevision || 0 } };
        const invalid = await postJson('/automation/configure', { ...body, acknowledgement: { ...body.acknowledgement, settingsRevision: 999 } });
        expect(invalid.status).toBe(409);
        expect((await invalid.json()).error).toBe('active_settings_ack_stale');
        expect((await postJson('/automation/configure', { ...body, acknowledgement: { ...body.acknowledgement, account: 'someone-else' } })).status).toBe(409);
        expect((await postJson('/automation/configure', { ...body, acknowledgement: [] })).status).toBe(400);
        const configured = await postJson('/automation/configure', body);
        expect(configured.status).toBe(200);
        expect((await configured.json()).migratedBranches).toBe(1);
        const result = readConversationStore();
        expect(result.automation).toMatchObject({ mode: 'server', timeZone: 'Asia/Manila', acknowledgement: body.acknowledgement });
        const migrated = result.characters['nova.png'].branches.main;
        expect(migrated.messages.map(message => message.mes)).toEqual(['Read', 'Unread']);
        expect(migrated.unread).toBe(1);
        expect(migrated.readThrough).toBe(migrated.messages[0].id);
    });

    test('automatic active connections use the persisted acknowledgement and reject stale revisions', async () => {
        const { acceptConversationAutonomousReply } = await import('../src/generation/conversation-jobs.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', mes: 'Hello' }] });
        const saved = readSettings();
        saved.main_api = 'openai';
        saved._settingsRevision = 4;
        saved.active_generation = { api: 'openai', source: 'custom', model: 'active-fixture' };
        saved.oai_settings = { chat_completion_source: 'custom', custom_url: upstreamUrl, custom_model: 'active-fixture', stream_openai: false };
        saved.extension_settings[CONVERSATION_STORE_KEY].automation = { mode: 'server', timeZone: 'UTC', acknowledgement: { account: userHandle, settingsRevision: 4 } };
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.idle_followup = true;
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.enabled = true;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const occurrence = { kind: 'idle-followup', key: 'active-auto', directive: '[System directive: ping.]',
            target: { avatar: 'nova.png', branchId: 'main' }, participants: [{ avatar: 'nova.png' }] };
        const request = { user: { profile: { handle: userHandle }, directories: userDirectories } };
        const accepted = await acceptConversationAutonomousReply(request, occurrence);
        expect(accepted.job.config.participantBindings['nova.png'].kind).toBe('active');
        const changed = readSettings();
        changed._settingsRevision = 5;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(changed));
        await expect(acceptConversationAutonomousReply(request, { ...occurrence, key: 'stale-active-auto' })).rejects.toThrow(/acknowledged|changed|stale/i);
    });

    test('ownership backfills old failed reminders, send chimes and persona-specific summaries before ledger pruning', async () => {
        const { acceptJob, updateJob, listJobs, mutateJobs } = await import('../src/jobs/store.js');
        const { writeArtifact } = await import('../src/jobs/artifacts.js');
        const { backfillConversationAutomaticAcceptances, wasConversationAutomaticOccurrenceAccepted } = await import('../src/generation/conversation-effects.js');
        const { getConversationOccurrenceKey, conversationChimeOccurrenceKey, getConversationSummarySubmissionKey, selectConversationReminder } = await import('../src/generation/conversation-auto-policy.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', mes: 'Hello' }] });
        const target = { avatar: 'nova.png', personaId: '', groupId: '', branchId: 'main' };
        const oldKey = getConversationOccurrenceKey({ owner: '', target, kind: 'reminder', basis: ['legacy-reminder', 100, 0] });
        const reminder = acceptJob(userDirectories, { owner: userHandle, type: 'conversation.reply', submissionKey: oldKey,
            intent: { mode: 'auto', target, automation: { kind: 'reminder' }, plan: [{ extra: { reminder_id: 'legacy-reminder' } }] } }).job;
        updateJob(userDirectories, reminder.id, { state: 'failed' });
        const send = acceptJob(userDirectories, { owner: userHandle, type: 'conversation.reply', submissionKey: 'legacy-send', intent: { mode: 'send', target } }).job;
        writeArtifact(userDirectories, send.id, 'request', { target, participants: [{ purpose: 'chime', automation: { patch: { sessionMarkers: { sb_conv_last_chime_session_solo: '42' } } } }] });
        updateJob(userDirectories, send.id, { state: 'cancelled' });
        const summary = acceptJob(userDirectories, { owner: userHandle, type: 'conversation.summary', automatic: true,
            submissionKey: 'summary:nova.png::main:m1', intent: { target } }).job;
        writeArtifact(userDirectories, summary.id, 'request', { throughId: 'm1' });
        updateJob(userDirectories, summary.id, { state: 'completed' });
        await backfillConversationAutomaticAcceptances({ user: { profile: { handle: userHandle }, directories: userDirectories } }, listJobs(userDirectories, { owner: userHandle, includeDismissed: true }));
        mutateJobs(userDirectories, store => { store.jobs = {}; });
        const store = readConversationStore();
        const taken = key => wasConversationAutomaticOccurrenceAccepted(store, key);
        const legacy = { id: 'legacy-reminder', personaId: '', triggerAt: 100, text: 'Do not repeat', target: { target: { ...target, branchId: 'other' }, settings: { enabled: true } } };
        expect(selectConversationReminder({ reminders: [legacy], taken, now: 200 })).toBeNull();
        expect(taken(conversationChimeOccurrenceKey(target, '42'))).toBe(true);
        expect(taken(getConversationSummarySubmissionKey(target, 'm1'))).toBe(true);
        expect(taken(getConversationSummarySubmissionKey({ ...target, personaId: 'another-persona' }, 'm1'))).toBe(false);
        expect(upstreamRequests).toHaveLength(0);
    });

    test('ownership preserves empty historical messages through HTTP saves and acknowledges long valid IDs', async () => {
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'character', mes: 'Unread' }] });
        const saved = readSettings();
        const branch = saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main;
        branch.messages = [{ id: 'empty-legacy', role: 'system', mes: '' }, { id: 'x'.repeat(300), role: 'character', mes: 'Unread' }];
        branch.readThrough = 'empty-legacy'; branch.unread = 1;
        delete branch.messageContentHash; delete branch.messageEditRevision;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const current = await (await postJson('/store/get', {})).json();
        expect((await postJson('/store/save', current)).status).toBe(200);
        const acknowledged = await postJson('/presentation/claim', { target: { avatar: 'nova.png', branchId: 'main', createdAt: branch.createdAt }, messageIds: [], readThrough: 'x'.repeat(300) });
        expect(acknowledged.status).toBe(200);
        expect((await acknowledged.json()).unread).toBe(0);
        const next = await (await postJson('/store/get', {})).json();
        next.store.characters['nova.png'].branches.main.messages.push({ id: 'new-empty', role: 'system', mes: '' });
        expect((await postJson('/store/save', next)).status).toBe(400);
    });

    test('a composer send appends its user messages natively before any provider call and is idempotent', async () => {
        const { getJob, updateJob } = await import('../src/jobs/store.js');
        const { readArtifact } = await import('../src/jobs/artifacts.js');
        const { runConversationWorkerTick } = await import('../src/generation/conversation-worker.js');
        const tick = () => runConversationWorkerTick({ directoriesFor: () => userDirectories, owners: [userHandle], now: Date.now() + 60000 });
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', name: 'User', mes: 'First' }] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));

        const input = { submissionKey: 'composer-send-1', mode: 'send', target: { avatar: 'nova.png', branchId: 'main' }, timeZone: 'Asia/Manila',
            messages: [{ role: 'user', mes: 'Second', extra: { files: [{ name: 'notes.txt', url: '/user/files/notes.txt' }] } }] };
        const response = await postJson('/reply/submit', input);
        expect(response.status).toBe(202);
        const accepted = await response.json();
        expect(accepted).toMatchObject({ created: true, inputDurable: true, job: { state: 'waiting', stage: 'preparing' } });
        expect(accepted.userMessageIds).toHaveLength(1);
        expect(upstreamRequests).toHaveLength(0);
        const branch = readConversationStore().characters['nova.png'].branches.main;
        expect(branch.messages.map(message => message.mes)).toEqual(['First', 'Second']);
        expect(branch.messages[1]).toMatchObject({ id: accepted.userMessageIds[0], role: 'user', extra: { files: [{ name: 'notes.txt' }] } });
        // The batch stays open for its coalescing window: no snapshot, no dispatch.
        expect(readArtifact(userDirectories, accepted.job.id, 'request')).toBeUndefined();

        const duplicate = await postJson('/reply/submit', input);
        expect(duplicate.status).toBe(200);
        expect((await duplicate.json()).job.id).toBe(accepted.job.id);
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(2);

        const changed = await postJson('/reply/submit', { ...input, messages: [{ role: 'user', mes: 'Different' }] });
        expect(changed.status).toBe(409);

        // A later message joins the open batch instead of starting a second request.
        const memberInput = { ...input, submissionKey: 'composer-send-1b', messages: [{ role: 'user', mes: 'Third', extra: { a: 1, b: 2 } }] };
        const joined = await postJson('/reply/submit', memberInput);
        expect(joined.status).toBe(200);
        const joinedJson = await joined.json();
        expect(joinedJson).toMatchObject({ created: false, inputDurable: true, job: { id: accepted.job.id } });
        expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes)).toEqual(['First', 'Second', 'Third']);

        for (const patch of [{ target: { ...input.target, avatar: 'other.png' } }, { target: { ...input.target, branchId: 'side' } },
            { target: { ...input.target, groupId: 'other' } }, { target: { ...input.target, personaId: 'other' } },
            { mode: 'reply' }, { force: true }, { directive: 'Different instructions' }, { timeZone: 'UTC' }, { branchCreatedAt: 'other' }]) {
            expect((await postJson('/reply/submit', { ...memberInput, ...patch })).status).toBe(409);
        }
        const replay = await postJson('/reply/submit', { ...memberInput, messages: [{ mes: 'Third', extra: { b: 2, a: 1 } }] });
        expect(replay.status).toBe(200);
        expect((await replay.json()).userMessageIds).toEqual(joinedJson.userMessageIds);
        const beforeLegacy = getJob(userDirectories, accepted.job.id).coalesce.members;
        updateJob(userDirectories, accepted.job.id, job => ({ coalesce: { ...job.coalesce, members: job.coalesce.members.map(({ intentFingerprint: _fingerprint, ...member }) => member) } }));
        expect((await postJson('/reply/submit', { ...memberInput, target: { ...input.target, avatar: 'other.png' } })).status).toBe(409);
        expect((await postJson('/reply/submit', memberInput)).status).toBe(409);
        updateJob(userDirectories, accepted.job.id, job => ({ coalesce: { ...job.coalesce, members: beforeLegacy } }));
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(3);

        // A crash between input append and snapshot/release leaves a paused job;
        // the same submission repairs it without duplicating the message.
        updateJob(userDirectories, accepted.job.id, { state: 'waiting', stage: 'preparing', resume: null });
        const repaired = await postJson('/reply/submit', input);
        expect(repaired.status).toBe(200);
        const repairedJson = await repaired.json();
        expect(repairedJson.job.id).toBe(accepted.job.id);
        expect(repairedJson.userMessageIds).toEqual(accepted.userMessageIds);
        expect(getJob(userDirectories, accepted.job.id).state).toBe('waiting');
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(3);

        // Closing the window freezes the batch into one request and releases it.
        await tick();
        expect(getJob(userDirectories, accepted.job.id).state).toBe('queued');
        const artifact = readArtifact(userDirectories, accepted.job.id, 'request');
        expect(artifact).toMatchObject({ userName: 'User' });
        expect(JSON.stringify(artifact)).toContain('Third');
        expect(JSON.stringify(artifact)).not.toContain('fixture-private-token');
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(3);

        const rejected = await postJson('/reply/submit', { ...input, submissionKey: 'composer-send-2', messages: [{ role: 'system', mes: 'No' }] });
        expect(rejected.status).toBe(400);
    });

    test.each([true, false])('a submission cannot be repaired into a replaced branch (browser anchor: %s)', async (withAnchor) => {
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [{ role: 'user', name: 'User', mes: 'First' }] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const branchCreatedAt = readConversationStore().characters['nova.png'].branches.main.createdAt;

        const input = { submissionKey: 'reset-send-1', mode: 'send', target: { avatar: 'nova.png', branchId: 'main' }, ...(withAnchor ? { branchCreatedAt } : {}),
            messages: [{ role: 'user', mes: 'Second' }] };
        const response = await postJson('/reply/submit', input);
        expect(response.status).toBe(202);
        const original = (await response.json()).job;
        expect(original.target.createdAt).toBe(branchCreatedAt);

        // Replace the branch identity: same key, new createdAt.
        const reset = readSettings();
        reset.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main.createdAt = 'replaced';
        reset.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main.messages = [];
        expect((await postJson('/store/save', { store: reset.extension_settings[CONVERSATION_STORE_KEY], version: reset._version })).status).toBe(200);

        const retry = await postJson('/reply/submit', input);
        expect(retry.status).toBe(409);
        expect(readConversationStore().characters['nova.png'].branches.main.messages).toHaveLength(0);
        const fresh = await postJson('/reply/submit', { ...input, submissionKey: 'replacement-send', branchCreatedAt: 'replaced' });
        expect(fresh.status).toBe(202);
        expect((await fresh.json()).job.id).not.toBe(original.id);
        expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes)).toEqual(['Second']);
        const { finalizeConversationSubmission } = await import('../src/generation/conversation-jobs.js');
        const failed = await finalizeConversationSubmission({ user: { directories: userDirectories, profile: { handle: userHandle } } }, original);
        expect(failed.state).toBe('failed');
        expect(upstreamRequests).toHaveLength(0);
    });

    /* eslint-disable jest/no-conditional-expect -- Each named repair scenario has a different required outcome. */
    test.each(['partial', 'trigger-edit', 'target-delete', 'legacy', 'cancel'])('incomplete batch repair respects its own anchors and progress: %s', async (scenario) => {
        const { getJob, updateJob, requestCancellation } = await import('../src/jobs/store.js');
        const { readArtifact } = await import('../src/jobs/artifacts.js');
        const { finalizeConversationSubmission } = await import('../src/generation/conversation-jobs.js');
        const { captureConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
        const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [
            { id: 'trigger', role: 'user', name: 'User', mes: 'Original trigger' },
            { id: 'reply', role: 'character', name: 'Nova', mes: 'Original reply' },
        ] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const branch = readConversationStore().characters['nova.png'].branches.main;
        const anchors = { branchCreatedAt: branch.createdAt,
            triggers: [{ messageId: 'trigger', revision: getConversationMessageRevision(branch.messages[0]) }],
            replyTarget: { messageId: 'reply', revision: getConversationMessageRevision(branch.messages[1]) } };
        const response = await postJson('/reply/submit', { submissionKey: 'repair-leader', mode: 'send', target: { avatar: 'nova.png', branchId: 'main' }, messages: [{ mes: 'Leader input' }] });
        expect(response.status).toBe(202);
        const { job } = await response.json();
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const member = { key: 'repair-member', anchors, messages: [{ mes: 'Member one', extra: {} }, { mes: 'Member two', extra: {} }], userMessageIds: [] };
        if (scenario === 'partial') {
            const target = captureConversationTarget(request, job.intent.target);
            const tag = createHash('sha256').update(JSON.stringify(member.key)).digest('hex').slice(0, 12);
            const first = await appendConversationJobMessage({ owner: userHandle, directories: userDirectories, job, signal: { throwIfAborted() {} } }, target, `input:${tag}:0`, { role: 'user', name: 'User', mes: 'Member one', extra: { conversation_mode_user: true } });
            member.userMessageIds = [first.id];
        }
        if (scenario === 'legacy') delete member.anchors;
        updateJob(userDirectories, job.id, current => ({ coalesce: { ...current.coalesce, members: [member] } }));
        if (scenario === 'trigger-edit' || scenario === 'target-delete') {
            const current = readSettings();
            const messages = current.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches.main.messages;
            if (scenario === 'trigger-edit') messages[0].mes = 'Edited trigger';
            else messages.splice(1, 1);
            expect((await postJson('/store/save', { store: current.extension_settings[CONVERSATION_STORE_KEY], version: current._version })).status).toBe(200);
        }
        if (scenario === 'cancel') requestCancellation(userDirectories, job.id);
        const before = readConversationStore();
        await finalizeConversationSubmission(request, getJob(userDirectories, job.id));
        const result = getJob(userDirectories, job.id);
        if (scenario === 'partial') {
            expect(result.state).toBe('queued');
            expect(result.coalesce.members[0].userMessageIds).toHaveLength(2);
            expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes)).toEqual(['Original trigger', 'Original reply', 'Leader input', 'Member one', 'Member two']);
            expect(JSON.stringify(readArtifact(userDirectories, job.id, 'request'))).toContain('Member two');
        } else {
            expect(result.state).toBe(scenario === 'cancel' ? 'cancelled' : 'failed');
            expect(readConversationStore()).toEqual(before);
            expect(readArtifact(userDirectories, job.id, 'request')).toBeUndefined();
        }
        expect(upstreamRequests).toHaveLength(0);
    });
    /* eslint-enable jest/no-conditional-expect */

    test('a send on a different saved profile does not join an open batch', async () => {
        const { getJob, updateJob } = await import('../src/jobs/store.js');
        const { readArtifact } = await import('../src/jobs/artifacts.js');
        const { finalizeConversationSubmission } = await import('../src/generation/conversation-jobs.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }, { id: 'other', api: 'openai', model: 'gpt-4o' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const target = { avatar: 'nova.png', branchId: 'main' };

        const first = await postJson('/reply/submit', { submissionKey: 'batch-a', mode: 'send', target, messages: [{ role: 'user', mes: 'One' }] });
        expect(first.status).toBe(202);
        const firstJob = (await first.json()).job.id;

        const switched = readSettings();
        switched.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'other';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(switched));

        const second = await postJson('/reply/submit', { submissionKey: 'batch-b', mode: 'send', target, messages: [{ role: 'user', mes: 'Two' }] });
        expect(second.status).toBe(202);
        const secondJob = (await second.json()).job.id;
        expect(secondJob).not.toBe(firstJob);
        expect(getJob(userDirectories, secondJob).credentialRef.profileId).toBe('other');
        expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes)).toEqual(['One', 'Two']);
        const request = { user: { profile: { handle: userHandle }, directories: userDirectories } };
        await finalizeConversationSubmission(request, getJob(userDirectories, firstJob));
        expect(getJob(userDirectories, firstJob).state).toBe('queued');
        expect(readArtifact(userDirectories, firstJob, 'request').binding.profileId).toBe('saved');
        const changed = readSettings();
        changed.extension_settings.connectionManager.profiles[1].model = 'changed-after-acceptance';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(changed));
        await finalizeConversationSubmission(request, getJob(userDirectories, secondJob));
        expect(getJob(userDirectories, secondJob).state).toBe('failed');
        expect(readArtifact(userDirectories, secondJob, 'request')).toBeUndefined();
        const replay = await postJson('/reply/submit', { submissionKey: 'batch-b', mode: 'send', target, messages: [{ role: 'user', mes: 'Two' }] });
        expect(replay.status).toBe(200);
        expect((await replay.json()).job.id).toBe(secondJob);
        const third = await postJson('/reply/submit', { submissionKey: 'legacy-binding', mode: 'send', target, messages: [{ role: 'user', mes: 'Kept legacy input' }] });
        const thirdJob = (await third.json()).job.id;
        updateJob(userDirectories, thirdJob, { config: {} });
        for (const deadline of [0, Date.now() + 5000]) {
            updateJob(userDirectories, thirdJob, job => ({ inputDurable: false, coalesce: { ...job.coalesce, deadline } }));
            const fresh = await postJson('/reply/submit', { submissionKey: `after-legacy-${deadline}`, mode: 'send', target, messages: [{ role: 'user', mes: 'Fresh input' }] });
            expect(fresh.status).toBe(202);
            const freshJob = (await fresh.json()).job.id;
            expect(freshJob).not.toBe(thirdJob);
            expect(getJob(userDirectories, thirdJob).state).toBe('waiting');
            updateJob(userDirectories, freshJob, { state: 'cancelled' });
        }
        await finalizeConversationSubmission(request, getJob(userDirectories, thirdJob));
        expect(getJob(userDirectories, thirdJob).state).toBe('failed');
        expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes)).toEqual(['One', 'Two', 'Kept legacy input', 'Fresh input', 'Fresh input']);
        expect(upstreamRequests).toHaveLength(0);
    });

    test('pre-chime accepted sends keep their host-only binding and cannot absorb new chime-capable sends', async () => {
        const { getJob, updateJob } = await import('../src/jobs/store.js');
        const { readArtifact } = await import('../src/jobs/artifacts.js');
        const { write } = await import('../src/character-card-parser.js');
        const { finalizeConversationSubmission } = await import('../src/generation/conversation-jobs.js');
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
        fs.mkdirSync(userDirectories.characters, { recursive: true });
        fs.writeFileSync(path.join(userDirectories.characters, 'kit.png'), write(png, JSON.stringify({ name: 'Kit' })));
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        Object.assign(saved.extension_settings[CONVERSATION_STORE_KEY].settings, { connection_profile: 'saved', multi_char_names: 'kit.png' });
        Object.assign(saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings, { connection_profile: 'saved', multi_char_names: 'kit.png', availability: 'online' });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const input = { mode: 'send', target: { avatar: 'nova.png', branchId: 'main' }, messages: [{ mes: '@Kit, please answer.' }] };
        const accepted = await postJson('/reply/submit', { ...input, submissionKey: 'pre-chime' });
        expect(accepted.status).toBe(202);
        const old = (await accepted.json()).job;
        updateJob(userDirectories, old.id, { config: { participantBindings: { 'nova.png': old.config.participantBindings['nova.png'] } } });
        const next = await postJson('/reply/submit', { ...input, submissionKey: 'with-chimes' });
        expect(next.status).toBe(202);
        expect((await next.json()).job.id).not.toBe(old.id);
        await finalizeConversationSubmission({ user: { profile: { handle: userHandle }, directories: userDirectories } }, getJob(userDirectories, old.id));
        expect(getJob(userDirectories, old.id).state).toBe('queued');
        expect(readArtifact(userDirectories, old.id, 'request').participants.map(participant => participant.speaker.avatar)).toEqual(['nova.png']);
        expect(upstreamRequests).toHaveLength(0);
    });

    test('a reply validates its captured triggers, reply target and branch before accepting', async () => {
        const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');
        const { getJob } = await import('../src/jobs/store.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [
            { id: 'u1', role: 'user', name: 'User', mes: 'One' },
            { id: 'c1', role: 'character', name: 'Nova', mes: 'Two' },
            { id: 'u2', role: 'user', name: 'User', mes: 'Three' },
        ] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));

        const branch = readConversationStore().characters['nova.png'].branches.main;
        const byId = Object.fromEntries(branch.messages.map(message => [message.id, message]));
        const target = { avatar: 'nova.png', branchId: 'main' };
        const base = {
            submissionKey: 'anchored-reply', mode: 'reply', target,
            branchCreatedAt: String(branch.createdAt),
            triggers: [{ messageId: 'u2', revision: getConversationMessageRevision(byId.u2) }],
            replyTarget: { messageId: 'c1', revision: getConversationMessageRevision(byId.c1) },
        };
        const accepted = await postJson('/reply/submit', base);
        expect(accepted.status).toBe(202);
        const acceptedJob = (await accepted.json()).job;
        expect(getJob(userDirectories, acceptedJob.id).intent.anchors).toMatchObject({
            branchCreatedAt: String(branch.createdAt),
            replyTarget: { messageId: 'c1', revision: getConversationMessageRevision(byId.c1) },
        });

        const staleTrigger = await postJson('/reply/submit', { ...base, submissionKey: 'anchored-reply-stale',
            triggers: [{ messageId: 'u2', revision: 'stale' }] });
        expect(staleTrigger.status).toBe(409);
        const missingTrigger = await postJson('/reply/submit', { ...base, submissionKey: 'anchored-reply-missing',
            triggers: [{ messageId: 'gone', revision: 'anything' }] });
        expect(missingTrigger.status).toBe(409);
        const userTarget = await postJson('/reply/submit', { ...base, submissionKey: 'anchored-reply-user',
            replyTarget: { messageId: 'u2', revision: getConversationMessageRevision(byId.u2) } });
        expect(userTarget.status).toBe(409);
        const staleTarget = await postJson('/reply/submit', { ...base, submissionKey: 'anchored-reply-target-stale',
            replyTarget: { messageId: 'c1', revision: 'stale' } });
        expect(staleTarget.status).toBe(409);
        const replaced = await postJson('/reply/submit', { ...base, submissionKey: 'anchored-reply-replaced',
            branchCreatedAt: 'someone-elses-branch' });
        expect(replaced.status).toBe(409);
    });

    test('a solo thread accepts a reply target naming a partner who already spoke', async () => {
        const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [
            { id: 'u1', role: 'user', name: 'User', mes: 'Hello' },
            { id: 'p1', role: 'partner', name: 'Kit', mes: 'Hi there', extra: { partner_avatar: 'kit.png' } },
        ] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const branch = readConversationStore().characters['nova.png'].branches.main;
        const byId = Object.fromEntries(branch.messages.map(message => [message.id, message]));
        const target = { avatar: 'nova.png', branchId: 'main' };
        const accepted = await postJson('/reply/submit', { submissionKey: 'solo-partner-reply', mode: 'reply', target,
            branchCreatedAt: String(branch.createdAt),
            triggers: [{ messageId: 'u1', revision: getConversationMessageRevision(byId.u1) }],
            replyTarget: { messageId: 'p1', revision: getConversationMessageRevision(byId.p1) } });
        expect(accepted.status).toBe(202);
        expect(Object.keys((await accepted.json()).job.config.participantBindings)).toEqual(['kit.png']);
    });

    test('a send with a different explicit reply target does not join an open batch', async () => {
        const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');
        const { getJob } = await import('../src/jobs/store.js');
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [
            { id: 'c1', role: 'character', name: 'Nova', mes: 'One' },
            { id: 'c2', role: 'character', name: 'Nova', mes: 'Two' },
        ] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const byId = Object.fromEntries(readConversationStore().characters['nova.png'].branches.main.messages.map(message => [message.id, message]));
        const target = { avatar: 'nova.png', branchId: 'main' };
        const first = await postJson('/reply/submit', { submissionKey: 'target-a', mode: 'send', target,
            messages: [{ role: 'user', mes: 'First' }],
            replyTarget: { messageId: 'c1', revision: getConversationMessageRevision(byId.c1) } });
        expect(first.status).toBe(202);
        const firstJob = (await first.json()).job.id;
        const second = await postJson('/reply/submit', { submissionKey: 'target-b', mode: 'send', target,
            messages: [{ role: 'user', mes: 'Second' }],
            replyTarget: { messageId: 'c2', revision: getConversationMessageRevision(byId.c2) } });
        expect(second.status).toBe(202);
        expect((await second.json()).job.id).not.toBe(firstJob);
        expect(getJob(userDirectories, firstJob).coalesce.members).toHaveLength(0);
    });

    test('a later accepted send does not invalidate an earlier accepted reply', async () => {
        const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');
        const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
        const { getJob } = await import('../src/jobs/store.js');
        const { reconcileConversationJob } = (await import('../src/generation/conversation-worker.js')).testExports;
        await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages: [
            { id: 'u1', role: 'user', name: 'User', mes: 'Please reply' },
        ] });
        const saved = readSettings();
        saved.extension_settings.connectionManager = { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', proxy: 'fixture' }] };
        saved.proxies = [{ name: 'fixture', url: upstreamUrl.replace(/\/$/, ''), password: 'fixture-private-token' }];
        saved.oai_settings = { chat_completion_source: 'openai', temp_openai: 0.2, top_p_openai: 1, n: 1 };
        saved.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = 'saved';
        saved.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].settings.connection_profile = 'saved';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(saved));
        const branch = readConversationStore().characters['nova.png'].branches.main;
        const trigger = branch.messages.find(message => message.id === 'u1');
        const target = { avatar: 'nova.png', branchId: 'main' };
        const reply = await postJson('/reply/submit', { submissionKey: 'append-reply', mode: 'reply', target,
            branchCreatedAt: String(branch.createdAt),
            triggers: [{ messageId: 'u1', revision: getConversationMessageRevision(trigger) }] });
        expect(reply.status).toBe(202);
        const replyJob = (await reply.json()).job.id;

        // A second composer send lands while the reply is still queued.
        const send = await postJson('/reply/submit', { submissionKey: 'append-send', mode: 'send', target,
            messages: [{ role: 'user', mes: 'One more thing' }] });
        expect(send.status).toBe(202);

        upstreamReplyText = 'Answer.';
        setDirectoriesResolver(() => userDirectories);
        await runJob(getJob(userDirectories, replyJob));
        for (const childId of getJob(userDirectories, replyJob).children || []) await runJob(getJob(userDirectories, childId));
        const child = getJob(userDirectories, getJob(userDirectories, replyJob).children[0]);
        expect(child.state).toBe('completed');
        await reconcileConversationJob(userDirectories, getJob(userDirectories, replyJob));
        expect(readConversationStore().characters['nova.png'].branches.main.messages.map(message => message.mes))
            .toEqual(['Please reply', 'One more thing', 'Answer.']);
    });

    test('info describes browser-primary and curl-capable REST paths', async () => {
        const response = await postJson('/info', {});

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.primaryPath).toMatchObject({
            type: 'browser-client',
            usesRestApiAsPrimaryDriver: true,
        });
        expect(json.primaryPath.flow.map(step => step.function)).toEqual(expect.arrayContaining([
            'submitConversationInput',
            'submitAcceptedSend',
            'acceptConversationSubmission',
            'runConversationParticipantJob',
            'observeNativeConversationJob',
        ]));
        expect(json.primaryPath.flow.find(step => step.step === 'durable-accept')?.file)
            .toBe('src/generation/conversation-jobs.js');
        const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
        expect(json.primaryPath.flow.every(step => fs.existsSync(path.join(repositoryRoot, step.file)))).toBe(true);
        expect(json.restPath).toMatchObject({
            type: 'json-rest',
            curlDriven: true,
            basePath: '/api/neconyan-conversation',
        });
        expect(json.restPath.endpoints.map(endpoint => endpoint.path)).toEqual(expect.arrayContaining([
            '/info',
            '/store/get',
            '/message/send',
        ]));
        expect(json.caveats.join(' ')).toContain('server worker');
        expect(json.caveats.join(' ')).toContain('Bracket commands are extracted');
    });

    test('store/get returns the current Conversation Mode store shape', async () => {
        const response = await postJson('/store/get', {});

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(0);
        expect(json.store).toMatchObject({
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {},
            groups: [],
            reminders: [],
        });
        expect(readSettings().extension_settings[CONVERSATION_STORE_KEY]).toBeUndefined();
    });

    test('thread/get create persists a versioned thread atomically', async () => {
        const missingVersionResponse = await postJson('/thread/get', { avatar: 'nova.png', create: true });
        expect(missingVersionResponse.status).toBe(400);
        await expect(missingVersionResponse.json()).resolves.toEqual({ error: 'version_required' });

        const response = await postJson('/thread/get', {
            avatar: 'nova.png',
            create: true,
            version: 0,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.thread.activeBranchId).toBe(DEFAULT_BRANCH_ID);
        expect(readSettings()._version).toBe(1);
        expect(readConversationStore().characters['nova.png']).toBeTruthy();
    });

    test('group/create persists Conversation-owned groups without creating roleplay group files', async () => {
        const createResponse = await postJson('/group/create', {
            name: 'Nova and Echo',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });

        expect(createResponse.status).toBe(200);
        const createJson = await createResponse.json();
        expect(createJson.version).toBe(1);
        expect(createJson.group).toMatchObject({
            name: 'Nova and Echo',
            members: ['nova.png', 'echo.png'],
            is_conversation_group: true,
            conversation_settings: {
                multi_char: true,
                auto_character_chat: true,
            },
        });
        expect(fs.readdirSync(userDirectories.groups)).toEqual([]);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: createJson.group.id,
            text: 'group-only hello',
            version: 1,
        });

        expect(appendResponse.status).toBe(200);
        const appendJson = await appendResponse.json();
        expect(appendJson.version).toBe(2);
        expect(appendJson.threadKey).toBe(`group:${createJson.group.id}:nova.png`);

        const store = readConversationStore();
        expect(store.groups).toHaveLength(1);
        expect(store.groups[0].id).toBe(createJson.group.id);
        expect(store.characters[`group:${createJson.group.id}:nova.png`].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('group-only hello');
        expect(fs.readdirSync(userDirectories.groups)).toEqual([]);
    });

    test('message/send adds group reference context for unnamed replies', async () => {
        upstreamReplyText = 'I was talking about the keys.';

        const createResponse = await postJson('/group/create', {
            name: 'Alhaitham and Kaveh',
            members: ['alhaitham.png', 'Kaveh.png', 'Cyno.png'],
            version: 0,
        });
        const createJson = await createResponse.json();

        const saveResponse = await postJson('/thread/save', {
            avatar: 'alhaitham.png',
            groupId: createJson.group.id,
            version: 1,
            messages: [{
                role: 'partner',
                name: 'Kaveh',
                mes: 'I hid the keys.',
                extra: { partner_avatar: 'kaveh.png' },
            }],
        });
        expect(saveResponse.status).toBe(200);

        const sendResponse = await postJson('/message/send', {
            avatar: 'alhaitham.png',
            groupId: createJson.group.id,
            text: 'why did you do that?',
            userName: 'Riley',
            version: 2,
            character: { data: { name: 'Alhaitham' } },
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: upstreamUrl,
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    temperature: 1,
                    top_p: 1,
                    max_tokens: 64,
                },
            },
            includePrompt: true,
        });

        expect(sendResponse.status).toBe(200);
        const sendJson = await sendResponse.json();
        const contextMessage = sendJson.prompt.messages.find(message => message.identifier === 'conversation-group-reference-context');
        expect(contextMessage).toBeTruthy();
        expect(contextMessage.content).toContain('Latest user message: why did you do that?');
        expect(contextMessage.content).toContain('most likely addresses Kaveh');
        expect(contextMessage.content).toContain('do not assume every you means Alhaitham');
        expect(sendJson.prompt.systemPrompt).toContain('Active group participants:');
        expect(sendJson.prompt.systemPrompt).toContain('Alhaitham');
        expect(sendJson.prompt.systemPrompt).toContain('Kaveh');
        expect(sendJson.prompt.systemPrompt).toContain('Cyno');
        expect(JSON.stringify(upstreamRequests[0])).toContain('Group DM reference context');
    });

    test('group participant prompts dedupe and cap large authorized groups while retaining the current speaker', async () => {
        const groupId = 'large-legacy-group';
        const members = [
            ...Array.from({ length: 80 }, (_, index) => `Member-${index}.png`),
            'Member-0.png',
            'Member-1.png',
            'Speaker.png',
        ];
        fs.writeFileSync(path.join(userDirectories.groups, `${groupId}.json`), JSON.stringify({
            id: groupId,
            members,
            disabled_members: [],
        }));

        const response = await postJson('/message/send', {
            avatar: 'Speaker.png',
            groupId,
            text: 'Hello large group',
            version: 0,
            character: { name: 'Current Speaker' },
            generation: getChatGeneration(),
            includePrompt: true,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        const participantLine = json.prompt.systemPrompt
            .split('\n')
            .find(line => line.startsWith('Active group participants:'));
        const participantNames = participantLine
            .replace(/^Active group participants:\s*/, '')
            .replace(/\.$/, '')
            .split(', ');
        expect(participantNames).toContain('Current Speaker');
        expect(participantNames).toHaveLength(32);
        expect(new Set(participantNames.map(name => name.toLowerCase())).size).toBe(participantNames.length);
        expect(participantNames.join(', ').length).toBeLessThanOrEqual(2048);
    });

    test('message/append persists a user message in the existing settings schema', async () => {
        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'hello from curl',
            userName: 'Riley',
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.threadKey).toBe('nova.png');
        expect(json.message).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'hello from curl',
        });

        const settings = readSettings();
        expect(settings._version).toBe(1);
        const branch = settings.extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png']
            .branches[DEFAULT_BRANCH_ID];
        expect(branch.messages).toHaveLength(1);
        expect(branch.preview).toBe('hello from curl');
    });

    test('conversation writes preserve unrelated current settings', async () => {
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            theme: 'keep-me',
            extension_settings: {
                unrelated_extension: { enabled: true },
            },
        }, null, 4));

        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'conversation-only mutation',
            version: 0,
        });
        expect(response.status).toBe(200);

        const settings = readSettings();
        expect(settings.theme).toBe('keep-me');
        expect(settings.extension_settings.unrelated_extension).toEqual({ enabled: true });
    });

    test('browser-owned Conversation store fields and future fields round-trip', async () => {
        const browserStore = {
            version: 1,
            localStorageMigrated: true,
            settings: { enabled: true },
            characters: {
                'attachment.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: [{
                                id: 'attachment-message',
                                role: 'user',
                                mes: 'valid attachment metadata',
                                extra: {
                                    media: [{ url: 'https://example.com/legacy.png' }, { url: 'https://example.com/image.png', type: 'image' }],
                                    files: [{ url: 'https://example.com/file.txt', name: 'file.txt' }],
                                },
                            }],
                        },
                    },
                },
            },
            groups: [],
            legacyThreadPersonaAssignments: {
                'legacy char%: one.png': 'persona one%:.png',
            },
            reminders: [],
            userStatus: 'idle',
            userPersonaStatus: 'Working on tests',
            futureBrowserState: { enabled: true },
        };

        const saveResponse = await postJson('/store/save', { store: browserStore, version: 0 });
        expect(saveResponse.status).toBe(200);
        const savedStore = readConversationStore();
        expect(savedStore.legacyThreadPersonaAssignments).toEqual(browserStore.legacyThreadPersonaAssignments);
        expect(savedStore.userStatus).toBe('idle');
        expect(savedStore.userPersonaStatus).toBe('Working on tests');
        expect(savedStore.futureBrowserState).toEqual({ enabled: true });
        expect(savedStore.characters).toMatchObject(browserStore.characters);

        const getResponse = await postJson('/store/get', {});
        expect(getResponse.status).toBe(200);
        await expect(getResponse.json()).resolves.toMatchObject({
            store: {
                legacyThreadPersonaAssignments: browserStore.legacyThreadPersonaAssignments,
                userStatus: 'idle',
                userPersonaStatus: 'Working on tests',
                futureBrowserState: { enabled: true },
            },
        });
    });

    test('persisted store limits accommodate multiple full threads and stores above the request envelope', async () => {
        const makeMessages = threadIndex => Array.from({ length: 250 }, (_, messageIndex) => ({
            id: `thread-${threadIndex}-message-${messageIndex}`,
            role: 'user',
            name: 'Riley',
            mes: `message ${messageIndex}`,
        }));
        const complexStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: Object.fromEntries(Array.from({ length: 6 }, (_, threadIndex) => [
                `character-${threadIndex}.png`,
                {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: makeMessages(threadIndex),
                        },
                    },
                },
            ])),
        };
        expect(validateStoreStructure(complexStore)).toEqual({ valid: true });

        const saveResponse = await postJson('/store/save', { store: complexStore, version: 0 });
        expect(saveResponse.status).toBe(200);
        expect(Object.keys(readConversationStore().characters)).toHaveLength(6);

        const largeStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: {
                'large.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: Array.from({ length: 97 }, (_, index) => ({
                                id: `large-message-${index}`,
                                role: 'user',
                                mes: 'x'.repeat(256 * 1024),
                            })),
                        },
                    },
                },
            },
        };
        expect(validateStoreStructure(largeStore)).toEqual({ valid: true });
        const largeSaveResponse = await postJson('/store/save/', { store: largeStore, version: 1 });
        expect(largeSaveResponse.status).toBe(200);
        expect((await largeSaveResponse.json()).version).toBe(2);
        expect(readConversationStore().characters['large.png'].branches[DEFAULT_BRANCH_ID].messages).toHaveLength(97);
    });

    test('personaId scopes solo and group Conversation storage independently', async () => {
        const rileyResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId: 'riley.png',
            text: 'hello from Riley',
            userName: 'Riley',
            version: 0,
        });

        expect(rileyResponse.status).toBe(200);
        const rileyJson = await rileyResponse.json();
        expect(rileyJson.threadKey).toBe('persona:riley.png:nova.png');

        const morganResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId: 'morgan.png',
            text: 'hello from Morgan',
            userName: 'Morgan',
            version: 1,
        });

        expect(morganResponse.status).toBe(200);
        const morganJson = await morganResponse.json();
        expect(morganJson.threadKey).toBe('persona:morgan.png:nova.png');

        const createGroupResponse = await postJson('/group/create', {
            personaId: 'riley.png',
            name: 'Riley group',
            members: ['nova.png', 'echo.png'],
            version: 2,
        });

        expect(createGroupResponse.status).toBe(200);
        const createGroupJson = await createGroupResponse.json();
        expect(createGroupJson.group.personaId).toBe('riley.png');

        const rileyGroupsResponse = await postJson('/group/list', { personaId: 'riley.png' });
        const rileyGroupsJson = await rileyGroupsResponse.json();
        expect(rileyGroupsJson.groups.map(group => group.id)).toEqual([createGroupJson.group.id]);

        const morganGroupsResponse = await postJson('/group/list', { personaId: 'morgan.png' });
        const morganGroupsJson = await morganGroupsResponse.json();
        expect(morganGroupsJson.groups).toEqual([]);

        const groupAppendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: createGroupJson.group.id,
            personaId: 'riley.png',
            text: 'persona-scoped group hello',
            version: 3,
        });

        expect(groupAppendResponse.status).toBe(200);
        const groupAppendJson = await groupAppendResponse.json();
        expect(groupAppendJson.threadKey).toBe(`persona:riley.png:group:${createGroupJson.group.id}:nova.png`);

        const store = readConversationStore();
        expect(store.characters['persona:riley.png:nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('hello from Riley');
        expect(store.characters['persona:morgan.png:nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('hello from Morgan');
        expect(store.characters[`persona:riley.png:group:${createGroupJson.group.id}:nova.png`].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('persona-scoped group hello');
        expect(store.characters['nova.png']).toBeUndefined();
    });

    test('persona writes migrate assigned unscoped solo and group threads without losing scoped history', async () => {
        const personaId = 'riley:main.png';
        const scopedSoloKey = `persona:${encodeURIComponent(personaId)}:nova.png`;
        const groupId = 'legacy-conversation-group';
        const unscopedGroupKey = `group:${groupId}:nova.png`;
        const makeThread = (id, mes, createdAt) => ({
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: {
                    id: DEFAULT_BRANCH_ID,
                    messages: [{ id, role: 'user', name: 'Riley', mes, created_at: createdAt }],
                },
            },
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    characters: {
                        'nova.png': makeThread('legacy-solo', 'legacy solo history', 1),
                        [scopedSoloKey]: makeThread('scoped-solo', 'scoped solo history', 2),
                        [unscopedGroupKey]: makeThread('legacy-group', 'legacy group history', 1),
                    },
                    groups: [{
                        id: groupId,
                        personaId,
                        members: ['nova.png', 'echo.png'],
                        disabled_members: [],
                    }],
                    legacyThreadPersonaAssignments: {
                        'nova.png': personaId,
                        [unscopedGroupKey]: personaId,
                    },
                    reminders: [],
                },
            },
        }, null, 4));

        const soloResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId,
            id: 'new-solo',
            text: 'new solo message',
            version: 0,
        });
        expect(soloResponse.status).toBe(200);
        expect((await soloResponse.json()).threadKey).toBe(scopedSoloKey);

        const groupResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId,
            personaId,
            id: 'new-group',
            text: 'new group message',
            version: 1,
        });
        expect(groupResponse.status).toBe(200);

        const store = readConversationStore();
        expect(store.characters['nova.png']).toBeUndefined();
        expect(store.characters[unscopedGroupKey]).toBeUndefined();
        expect(store.legacyThreadPersonaAssignments).toEqual({});
        expect(store.characters[scopedSoloKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['legacy-solo', 'scoped-solo', 'new-solo']);
        const scopedGroupKey = `persona:${encodeURIComponent(personaId)}:${unscopedGroupKey}`;
        expect(store.characters[scopedGroupKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['legacy-group', 'new-group']);
    });

    test('group member aliases merge into one deterministic active anchor while disabled anchors remain', async () => {
        const personaId = 'riley.png';
        const groupId = 'canonical-group';
        const alphaKey = `persona:${personaId}:group:${groupId}:alpha.png`;
        const betaKey = `persona:${personaId}:group:${groupId}:beta.png`;
        const disabledKey = `persona:${personaId}:group:${groupId}:disabled.png`;
        const makeBranch = (id, messageId, unread, updatedAt) => ({
            id,
            messages: Array.from({ length: unread }, (_, index) => ({ id: index ? `${messageId}-${index}` : messageId, role: 'character', mes: messageId, created_at: updatedAt + index })),
            unread,
            updatedAt,
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [{
                        id: groupId,
                        personaId,
                        members: ['alpha.png', 'beta.png', 'disabled.png'],
                        disabled_members: ['disabled.png'],
                    }],
                    reminders: [],
                    characters: {
                        [alphaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'alpha-main', 2, 100),
                                'alpha-branch': makeBranch('alpha-branch', 'alpha-branch-message', 4, 90),
                            },
                        },
                        [betaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'beta-main', 3, 200),
                                'beta-branch': makeBranch('beta-branch', 'beta-branch-message', 1, 180),
                            },
                        },
                        [disabledKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'disabled-main', 7, 300),
                            },
                        },
                    },
                },
            },
        }));

        const appendResponse = await postJson('/message/append', {
            avatar: 'alpha.png',
            groupId,
            personaId,
            id: 'new-group-message',
            text: 'ongoing canonical history',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);
        const appendJson = await appendResponse.json();
        expect(appendJson.threadKey).toBe(betaKey);

        const store = readConversationStore();
        expect(store.characters[alphaKey]).toBeUndefined();
        expect(store.characters[disabledKey].branches[DEFAULT_BRANCH_ID].messages[0].id).toBe('disabled-main');
        const canonical = store.characters[betaKey];
        expect(Object.keys(canonical.branches)).toEqual(expect.arrayContaining([
            DEFAULT_BRANCH_ID,
            'alpha-branch',
            'beta-branch',
        ]));
        expect(canonical.branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['alpha-main', 'alpha-main-1', 'beta-main', 'beta-main-1', 'beta-main-2', 'new-group-message']);
        expect(canonical.branches[DEFAULT_BRANCH_ID].unread).toBe(5);
        expect(canonical.branches['alpha-branch'].unread).toBe(4);
        expect(canonical.branches['beta-branch'].unread).toBe(1);

        const aliasReadResponse = await postJson('/thread/get', {
            avatar: 'alpha.png',
            groupId,
            personaId,
        });
        expect(aliasReadResponse.status).toBe(200);
        expect((await aliasReadResponse.json()).threadKey).toBe(betaKey);
    });

    test('group alias canonicalization retains overflow history in a deterministic merged branch', async () => {
        const groupId = 'overflow-group';
        const alphaKey = `group:${groupId}:alpha.png`;
        const betaKey = `group:${groupId}:beta.png`;
        const makeMessages = (prefix, offset) => Array.from({ length: 130 }, (_, index) => ({
            id: `${prefix}-${index}`,
            role: 'character',
            mes: `${prefix} ${index}`,
            created_at: offset + index,
        }));
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [{
                        id: groupId,
                        members: ['alpha.png', 'beta.png'],
                        disabled_members: [],
                    }],
                    reminders: [],
                    characters: {
                        [alphaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: makeMessages('alpha', 1),
                                    unread: 4,
                                    updatedAt: 100,
                                },
                            },
                        },
                        [betaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: makeMessages('beta', 1000),
                                    unread: 6,
                                    updatedAt: 200,
                                },
                            },
                        },
                    },
                },
            },
        }));

        const response = await postJson('/message/append', {
            avatar: 'alpha.png',
            groupId,
            id: 'ongoing-message',
            text: 'continue after merge',
            version: 0,
        });
        expect(response.status).toBe(200);
        expect((await response.json()).threadKey).toBe(betaKey);

        const store = readConversationStore();
        expect(store.characters[alphaKey]).toBeUndefined();
        const canonical = store.characters[betaKey];
        const mergedBranchId = `${DEFAULT_BRANCH_ID}-merged-alpha.png`;
        expect(canonical.branches[DEFAULT_BRANCH_ID].messages).toHaveLength(131);
        expect(canonical.branches[DEFAULT_BRANCH_ID].unread).toBe(6);
        expect(canonical.branches[mergedBranchId].messages).toHaveLength(130);
        expect(canonical.branches[mergedBranchId].unread).toBe(4);
        expect(Object.values(canonical.branches).reduce((total, branch) => total + branch.messages.length, 0)).toBe(261);
    });

    test('message/append rejects stale settings versions', async () => {
        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'stale write',
            version: 99,
        });

        expect(response.status).toBe(409);
        const json = await response.json();
        expect(json).toEqual({ error: 'settings_conflict', version: 0 });
        expect(readSettings()._version).toBe(0);
    });

    test('thread/save replaces a thread with normalized messages', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                name: 'Riley',
                mes: 'first saved message',
            }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.messages).toHaveLength(1);
        expect(json.messages[0]).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'first saved message',
        });
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].preview).toBe('first saved message');
    });

    test('thread/save persists normalized aliases and generated message metadata', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{ text: 'message through text alias' }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.messages[0]).toMatchObject({
            role: 'user',
            name: 'User',
            mes: 'message through text alias',
            extra: {},
        });
        expect(json.messages[0].id).toEqual(expect.any(String));
        expect(json.messages[0].created_at).toEqual(expect.any(Number));
        expect(json.messages[0].send_date).toEqual(expect.any(String));
        expect(json.messages[0].text).toBeUndefined();
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages).toEqual(json.messages);
    });

    test('message IDs are selector-safe and unique within each thread', async () => {
        const duplicateThreadResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            version: 0,
            messages: [
                { id: 'duplicate-id', role: 'user', mes: 'first' },
                { id: 'duplicate-id', role: 'character', mes: 'second' },
            ],
        });
        expect(duplicateThreadResponse.status).toBe(400);
        await expect(duplicateThreadResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });

        const unsafeResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'unsafe"] .message',
            text: 'unsafe selector id',
            version: 0,
        });
        expect(unsafeResponse.status).toBe(400);
        await expect(unsafeResponse.json()).resolves.toEqual({ error: 'invalid_message_id' });

        const validResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'rest-message_123:reply.v1',
            text: 'safe id',
            version: 0,
        });
        expect(validResponse.status).toBe(200);
        const generatedIdResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'generated id',
            version: 1,
        });
        expect(generatedIdResponse.status).toBe(200);
        expect((await generatedIdResponse.json()).message.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

        const duplicateAppendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'rest-message_123:reply.v1',
            text: 'duplicate safe id',
            version: 2,
        });
        expect(duplicateAppendResponse.status).toBe(400);
        await expect(duplicateAppendResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });
        expect(readSettings()._version).toBe(2);
    });

    test('legacy unsafe and duplicate IDs and long message fields remain readable and repair on mutation', async () => {
        const unsafeId = 'legacy"] .message';
        const longName = 'N'.repeat(700);
        const longMessage = 'x'.repeat(300 * 1024);
        const legacyStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: {
                'nova.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: [
                                { id: unsafeId, role: 'user', name: longName, mes: longMessage, send_date: longName, created_at: 1 },
                                { id: 'legacy-1-0', role: 'character', name: 'Nova', mes: 'safe collision', created_at: 2 },
                                { id: 'duplicate-id', role: 'character', name: 'Nova', mes: 'first duplicate', created_at: 3 },
                                {
                                    id: 'duplicate-id',
                                    role: 'character',
                                    name: 'Nova',
                                    mes: 'second duplicate',
                                    created_at: 4,
                                    extra: { conversation_reply_to: { messageId: unsafeId, text: 'legacy reply' } },
                                },
                            ],
                        },
                    },
                },
            },
        };
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: legacyStore },
        }));

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(200);
        const readJson = await readResponse.json();
        expect(readJson.store.characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages[0]).toMatchObject({
            id: unsafeId,
            name: longName,
            mes: longMessage,
        });

        // A preserved legacy record is carried forward, not rejected: the whole
        // store must not block every save. A genuinely new invalid message in the
        // same save is still refused.
        const preservedSave = await postJson('/store/save', { store: legacyStore, version: 0 });
        expect(preservedSave.status).toBe(200);
        const versionAfterPreserved = readSettings()._version;

        const invalidNewStore = {
            ...legacyStore,
            characters: {
                'nova.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: [
                                ...legacyStore.characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages,
                                { id: 'bad id!', role: 'user', mes: 'new unsafe' },
                            ],
                        },
                    },
                },
            },
        };
        const invalidNewResponse = await postJson('/store/save', { store: invalidNewStore, version: versionAfterPreserved });
        expect(invalidNewResponse.status).toBe(400);
        await expect(invalidNewResponse.json()).resolves.toMatchObject({ error: 'invalid_message_id' });

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'new-safe-id',
            text: 'new message',
            version: versionAfterPreserved,
        });
        expect(appendResponse.status).toBe(200);

        const messages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(messages[0].name).toBe(longName);
        expect(messages[0].mes).toBe(longMessage);
        expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);
        expect(messages.every(message => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(message.id))).toBe(true);
        expect(messages[0].id).not.toBe('legacy-1-0');
        expect(messages[1].id).toBe('legacy-1-0');
        expect(messages[3].extra.conversation_reply_to.messageId).toBe(messages[0].id);

        const duplicateNewResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'duplicate-id',
            text: 'new duplicate',
            version: versionAfterPreserved + 1,
        });
        expect(duplicateNewResponse.status).toBe(400);
        await expect(duplicateNewResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });
        expect(readSettings()._version).toBe(versionAfterPreserved + 1);
    });

    test('thread/save rejects invalid nested attachment entries', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                mes: 'invalid attachment metadata',
                extra: { media: ['https://example.com/image.png'] },
            }],
            version: 0,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_stored_attachment' });
        expect(readSettings()._version).toBe(0);
    });

    test('thread/save retains browser-schema attachment-only messages', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                mes: '',
                extra: { media: [{ url: 'data:image/png;base64,YQ==', type: 'image' }] },
            }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.messages).toHaveLength(1);
        expect(json.messages[0].extra.media).toEqual([{ url: 'data:image/png;base64,YQ==', type: 'image' }]);
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages).toHaveLength(1);
    });

    test('legacy attachment-only messages remain readable and migrate on mutation', async () => {
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [],
                    reminders: [],
                    characters: {
                        'nova.png': {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{
                                        id: 'legacy-attachment',
                                        role: 'user',
                                        mes: '',
                                        extra: {
                                            attachments: [
                                                { url: '/user/images/legacy.png', type: 'image', title: 'Legacy duplicate' },
                                                { url: '/user/files/legacy.txt', type: 'file', name: 'Legacy duplicate' },
                                            ],
                                            media: [{ url: '/user/images/legacy.png', type: 'image', title: 'Legacy' }],
                                            files: [{ url: '/user/files/legacy.txt', type: 'file', name: 'Legacy' }],
                                        },
                                    }],
                                },
                            },
                        },
                    },
                },
            },
        }, null, 4));

        const getResponse = await postJson('/store/get', {});
        expect(getResponse.status).toBe(200);
        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'after legacy attachment',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);

        const messages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(messages).toHaveLength(2);
        expect(messages[0].extra.attachments).toBeUndefined();
        expect(messages[0].extra.media).toEqual([{ url: '/user/images/legacy.png', type: 'image', title: 'Legacy' }]);
        expect(messages[0].extra.files).toEqual([{ url: '/user/files/legacy.txt', type: 'file', name: 'Legacy' }]);
    });

    test('message/send appends the user message, generates a reply, strips commands, and persists both messages', async () => {
        upstreamReplyText = '[selfie] Hello from Nova.';

        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Can you say hi?',
            userName: 'Riley',
            version: 0,
            settings: {
                selfie_command_enabled: true,
                grounded_dialogue_rules_enabled: true,
                grounded_dialogue_rules: '### Grounded Dialogue Rules\n\n- Use concrete observable details instead of vague reactions.',
            },
            character: {
                data: {
                    name: 'Nova',
                    description: 'A friendly test character.',
                    personality: 'Warm and concise.',
                },
            },
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: upstreamUrl,
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    temperature: 1,
                    top_p: 1,
                    max_tokens: 64,
                },
            },
            includeGeneration: true,
            includePrompt: true,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(2); // The user message is saved before generation.
        expect(json.userMessage).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'Can you say hi?',
        });
        expect(json.replyMessage).toMatchObject({
            role: 'character',
            name: 'Nova',
            mes: 'Hello from Nova.',
        });
        expect(json.replyMessage.extra.conversation_reply_to).toMatchObject({
            messageId: json.userMessage.id,
            name: 'Riley',
            role: 'user',
            text: 'Can you say hi?',
        });
        expect(json.replyMessage.extra.conversation_commands.selfieRequests).toHaveLength(1);
        expect(json.generation.choices[0].message.content).toBe('[selfie] Hello from Nova.');
        expect(json.prompt.systemPrompt).toContain('You are Nova');
        expect(json.prompt.systemPrompt).toContain('Current system time context:');
        expect(json.prompt.systemPrompt).toContain('time of day, dates, timezones, reminders, scheduling');
        expect(json.prompt.systemPrompt).toContain('### Grounded Dialogue Rules');
        expect(json.prompt.systemPrompt).toContain('Use concrete observable details instead of vague reactions.');
        expect(json.prompt.messages.at(-1).content).toContain('Nova:');

        expect(upstreamRequests).toHaveLength(1);
        expect(upstreamRequests[0].model).toBe('gpt-5.4');
        expect(upstreamRequests[0].max_output_tokens).toBe(64);
        expect(upstreamRequests[0].instructions).toContain('You are Nova');
        expect(upstreamRequests[0].instructions).toContain('Current system time context:');
        expect(upstreamRequests[0].instructions).toContain('### Grounded Dialogue Rules');
        expect(JSON.stringify(upstreamRequests[0].input)).toContain('Can you say hi?');

        const settings = readSettings();
        expect(settings._version).toBe(2);
        const messages = settings.extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png']
            .branches[DEFAULT_BRANCH_ID]
            .messages;
        expect(messages.map(message => message.mes)).toEqual(['Can you say hi?', 'Hello from Nova.']);
        expect(messages[1].extra.conversation_reply_to.messageId).toBe(messages[0].id);
    });

    test('retrying a failed ordinary send at the cap is append-only, while regeneration is destructive', async () => {
        const { captureConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
        const { acceptJob } = await import('../src/jobs/store.js');
        const messages = Array.from({ length: 249 }, (_, i) => ({ id: `retry-${i}`, role: 'user', mes: `Earlier ${i}` }));
        expect((await postJson('/thread/save', { avatar: 'nova.png', version: 0, messages })).status).toBe(200);
        upstreamResponseStatus = 422;
        const failed = await postJson('/message/send', { avatar: 'nova.png', text: 'Retry this', version: 1, generation: getChatGeneration() });
        expect(failed.status).toBe(422);
        const failure = await failed.json();
        const request = { user: { directories: userDirectories, profile: { handle: userHandle } } };
        const target = captureConversationTarget(request, { avatar: 'nova.png', branchId: 'main' });
        upstreamResponseStatus = 200;
        const retry = await postJson('/message/send', { avatar: 'nova.png', text: 'Retry this', reuseLastUser: true, version: failure.version, generation: getChatGeneration() });
        expect(retry.status).toBe(200);
        expect(readConversationStore().characters['nova.png'].branches.main.messageEditRevision).toBe(target.messageEditRevision);
        const job = acceptJob(userDirectories, { owner: userHandle, type: 'test.conversation', submissionKey: 'retry-retention', intent: {} }).job;
        const context = { job, owner: userHandle, directories: userDirectories, signal: new AbortController().signal };
        await appendConversationJobMessage(context, target, 'later', { role: 'character', mes: 'Other pending reply' });
        const regeneration = await postJson('/message/send', { avatar: 'nova.png', text: 'Retry this', reuseLastUser: true, version: readSettings()._version, generation: getChatGeneration() });
        expect(regeneration.status).toBe(200);
        expect(readConversationStore().characters['nova.png'].branches.main.messageEditRevision).toBeGreaterThan(target.messageEditRevision);
        await expect(appendConversationJobMessage(context, target, 'stale', { role: 'character', mes: 'Must not save' })).rejects.toMatchObject({ status: 409 });
    });

    test('regeneration repairs legacy messages and retains the old reply on failure before a successful retry', async () => {
        const seed = await postJson('/thread/save', {
            avatar: 'nova.png', version: 0, messages: [
                { id: 'old-user', role: 'user', mes: 'Hello' },
                { id: 'old-reply', role: 'character', mes: 'Keep this reply until success' },
            ],
        });
        expect(seed.status).toBe(200);
        const settings = readSettings();
        delete settings.extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].extra;
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify(settings));
        const request = { avatar: 'nova.png', text: 'Hello', reuseLastUser: true, version: 1,
            character: { name: 'Nova' }, generation: getChatGeneration() };
        upstreamResponseStatus = 422;
        const failed = await postJson('/message/send', request);
        expect(failed.status).toBe(422);
        const failure = await failed.json();
        expect(failure).toMatchObject({ version: 2, reuseLastUser: true, userMessage: { id: 'old-user' } });
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages.at(-1).id).toBe('old-reply');
        upstreamResponseStatus = 200;
        const retried = await postJson('/message/send', { ...request, version: failure.version });
        expect(retried.status).toBe(200);
        const result = await retried.json();
        expect(result.version).toBe(4);
        expect(result.messages).toHaveLength(2);
        expect(result.messages.at(-1).id).not.toBe('old-reply');
    });

    test('message/send resolves authenticated relative user images without an HTTP loopback fetch', async () => {
        const albumPath = path.join(userDirectories.userImages, 'album');
        fs.mkdirSync(albumPath, { recursive: true });
        fs.writeFileSync(path.join(albumPath, 'photo.png'), Buffer.from('local image'));

        const saveResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            version: 0,
            messages: [{
                id: 'local-image-message',
                role: 'user',
                mes: '',
                extra: { media: [{ url: '/user/images/album/photo.png', type: 'image' }] },
            }],
        });
        expect(saveResponse.status).toBe(200);

        const sendResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'What is in my image?',
            version: 1,
            generation: getChatGeneration(),
        });
        expect(sendResponse.status).toBe(200);
        expect(JSON.stringify(upstreamRequests[0])).toContain('data:image/png;base64,');
    });

    test('message/send rejects oversized generated replies while retaining the user message', async () => {
        upstreamReplyText = 'x'.repeat(256 * 1024 + 1);
        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Generate too much',
            version: 0,
            generation: getChatGeneration(),
        });
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({ error: 'generation_too_large' });
        expect(readSettings()._version).toBe(1);
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['Generate too much']);
    });

    test('read and write routes reject corrupt or non-object settings without replacing them', async () => {
        const settingsPath = path.join(userDirectories.root, SETTINGS_FILE);
        fs.writeFileSync(settingsPath, '{not json');

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(500);
        await expect(readResponse.json()).resolves.toEqual({ error: 'settings_read_failed' });

        const writeResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'must not persist',
            version: 0,
        });
        expect(writeResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{not json');

        fs.writeFileSync(settingsPath, '[]');
        const nonObjectResponse = await postJson('/thread/get', { avatar: 'nova.png' });
        expect(nonObjectResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('[]');

        const invalidConversationSettings = JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: 'invalid' },
        });
        fs.writeFileSync(settingsPath, invalidConversationSettings);
        const invalidStoreResponse = await postJson('/store/get', {});
        expect(invalidStoreResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(invalidConversationSettings);
    });

    test('mutations refuse invalid nested stored shapes without overwriting them', async () => {
        const invalidStores = [
            { version: 1, characters: [], groups: [], reminders: [], settings: {} },
            { version: 1, characters: {}, groups: {}, reminders: [], settings: {} },
            {
                version: 1,
                characters: { 'nova.png': { activeBranchId: DEFAULT_BRANCH_ID, branches: [] } },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: { [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: {} } },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: { [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: [null] } },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: {
                            [DEFAULT_BRANCH_ID]: {
                                id: DEFAULT_BRANCH_ID,
                                messages: [{ id: 'bad-attachment', role: 'user', mes: 'text', extra: { files: [null] } }],
                            },
                        },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
        ];

        for (const store of invalidStores) {
            const serializedSettings = JSON.stringify({
                _version: 0,
                extension_settings: { [CONVERSATION_STORE_KEY]: store },
            });
            fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), serializedSettings);

            const response = await postJson('/message/append', {
                avatar: 'nova.png',
                text: 'must not overwrite corruption',
                version: 0,
            });
            expect(response.status).toBe(500);
            expect(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8')).toBe(serializedSettings);
        }
    });

    test('missing settings are reported explicitly and can be initialized with version zero', async () => {
        fs.rmSync(path.join(userDirectories.root, SETTINGS_FILE));

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(200);
        await expect(readResponse.json()).resolves.toMatchObject({ version: 0, settingsMissing: true });

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'first message',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);
        expect(readSettings()._version).toBe(1);
    });

    test('mutations require a valid expected settings version', async () => {
        const missingResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'missing version',
        });
        expect(missingResponse.status).toBe(400);
        await expect(missingResponse.json()).resolves.toEqual({ error: 'version_required' });

        const invalidResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'invalid version',
            version: '0',
        });
        expect(invalidResponse.status).toBe(400);
        await expect(invalidResponse.json()).resolves.toEqual({ error: 'invalid_version' });
    });

    test('storage keys retain raw syntax and reject colliding or reserved components', async () => {
        const rawKey = 'persona:riley!one.png:nova one% alt.png';
        const percentLiteralKey = 'persona:riley!one.png:alias%20name.png';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [],
                    reminders: [],
                    characters: {
                        [rawKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{ id: 'legacy-message', role: 'user', name: 'Riley', mes: 'legacy text' }],
                                },
                            },
                        },
                        [percentLiteralKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{ id: 'percent-literal', role: 'user', name: 'Riley', mes: 'literal percent owner' }],
                                },
                            },
                        },
                    },
                },
            },
        }, null, 4));

        const response = await postJson('/message/append', {
            avatar: 'nova one% alt.png',
            personaId: 'riley!one.png',
            text: 'new text',
            version: 0,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.threadKey).toBe(rawKey);
        expect(readConversationStore().characters[rawKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['legacy text', 'new text']);

        const aliasResponse = await postJson('/message/append', {
            avatar: 'alias name.png',
            personaId: 'riley!one.png',
            text: 'space owner',
            version: 1,
        });
        expect(aliasResponse.status).toBe(200);
        expect((await aliasResponse.json()).threadKey).toBe('persona:riley!one.png:alias name.png');
        expect(readConversationStore().characters[percentLiteralKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['literal percent owner']);
        expect(readConversationStore().characters['persona:riley!one.png:alias name.png'].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['space owner']);

        const collidingAvatarResponse = await postJson('/message/append', {
            avatar: 'nova:one.png',
            text: 'blocked collision',
            version: 2,
        });
        expect(collidingAvatarResponse.status).toBe(400);
        await expect(collidingAvatarResponse.json()).resolves.toEqual({ error: 'invalid_avatar' });

        const collidingGroupResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: 'group:one',
            text: 'blocked group collision',
            version: 2,
        });
        expect(collidingGroupResponse.status).toBe(400);
        await expect(collidingGroupResponse.json()).resolves.toEqual({ error: 'invalid_group_id' });

        const reservedResponse = await postJson('/message/append', {
            avatar: '__proto__',
            text: 'blocked',
            version: 2,
        });
        expect(reservedResponse.status).toBe(400);

        const unsafeStore = JSON.parse('{"version":1,"localStorageMigrated":false,"settings":{},"characters":{"__proto__":{}},"groups":[],"reminders":[]}');
        const unsafeStoreResponse = await postJson('/store/save', { store: unsafeStore, version: 2 });
        expect(unsafeStoreResponse.status).toBe(400);
        await expect(unsafeStoreResponse.json()).resolves.toMatchObject({ error: 'unsafe_thread_key' });

        const unsafeBranchStore = {
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {
                'nova.png': {
                    activeBranchId: 'constructor',
                    branches: {
                        [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: [] },
                    },
                },
            },
            groups: [],
            reminders: [],
        };
        const unsafeBranchResponse = await postJson('/store/save', { store: unsafeBranchStore, version: 2 });
        expect(unsafeBranchResponse.status).toBe(400);
        await expect(unsafeBranchResponse.json()).resolves.toMatchObject({ error: 'invalid_branch_id' });
        expect(Object.prototype.polluted).toBeUndefined();
    });

    test('thread/save rejects malformed stringified JSON', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: '[{"mes":',
            version: 0,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_messages' });
        expect(readSettings()._version).toBe(0);
    });

    test('message/send rejects blank, role-injected, and invalid timestamp messages before generation', async () => {
        const invalidMessages = [
            { text: '   ', expected: 'message_required' },
            { text: 'role injection', role: 'system', expected: 'invalid_message_role' },
            { text: 'bad date', created_at: Number.MAX_SAFE_INTEGER, expected: 'invalid_created_at' },
        ];

        for (const invalidMessage of invalidMessages) {
            const response = await postJson('/message/send', {
                avatar: 'nova.png',
                version: 0,
                generation: getChatGeneration(),
                ...invalidMessage,
            });
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({ error: invalidMessage.expected });
        }
        expect(upstreamRequests).toHaveLength(0);
        expect(readSettings()._version).toBe(0);
    });

    test('message/send accepts Object.prototype-named tool schema properties', async () => {
        const generation = getChatGeneration();
        const schemaProperties = JSON.parse('{"__proto__":{"type":"string"},"prototype":{"type":"string"}}');
        schemaProperties.constructor = { type: 'string' };
        schemaProperties.toString = { type: 'string' };
        generation.payload.tools = [{
            type: 'function',
            function: {
                name: 'schema_test',
                parameters: {
                    type: 'object',
                    properties: schemaProperties,
                },
            },
        }];

        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'tool schema names',
            version: 0,
            generation,
        });
        expect(response.status).toBe(200);
    });

    test('group mutations reject duplicate members and duplicate stored group IDs', async () => {
        const duplicateMembersResponse = await postJson('/group/create', {
            members: ['nova.png', ' nova.png ', 'echo.png'],
            version: 0,
        });
        expect(duplicateMembersResponse.status).toBe(400);
        await expect(duplicateMembersResponse.json()).resolves.toEqual({ error: 'duplicate_members' });

        const duplicateIdStore = {
            version: 1,
            settings: {},
            characters: {},
            groups: [
                { id: 'duplicate-group', members: ['nova.png', 'echo.png'] },
                { id: 'duplicate-group', members: ['nova.png', 'luna.png'] },
            ],
            reminders: [],
        };
        const duplicateIdResponse = await postJson('/store/save', { store: duplicateIdStore, version: 0 });
        expect(duplicateIdResponse.status).toBe(400);
        await expect(duplicateIdResponse.json()).resolves.toMatchObject({ error: 'duplicate_group_id' });

        const duplicateMemberStore = {
            ...duplicateIdStore,
            groups: [{ id: 'one-group', members: ['nova.png', ' nova.png ', 'echo.png'] }],
        };
        const duplicateStoreMembersResponse = await postJson('/store/save', { store: duplicateMemberStore, version: 0 });
        expect(duplicateStoreMembersResponse.status).toBe(400);
        await expect(duplicateStoreMembersResponse.json()).resolves.toMatchObject({ error: 'duplicate_group_members' });

        const duplicateDisabledMembersStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: ['nova.png', ' nova.png '],
            }],
        };
        const duplicateDisabledResponse = await postJson('/store/save', { store: duplicateDisabledMembersStore, version: 0 });
        expect(duplicateDisabledResponse.status).toBe(400);
        await expect(duplicateDisabledResponse.json()).resolves.toMatchObject({ error: 'duplicate_disabled_group_members' });

        const invalidDisabledMembersStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: [null],
            }],
        };
        const invalidDisabledResponse = await postJson('/store/save', { store: invalidDisabledMembersStore, version: 0 });
        expect(invalidDisabledResponse.status).toBe(400);
        await expect(invalidDisabledResponse.json()).resolves.toMatchObject({ error: 'invalid_disabled_group_members' });

        const nonMemberDisabledStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: ['luna.png'],
            }],
        };
        const nonMemberDisabledResponse = await postJson('/store/save', { store: nonMemberDisabledStore, version: 0 });
        expect(nonMemberDisabledResponse.status).toBe(400);
        await expect(nonMemberDisabledResponse.json()).resolves.toMatchObject({ error: 'invalid_disabled_group_members' });

        const duplicateSettings = JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: duplicateMemberStore },
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), duplicateSettings);
        const mutationResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'must not normalize duplicates',
            version: 0,
        });
        expect(mutationResponse.status).toBe(500);
        expect(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8')).toBe(duplicateSettings);
    });

    test('group validation rejects raw routing delimiters while allowing encoded persona delimiters', async () => {
        const invalidGroups = [
            { id: 'group:one', members: ['nova.png', 'echo.png'] },
            { id: 'group-one', members: ['nova:one.png', 'echo.png'] },
            { id: 'group-one', members: ['nova.png', 'echo.png'], disabled_members: ['nova:one.png'] },
        ];

        for (const group of invalidGroups) {
            const response = await postJson('/store/save', {
                version: 0,
                store: {
                    version: 1,
                    settings: {},
                    characters: {},
                    groups: [group],
                    reminders: [],
                },
            });
            expect(response.status).toBe(400);
        }

        const createResponse = await postJson('/group/create', {
            personaId: 'persona:one.png',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });
        expect(createResponse.status).toBe(200);
        const json = await createResponse.json();
        expect(json.group.personaId).toBe('persona:one.png');
        expect(readSettings()._version).toBe(1);
    });

    test('message appends retain only the newest 250 messages', async () => {
        const messages = Array.from({ length: 250 }, (_, index) => ({
            id: `message-${index}`,
            role: 'user',
            name: 'Riley',
            mes: `message ${index}`,
        }));
        const saveResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages,
            version: 0,
        });
        expect(saveResponse.status).toBe(200);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'message 250',
            version: 1,
        });
        expect(appendResponse.status).toBe(200);
        const json = await appendResponse.json();
        expect(json.messages).toHaveLength(250);
        expect(json.messages[0].mes).toBe('message 1');
        expect(json.messages.at(-1).mes).toBe('message 250');
    });

    test('group thread routes enforce the group persona and retain legacy roleplay group access', async () => {
        const createResponse = await postJson('/group/create', {
            personaId: 'riley.png',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });
        const group = (await createResponse.json()).group;

        const unauthorizedRequests = [
            postJson('/thread/get', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png' }),
            postJson('/thread/save', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', messages: [], version: 1 }),
            postJson('/message/append', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', text: 'blocked', version: 1 }),
            postJson('/message/send', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', text: 'blocked', version: 1, generation: getChatGeneration() }),
        ];
        for (const pendingResponse of unauthorizedRequests) {
            const response = await pendingResponse;
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toEqual({ error: 'avatar_not_in_group' });
        }
        expect(upstreamRequests).toHaveLength(0);

        const legacyGroup = {
            id: 'legacy-roleplay-group',
            members: ['nova.png', 'echo.png'],
            disabled_members: [],
        };
        fs.writeFileSync(path.join(userDirectories.groups, `${legacyGroup.id}.json`), JSON.stringify(legacyGroup));
        const legacyResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: legacyGroup.id,
            text: 'legacy group message',
            version: 1,
        });
        expect(legacyResponse.status).toBe(200);
    });

    test('message/send preflights stale versions and detects a concurrent commit after generation', async () => {
        const staleResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'stale paid request',
            version: 7,
            generation: getChatGeneration(),
        });
        expect(staleResponse.status).toBe(409);
        expect(upstreamRequests).toHaveLength(0);

        upstreamResponseDelayMs = 100;
        const sendPromise = postJson('/message/send', {
            avatar: 'nova.png',
            text: 'concurrent generation',
            version: 0,
            generation: getChatGeneration(),
        });
        await waitForUpstreamRequests(1);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'winning write',
            version: 1,
        });
        expect(appendResponse.status).toBe(200);

        const sendResponse = await sendPromise;
        expect(sendResponse.status).toBe(409);
        await expect(sendResponse.json()).resolves.toEqual({ error: 'settings_conflict', version: 2 });
        const persistedMessages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(persistedMessages.map(message => message.mes)).toEqual(['concurrent generation', 'winning write']);
    });

    test('message/send merges a reply after another thread is saved', async () => {
        upstreamResponseDelayMs = 100;
        const send = postJson('/message/send', {
            avatar: 'nova.png', text: 'Keep my reply', version: 0, generation: getChatGeneration(),
        });
        await waitForUpstreamRequests(1);
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('Keep my reply');
        const append = await postJson('/message/append', { avatar: 'other.png', text: 'Other thread', version: 1 });
        expect(append.status).toBe(200);
        const response = await send;
        expect(response.status).toBe(200);
        expect((await response.json()).version).toBe(3);
        const store = readConversationStore();
        expect(store.characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages).toHaveLength(2);
        expect(store.characters['other.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('Other thread');
    });

    test('a resumable Conversation request saves its reply after the client disconnects', async () => {
        upstreamResponseDelayMs = 100;
        const controller = new AbortController();
        const send = fetch(`${baseUrl}/message/send`, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-Generation-Id': 'conversation-disconnect' },
            body: JSON.stringify({ avatar: 'nova.png', text: 'Finish without me', version: 0, generation: getChatGeneration() }),
        });
        await waitForUpstreamRequests(1);
        controller.abort();
        await expect(send).rejects.toThrow();
        for (let attempt = 0; attempt < 100 && readSettings()._version < 2; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes))
            .toEqual(['Finish without me', upstreamReplyText]);
    });

    test.each(['chat', 'responses', 'text'])('marked assistants receive shared help in the actual %s request with tools disabled', async format => {
        const generation = format === 'text' ? {
            backend: 'text', payload: { api_type: TEXTGEN_TYPES.GENERIC, api_server: upstreamUrl, max_tokens: 64 },
        } : {
            backend: 'chat', payload: {
                chat_completion_source: format === 'responses' ? CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES : CHAT_COMPLETION_SOURCES.CUSTOM,
                reverse_proxy: upstreamUrl, proxy_password: 'test-key', custom_url: upstreamUrl.replace(/\/$/, ''), model: 'test-model', max_tokens: 64,
            },
        };
        const response = await postJson('/message/send', {
            avatar: 'nova.png', text: 'How do I change dialogue colours?', version: 0,
            character: { name: 'Renamed helper', extensions: { neconyan_assistant: { id: 'nori-neutral', version: 0 } } }, generation,
        });
        expect(response.status).toBe(200);
        expect(upstreamRequests).toHaveLength(1);
        const request = upstreamRequests[0];
        const instructions = request.instructions ?? request.prompt ?? request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        expect(instructions).toContain('[Neconyan help reference');
        expect(instructions).toContain('Included tools → Dialogue Colors → Settings → Characters');
        expect(instructions).toContain('Quote Text');
        expect(request.tools).toBeUndefined();
        expect(JSON.stringify(readConversationStore())).not.toContain('Neconyan help reference');
    });

    test('message/send supports the text completion backend adapter', async () => {
        upstreamReplyText = 'Text backend reply.';
        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Use text generation',
            version: 0,
            character: { name: 'Nova' },
            generation: {
                backend: 'text',
                payload: {
                    api_type: TEXTGEN_TYPES.GENERIC,
                    api_server: upstreamUrl,
                    max_tokens: 32,
                },
            },
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.replyMessage.mes).toBe('Text backend reply.');
        expect(upstreamRequests[0].prompt).toContain('Use text generation');
    });

    test('text completion validation still requires provider type and server', async () => {
        const missingTypeResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'missing type',
            version: 0,
            generation: { backend: 'text', payload: { api_server: upstreamUrl } },
        });
        expect(missingTypeResponse.status).toBe(400);
        await expect(missingTypeResponse.json()).resolves.toEqual({ error: 'generation_api_type_required' });

        const missingServerResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'missing server',
            version: 0,
            generation: { backend: 'text', payload: { api_type: TEXTGEN_TYPES.GENERIC } },
        });
        expect(missingServerResponse.status).toBe(400);
        await expect(missingServerResponse.json()).resolves.toEqual({ error: 'generation_api_server_required' });
        expect(upstreamRequests).toHaveLength(0);
    });

    test('message/send preserves safe upstream client statuses and maps upstream server failures to 502', async () => {
        upstreamResponseStatus = 429;
        const chatResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'chat rate limit',
            version: 0,
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                    custom_url: upstreamUrl.replace(/\/$/, ''),
                    model: 'test-model',
                },
            },
        });
        expect(chatResponse.status).toBe(429);
        await expect(chatResponse.json()).resolves.toMatchObject({ error: 'generation_failed' });

        upstreamResponseStatus = 422;
        const textResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'text validation failure',
            version: 1,
            generation: {
                backend: 'text',
                payload: {
                    api_type: TEXTGEN_TYPES.GENERIC,
                    api_server: upstreamUrl,
                },
            },
        });
        expect(textResponse.status).toBe(422);

        upstreamResponseStatus = 503;
        const serverErrorResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'upstream unavailable',
            version: 2,
            generation: getChatGeneration(),
        });
        expect(serverErrorResponse.status).toBe(502);
        expect(readSettings()._version).toBe(3);
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes))
            .toEqual(['chat rate limit', 'text validation failure', 'upstream unavailable']);
    });

    test('message/send charges validated requests per user and IP without spending user quota on invalid requests', async () => {
        for (let index = 0; index < 20; index++) {
            const invalidResponse = await postJson('/message/send', {
                avatar: 'nova.png',
                text: `invalid ${index}`,
                version: 0,
                generation: {
                    backend: 'chat',
                    payload: { chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES },
                },
            });
            expect(invalidResponse.status).toBe(400);
        }

        const validResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'valid after pre-validation failures',
            version: 0,
            generation: getChatGeneration(),
        });
        expect({ status: validResponse.status, error: validResponse.ok ? '' : await validResponse.text() }).toEqual({ status: 200, error: '' });

        upstreamResponseStatus = 422;
        for (let index = 0; index < 19; index++) {
            const rejectedUpstreamResponse = await postJson('/message/send', {
                avatar: 'nova.png',
                text: `validated failure ${index}`,
                version: readSettings()._version,
                generation: getChatGeneration(),
            });
            expect(rejectedUpstreamResponse.status).toBe(422);
        }
        const limitedResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'same user is limited',
            version: readSettings()._version,
            generation: getChatGeneration(),
        });
        expect(limitedResponse.status).toBe(429);

        userHandle = `${userHandle}-second-user`;
        upstreamResponseStatus = 200;
        const otherUserResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'same IP, different authenticated user',
            version: readSettings()._version,
            generation: getChatGeneration(),
        });
        expect(otherUserResponse.status).toBe(200);
    });
});
