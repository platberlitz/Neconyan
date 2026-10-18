import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { getChatInfo, router: chatsRouter } = await import('../src/endpoints/chats.js');
const { router: charactersRouter } = await import('../src/endpoints/characters.js');
const { collectRecentChatFiles, selectRecentChatFiles } = await import('../src/chat-library-inventory.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');

const owner = 'chat-listing-user';
let baseUrl;
let directories;
let server;
let tempParent;

function createDirectories() {
    tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-chat-listing-'));
    const root = path.join(tempParent, owner);
    directories = {
        root,
        backups: path.join(root, 'backups'),
        chats: path.join(root, 'chats'),
        characters: path.join(root, 'characters'),
        groupChats: path.join(root, 'group chats'),
        groups: path.join(root, 'groups'),
        worlds: path.join(root, 'worlds'),
    };
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

function chatBytes(metadata = {}, messages = [{ name: 'Nova', mes: 'One' }]) {
    return [
        JSON.stringify({ user_name: 'User', character_name: 'Nova', chat_metadata: metadata }),
        ...messages.map(message => JSON.stringify(message)),
    ].join('\n');
}

function writeChat(filePath, metadata = {}, messages = [{ name: 'Nova', mes: 'One' }]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, chatBytes(metadata, messages));
    return filePath;
}

function setMtime(filePath, seconds) {
    const date = new Date(1_700_000_000_000 + seconds * 1000);
    fs.utimesSync(filePath, date, date);
}

async function postJson(route, body = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
}

function delay(milliseconds = 15) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle: owner }, directories };
        next();
    });
    app.use('/api/chats', chatsRouter);
    app.use('/api/characters', charactersRouter);
    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    createDirectories();
});

afterEach(() => {
    jest.restoreAllMocks();
    if (tempParent) fs.rmSync(tempParent, { recursive: true, force: true });
    tempParent = undefined;
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (originalDiskCacheSetting === undefined) {
        delete process.env[diskCacheEnvironmentKey];
    } else {
        process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
    }
});

describe('chat summary cache', () => {
    test('reuses an unchanged summary and reparses after append, replace or touch', async () => {
        const filePath = writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'), {}, [
            { name: 'Nova', mes: 'One' },
            { name: 'User', mes: 'Two' },
        ]);
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        await expect(getChatInfo(filePath)).resolves.toMatchObject({ chat_items: 2, mes: 'Two' });
        await expect(getChatInfo(filePath)).resolves.toMatchObject({ chat_items: 2, mes: 'Two' });
        expect(streamSpy).toHaveBeenCalledTimes(1);

        await delay();
        fs.appendFileSync(filePath, '\n' + JSON.stringify({ name: 'Nova', mes: 'Three' }));
        await expect(getChatInfo(filePath)).resolves.toMatchObject({ chat_items: 3, mes: 'Three' });
        expect(streamSpy).toHaveBeenCalledTimes(2);

        await delay();
        fs.writeFileSync(filePath, chatBytes({ changed: true }, [{ name: 'Nova', mes: 'Replaced' }]));
        await expect(getChatInfo(filePath)).resolves.toMatchObject({
            chat_items: 1,
            mes: 'Replaced',
        });
        expect(streamSpy).toHaveBeenCalledTimes(3);

        await delay();
        fs.utimesSync(filePath, new Date(), new Date());
        await getChatInfo(filePath);
        expect(streamSpy).toHaveBeenCalledTimes(4);
    });

    test('keeps plain, metadata and preview requests separate and isolated', async () => {
        const filePath = writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'), { fixture: 'metadata' }, [
            { name: 'User', mes: 'First' },
            { name: 'Nova', mes: 'Second' },
            { name: 'User', mes: 'Third' },
        ]);
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        const plain = await getChatInfo(filePath);
        expect(plain).not.toHaveProperty('chat_metadata');
        expect(plain).not.toHaveProperty('preview_messages');

        const detailed = await getChatInfo(filePath, {}, true, null, 2);
        expect(detailed.chat_metadata).toEqual({ fixture: 'metadata' });
        expect(detailed.preview_messages.map(message => message.mes)).toEqual(['Second', 'Third']);
        expect(streamSpy).toHaveBeenCalledTimes(2);

        const plainAgain = await getChatInfo(filePath);
        expect(plainAgain).not.toHaveProperty('chat_metadata');
        expect(plainAgain).not.toHaveProperty('preview_messages');

        detailed.preview_messages[0].mes = 'client mutation';
        const detailedAgain = await getChatInfo(filePath, {}, true, null, 2);
        expect(detailedAgain.preview_messages.map(message => message.mes)).toEqual(['Second', 'Third']);
        expect(streamSpy).toHaveBeenCalledTimes(2);
    });

    test('does not cache matcher results and leaves the plain summary untouched', async () => {
        const filePath = writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'), {}, [
            { name: 'Nova', mes: 'haystack' },
            { name: 'User', mes: 'needle' },
        ]);
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        await expect(getChatInfo(filePath)).resolves.toMatchObject({ match: true, chat_items: 2 });
        await expect(getChatInfo(filePath, {}, false, texts => texts.some(text => text.includes('missing'))))
            .resolves.toMatchObject({ match: false, chat_items: 2 });
        await expect(getChatInfo(filePath, {}, false, texts => texts.some(text => text.includes('needle'))))
            .resolves.toMatchObject({ match: true, chat_items: 2 });
        expect(streamSpy).toHaveBeenCalledTimes(3);

        await expect(getChatInfo(filePath)).resolves.toMatchObject({ match: true, chat_items: 2 });
        expect(streamSpy).toHaveBeenCalledTimes(3);
    });

    test('coalesces concurrent misses for the same file and option tuple', async () => {
        const filePath = writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'));
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        const results = await Promise.all(Array.from({ length: 8 }, () => getChatInfo(filePath)));
        expect(results.every(result => result.chat_items === 1)).toBe(true);
        expect(streamSpy).toHaveBeenCalledTimes(1);
    });

    test('gives concurrent callers private metadata and preview objects', async () => {
        const filePath = writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'), { fixture: 'metadata' }, [
            { name: 'User', mes: 'First' },
            { name: 'Nova', mes: 'Second' },
        ]);
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        const [first, second] = await Promise.all([
            getChatInfo(filePath, {}, true, null, 2),
            getChatInfo(filePath, {}, true, null, 2),
        ]);
        expect(streamSpy).toHaveBeenCalledTimes(1);
        first.chat_metadata.fixture = 'mutated';
        first.preview_messages[0].mes = 'mutated';

        expect(second.chat_metadata).toEqual({ fixture: 'metadata' });
        expect(second.preview_messages.map(message => message.mes)).toEqual(['First', 'Second']);
    });

    test('bounds cache-miss parsing to eight open chats', async () => {
        const files = Array.from({ length: 24 }, (_, index) => writeChat(
            path.join(directories.chats, 'Nova', `Chat ${String(index).padStart(2, '0')}.jsonl`),
            {},
            [{ name: 'Nova', mes: `message ${index}` }],
        ));
        const originalCreateReadStream = fs.createReadStream;
        let active = 0;
        let maximum = 0;
        let ended = 0;
        let releaseCloses = false;
        let batchRead;
        const firstBatchRead = new Promise(resolve => { batchRead = resolve; });
        const pendingCloses = [];
        // Keep the first batch's descriptors open after readline has consumed
        // their contents. A parse slot must include this asynchronous close.
        jest.spyOn(fs.promises, 'stat').mockImplementation(async file => fs.statSync(file));
        const streamSpy = jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
            active++;
            maximum = Math.max(maximum, active);
            const stream = originalCreateReadStream(...args);
            const destroy = stream._destroy;
            stream._destroy = function (error, callback) {
                const close = () => destroy.call(this, error, callback);
                if (releaseCloses) close();
                else pendingCloses.push(close);
            };
            stream.once('end', () => { if (++ended === 8) batchRead(); });
            stream.once('close', () => { active--; });
            return stream;
        });

        const pendingResults = Promise.all(files.map(file => getChatInfo(file)));
        try {
            await firstBatchRead;
            await new Promise(resolve => setImmediate(resolve));
            expect(maximum).toBeLessThanOrEqual(8);
        } finally {
            releaseCloses = true;
            for (const close of pendingCloses) close();
            await pendingResults;
        }
        const results = await pendingResults;
        expect(results).toHaveLength(24);
        expect(results.every(result => result.chat_items === 1)).toBe(true);
        expect(streamSpy).toHaveBeenCalledTimes(24);
        expect(maximum).toBeLessThanOrEqual(8);
        expect(active).toBe(0);
    });

    test('closes failed reads before releasing their slots to queued chats', async () => {
        const files = Array.from({ length: 10 }, (_, index) => writeChat(
            path.join(directories.chats, 'Nova', `Read ${index}.jsonl`),
            {},
            [{ name: 'Nova', mes: `message ${index}` }],
        ));
        const failedFiles = new Set(files.slice(0, 8));
        const originalCreateReadStream = fs.createReadStream;
        let active = 0;
        let maximum = 0;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
            const stream = originalCreateReadStream(...args);
            maximum = Math.max(maximum, ++active);
            stream.once('close', () => { active--; });
            if (failedFiles.has(args[0])) {
                stream.once('open', () => stream.destroy(new Error('Fixture read failure')));
            }
            return stream;
        });

        const results = await Promise.all(files.map(file => getChatInfo(file)));
        expect(results.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => ({})));
        expect(results.slice(8).map(result => result.mes)).toEqual(['message 8', 'message 9']);
        expect(errorSpy).toHaveBeenCalledTimes(8);
        expect(maximum).toBeLessThanOrEqual(8);
        expect(active).toBe(0);
    });

    test('does not reuse a summary after rename, delete or recreate', async () => {
        const originalPath = writeChat(path.join(directories.chats, 'Nova', 'Original.jsonl'), {}, [
            { name: 'Nova', mes: 'Before' },
        ]);
        const movedPath = path.join(directories.chats, 'Nova', 'Moved.jsonl');
        const streamSpy = jest.spyOn(fs, 'createReadStream');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(getChatInfo(originalPath)).resolves.toMatchObject({ mes: 'Before' });
        expect(streamSpy).toHaveBeenCalledTimes(1);

        fs.renameSync(originalPath, movedPath);
        await expect(getChatInfo(movedPath)).resolves.toMatchObject({ mes: 'Before' });
        expect(streamSpy).toHaveBeenCalledTimes(2);

        writeChat(originalPath, {}, [{ name: 'Nova', mes: 'Recreated' }]);
        await expect(getChatInfo(originalPath)).resolves.toMatchObject({ mes: 'Recreated' });
        expect(streamSpy).toHaveBeenCalledTimes(3);

        fs.rmSync(movedPath);
        await expect(getChatInfo(movedPath)).resolves.toEqual({});
        expect(errorSpy).toHaveBeenCalled();
        expect(streamSpy).toHaveBeenCalledTimes(3);
    });

    test('still scans every chat for a search query instead of using the cache', async () => {
        writeChat(path.join(directories.chats, 'Nova', 'First.jsonl'), {}, [{ name: 'Nova', mes: 'ordinary text' }]);
        writeChat(path.join(directories.chats, 'Nova', 'Second.jsonl'), {}, [{ name: 'Nova', mes: 'a needle here' }]);
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        const first = await postJson('/api/chats/search', { avatar_url: 'Nova.png', query: 'needle' });
        expect(first.status).toBe(200);
        expect(first.body).toEqual([expect.objectContaining({
            file_name: 'Second',
            message_count: 1,
            preview_message: 'a needle here',
        })]);
        expect(streamSpy).toHaveBeenCalledTimes(2);

        const second = await postJson('/api/chats/search', { avatar_url: 'Nova.png', query: 'needle' });
        expect(second.status).toBe(200);
        expect(second.body).toHaveLength(1);
        expect(streamSpy).toHaveBeenCalledTimes(4);
    });

    test('keeps the chatbar listing current after a chat changes', async () => {
        writeChat(path.join(directories.chats, 'Nova', 'Chat.jsonl'), { fixture: true }, [
            { name: 'Nova', mes: 'One' },
        ]);

        const first = await postJson('/api/characters/chats', { avatar_url: 'Nova.png' });
        expect(first.status).toBe(200);
        expect(first.body).toEqual([expect.objectContaining({
            file_name: 'Chat.jsonl',
            file_id: 'Chat',
            chat_items: 1,
            mes: 'One',
        })]);
        expect(first.body[0]).not.toHaveProperty('chat_metadata');

        fs.appendFileSync(path.join(directories.chats, 'Nova', 'Chat.jsonl'),
            '\n' + JSON.stringify({ name: 'User', mes: 'Two' }));
        const second = await postJson('/api/characters/chats', { avatar_url: 'Nova.png', metadata: true });
        expect(second.status).toBe(200);
        expect(second.body).toEqual([expect.objectContaining({
            file_name: 'Chat.jsonl',
            chat_items: 2,
            mes: 'Two',
            chat_metadata: { fixture: true },
        })]);
    });

    test('keeps empty and corrupt results and warns on every corrupt read', async () => {
        const emptyPath = path.join(directories.chats, 'Nova', 'Empty.jsonl');
        fs.mkdirSync(path.dirname(emptyPath), { recursive: true });
        fs.writeFileSync(emptyPath, '');
        const corruptPath = writeChat(path.join(directories.chats, 'Nova', 'Corrupt.jsonl'));
        fs.writeFileSync(corruptPath, '!broken');
        const streamSpy = jest.spyOn(fs, 'createReadStream');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(getChatInfo(emptyPath)).resolves.toMatchObject({
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
            match: false,
        });
        expect(streamSpy).not.toHaveBeenCalled();

        await expect(getChatInfo(corruptPath)).resolves.toEqual({});
        await expect(getChatInfo(corruptPath)).resolves.toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(streamSpy).toHaveBeenCalledTimes(1);

        await expect(getChatInfo(path.join(directories.chats, 'Nova', 'Missing.jsonl'))).resolves.toEqual({});
        expect(errorSpy).toHaveBeenCalled();
    });
});

describe('recent chat inventory', () => {
    test('keeps pinned first, newest next, and group and individual depth', () => {
        const files = [];
        for (let index = 0; index < 10; index++) {
            files.push({
                groupId: 'group',
                filePath: path.join(directories.groupChats, `Group ${index}.jsonl`),
                mtime: 2_000 + index,
            });
        }
        for (let index = 0; index < 3; index++) {
            files.push({
                pngFile: 'Nova.png',
                filePath: path.join(directories.chats, 'Nova', `Solo ${index}.jsonl`),
                mtime: 1_000 + index,
            });
        }
        const pinnedChats = [{
            file_name: 'Pinned.jsonl',
            avatar: 'Nova.png',
        }];
        files.push({
            pngFile: 'Nova.png',
            filePath: path.join(directories.chats, 'Nova', 'Pinned.jsonl'),
            mtime: 500,
        });

        const selected = selectRecentChatFiles(files, { max: 4, pinnedChats });
        expect(selected[0].filePath).toBe(path.join(directories.chats, 'Nova', 'Pinned.jsonl'));
        expect(selected.filter(file => file.groupId).length).toBeGreaterThanOrEqual(4);
        expect(selected.filter(file => file.pngFile && !file.groupId).map(file => file.filePath))
            .toEqual(expect.arrayContaining([
                path.join(directories.chats, 'Nova', 'Solo 0.jsonl'),
                path.join(directories.chats, 'Nova', 'Solo 1.jsonl'),
                path.join(directories.chats, 'Nova', 'Solo 2.jsonl'),
            ]));
        const unpinned = selected.slice(1);
        expect(unpinned.every((file, index) => index === 0 || unpinned[index - 1].mtime >= file.mtime)).toBe(true);
    });

    test('skips only a file whose stat fails and keeps root, character and group chats', async () => {
        writeChat(path.join(directories.chats, 'Nova', 'One.jsonl'));
        writeChat(path.join(directories.chats, 'Nova', 'Gone.jsonl'));
        writeChat(path.join(directories.chats, 'Root.jsonl'));
        writeChat(path.join(directories.groupChats, 'Group.jsonl'));
        fs.mkdirSync(path.join(directories.characters), { recursive: true });
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), 'card');
        fs.writeFileSync(path.join(directories.groups, 'group.json'), JSON.stringify({
            id: 'group',
            members: ['Nova.png'],
            chats: ['Group'],
        }));

        const stats = await collectRecentChatFiles(directories, {
            stat: async filePath => {
                if (path.basename(filePath) === 'Gone.jsonl') {
                    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                }
                return fs.promises.stat(filePath);
            },
        });

        const names = stats.map(entry => path.basename(entry.filePath));
        expect(names).toEqual(expect.arrayContaining(['One.jsonl', 'Root.jsonl', 'Group.jsonl']));
        expect(names).not.toContain('Gone.jsonl');
        expect(stats.find(entry => entry.filePath.endsWith('Group.jsonl')).groupId).toBe('group');
        expect(stats.find(entry => entry.filePath.endsWith('One.jsonl')).pngFile).toBe('Nova.png');
    });

    test('serves pinned and balanced recent chats with their summary fields', async () => {
        const individualDirectory = path.join(directories.chats, 'Nova');
        const groupDirectory = directories.groupChats;
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), 'card');
        writeChat(path.join(individualDirectory, 'Solo newest.jsonl'), {}, [{ name: 'Nova', mes: 'solo newest' }]);
        writeChat(path.join(individualDirectory, 'Solo older.jsonl'), {}, [{ name: 'Nova', mes: 'solo older' }]);
        writeChat(path.join(directories.chats, 'Root pinned.jsonl'), {}, [{ name: 'Nova', mes: 'pinned' }]);
        const groupChats = Array.from({ length: 6 }, (_, index) => `Group ${index}`);
        for (const [index, name] of groupChats.entries()) {
            writeChat(path.join(groupDirectory, `${name}.jsonl`), {}, [{ name: 'Nova', mes: `group ${index}` }]);
        }
        fs.writeFileSync(path.join(directories.groups, 'group.json'), JSON.stringify({
            id: 'group',
            members: ['Nova.png'],
            chats: groupChats,
        }));
        setMtime(path.join(directories.chats, 'Root pinned.jsonl'), 100);
        setMtime(path.join(individualDirectory, 'Solo older.jsonl'), 200);
        setMtime(path.join(individualDirectory, 'Solo newest.jsonl'), 300);
        for (const [index, name] of groupChats.entries()) {
            setMtime(path.join(groupDirectory, `${name}.jsonl`), 400 + index);
        }

        const response = await postJson('/api/chats/recent', {
            max: 2,
            pinned: [{ file_name: 'Root pinned.jsonl' }],
        });
        expect(response.status).toBe(200);
        const names = response.body.map(chat => chat.file_name);
        expect(names[0]).toBe('Root pinned.jsonl');
        expect(names).toEqual(expect.arrayContaining([
            'Solo newest.jsonl',
            'Solo older.jsonl',
            'Group 5.jsonl',
        ]));
        expect(response.body.find(chat => chat.file_name === 'Solo newest.jsonl')).toMatchObject({
            avatar: 'Nova.png',
            chat_items: 1,
            mes: 'solo newest',
        });
        expect(response.body.find(chat => chat.file_name === 'Group 5.jsonl')).toMatchObject({
            group: 'group',
            chat_items: 1,
            mes: 'group 5',
        });
        expect(response.body.length).toBeLessThanOrEqual(2 * 3);
    });
});

describe('group chat info', () => {
    const header = { user_name: 'User', character_name: 'Nova', chat_metadata: {} };
    const firstMessage = { name: 'User', is_user: true, mes: 'Original', send_date: 1_700_000_000_000 };
    const secondMessage = { name: 'Nova', is_user: false, mes: 'Answer', send_date: 1_700_000_001_000 };

    function chatText(lines) {
        return lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n');
    }

    function prepareGroup(text) {
        fs.writeFileSync(path.join(directories.groupChats, 'Source.jsonl'), text);
        fs.writeFileSync(path.join(directories.groups, 'group.json'), JSON.stringify({
            id: 'group',
            members: ['Nova.png'],
            chats: ['Source'],
        }));
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), 'card');
        initialiseRoleplayAccount({ owner, directories });
    }

    const lineVariants = [
        {
            name: 'normal content',
            lines: [header, firstMessage, secondMessage],
            expected: { chat_items: 2, mes: 'Answer' },
        },
        {
            name: 'a blank line in the middle',
            lines: [header, firstMessage, '', secondMessage],
            expected: { chat_items: 3, mes: 'Answer' },
        },
        {
            name: 'a whitespace line in the middle',
            lines: [header, firstMessage, '   ', secondMessage],
            expected: { chat_items: 3, mes: 'Answer' },
        },
        {
            name: 'one trailing newline',
            lines: [header, firstMessage],
            expected: { chat_items: 1, mes: 'Original' },
        },
    ];

    for (const variant of lineVariants) {
        test(`keeps the file reader and physical line counts for ${variant.name}`, async () => {
            prepareGroup(chatText(variant.lines));
            const streamSpy = jest.spyOn(fs, 'createReadStream');
            const filePath = path.join(directories.groupChats, 'Source.jsonl');

            const response = await postJson('/api/chats/group/info', { id: 'Source' });
            expect(response.status).toBe(200);
            expect(streamSpy).toHaveBeenCalledTimes(1);
            expect(response.body).toMatchObject({
                match: true,
                file_id: 'Source',
                file_name: 'Source.jsonl',
                ...variant.expected,
            });
            await expect(getChatInfo(filePath)).resolves.toEqual(response.body);
        });
    }

    test('keeps the old trailing empty-line semantics', async () => {
        // Two trailing newlines produce one empty line. getChatInfo treats the
        // empty last line as the empty-chat shape, not the preceding message.
        prepareGroup(chatText([header, firstMessage]) + '\n\n');
        const streamSpy = jest.spyOn(fs, 'createReadStream');
        const filePath = path.join(directories.groupChats, 'Source.jsonl');

        const response = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(response.status).toBe(200);
        expect(streamSpy).toHaveBeenCalledTimes(1);
        expect(response.body).toMatchObject({
            file_id: 'Source',
            file_name: 'Source.jsonl',
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
            match: false,
        });
        await expect(getChatInfo(filePath)).resolves.toEqual(response.body);
    });

    test('keeps the old trailing whitespace-line semantics', async () => {
        // A whitespace-only last line fails the final JSON parse, so the old
        // reader falls back to the file id and name.
        prepareGroup(chatText([header, firstMessage]) + '\n   \n');
        const streamSpy = jest.spyOn(fs, 'createReadStream');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const filePath = path.join(directories.groupChats, 'Source.jsonl');

        const response = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(response.status).toBe(200);
        expect(streamSpy).toHaveBeenCalledTimes(1);
        expect(response.body).toEqual({ file_id: 'Source', file_name: 'Source.jsonl' });
        await expect(getChatInfo(filePath)).resolves.toEqual({});
    });

    test('reads the file at listing time rather than reusing protected records', async () => {
        prepareGroup(chatText([header, firstMessage, secondMessage]));
        const filePath = path.join(directories.groupChats, 'Source.jsonl');
        const replacement = chatText([
            header,
            { name: 'Nova', is_user: false, mes: 'Replacement answer', send_date: 1_700_000_002_000 },
        ]);
        const originalCreateReadStream = fs.createReadStream;
        let replaced = false;
        jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
            if (!replaced) {
                replaced = true;
                fs.writeFileSync(filePath, replacement);
            }
            return originalCreateReadStream(...args);
        });

        const response = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(replaced).toBe(true);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            file_id: 'Source',
            file_name: 'Source.jsonl',
            chat_items: 1,
            mes: 'Replacement answer',
            last_mes: 1_700_000_002_000,
        });
    });

    test('reuses the cached reader on a repeat group info request', async () => {
        prepareGroup(chatText([header, firstMessage, secondMessage]));
        const streamSpy = jest.spyOn(fs, 'createReadStream');

        const first = await postJson('/api/chats/group/info', { id: 'Source' });
        const second = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(streamSpy).toHaveBeenCalledTimes(1);
    });

    test('keeps the empty-chat listing shape', async () => {
        prepareGroup('');

        const response = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            file_id: 'Source',
            file_name: 'Source.jsonl',
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
        });
    });

    test('keeps the fallback for a damaged group chat', async () => {
        prepareGroup('!broken');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/group/info', { id: 'Source' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ file_id: 'Source', file_name: 'Source.jsonl' });
        expect(warnSpy).toHaveBeenCalled();
    });
});
