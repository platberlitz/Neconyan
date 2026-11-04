import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { write: writeCard } = await import('../src/character-card-parser.js');
const { router: charactersRouter } = await import('../src/endpoints/characters.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

let baseUrl;
let directories;
let handle;
let handleIndex = 0;
let server;
let tempParent;

function createCard(name, description, tags = ['fixture'], assistant = undefined) {
    return writeCard(png, JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description,
        personality: '',
        scenario: '',
        first_mes: 'Hello',
        mes_example: '',
        data: {
            name,
            description,
            personality: '',
            scenario: '',
            first_mes: 'Hello',
            mes_example: '',
            creator_notes: '',
            tags,
            creator: 'Fixture',
            character_version: '1.0',
            extensions: { fav: false, world: '', ...(assistant ? { neconyan_assistant: assistant } : {}) },
        },
    }));
}

function createDirectories() {
    handleIndex++;
    handle = `character-list-user-${handleIndex}`;
    tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-character-list-'));
    const root = path.join(tempParent, handle);
    directories = {
        root,
        backups: path.join(root, 'backups'),
        chats: path.join(root, 'chats'),
        characters: path.join(root, 'characters'),
        groupChats: path.join(root, 'group chats'),
        groups: path.join(root, 'groups'),
        worlds: path.join(root, 'worlds'),
        thumbnailsAvatar: path.join(root, 'thumbnails', 'avatar'),
        thumbnailsAvatarMobile: path.join(root, 'thumbnails', 'avatar', 'mobile'),
    };
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.mkdirSync(path.join(directories.chats, 'Nova'), { recursive: true });
}

async function postJson(route, body = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

function forceListRebuild() {
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(directories.characters, future, future);
}

function countCardParses() {
    let parses = 0;
    const originalParse = JSON.parse;
    const spy = jest.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (typeof text === 'string' && text.includes('SHALLOW_CARD_MARKER')) {
            parses++;
        }
        return originalParse(text, reviver);
    });
    return {
        spy,
        get parses() {
            return parses;
        },
        reset() {
            parses = 0;
        },
    };
}

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle }, directories };
        next();
    });
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
    if (tempParent) {
        fs.rmSync(tempParent, { recursive: true, force: true });
    }
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
    process.chdir(originalWorkingDirectory);
});

describe('character list performance', () => {
    test('assistant lists reuse positive and negative metadata, then detect edits, renames and deletion', async () => {
        const cardPath = path.join(directories.characters, 'Nova.png');
        const otherPath = path.join(directories.characters, 'Kit.png');
        fs.writeFileSync(cardPath, createCard('Nova', 'SHALLOW_CARD_MARKER one', [], { id: 'miso-male', version: 1 }));
        fs.writeFileSync(otherPath, createCard('Kit', 'SHALLOW_CARD_MARKER two'));
        const counter = countCardParses();
        const catalogue = async () => {
            const response = await fetch(`${baseUrl}/api/characters/assistants`);
            expect(response.status).toBe(200);
            return (await response.json()).personalities.flatMap(personality => personality.variants).flatMap(variant => variant.installed);
        };
        expect(await catalogue()).toEqual([expect.objectContaining({ avatar: 'Nova.png', version: 1 })]);
        expect(counter.parses).toBe(2);
        counter.reset();
        expect(await catalogue()).toEqual([expect.objectContaining({ avatar: 'Nova.png', version: 1 })]);
        expect(counter.parses).toBe(0);

        const stat = fs.statSync(cardPath);
        fs.writeFileSync(cardPath, createCard('Nova', 'SHALLOW_CARD_MARKER one', [], { id: 'miso-male', version: 2 }));
        expect(fs.statSync(cardPath).size).toBe(stat.size);
        fs.utimesSync(cardPath, stat.atime, stat.mtime);
        counter.reset();
        expect(await catalogue()).toEqual([expect.objectContaining({ avatar: 'Nova.png', version: 2 })]);
        expect(counter.parses).toBe(1);

        fs.writeFileSync(otherPath, createCard('Kit', 'SHALLOW_CARD_MARKER two', [], { id: 'taro-male', version: 1 }));
        fs.renameSync(cardPath, path.join(directories.characters, 'Renamed.png'));
        expect(await catalogue()).toEqual(expect.arrayContaining([
            expect.objectContaining({ avatar: 'Renamed.png', version: 2 }),
            expect.objectContaining({ avatar: 'Kit.png', version: 1 }),
        ]));
        fs.unlinkSync(otherPath);
        fs.unlinkSync(path.join(directories.characters, 'Renamed.png'));
        expect(await catalogue()).toEqual([]);
    });

    test('reuses an unchanged shallow card across a forced list rebuild', async () => {
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), createCard('Nova', 'SHALLOW_CARD_MARKER one'));
        fs.writeFileSync(path.join(directories.characters, 'Kit.png'), createCard('Kit', 'SHALLOW_CARD_MARKER two', ['other']));
        const counter = countCardParses();

        const first = await postJson('/api/characters/all');
        expect(first.status).toBe(200);
        expect(first.body).toHaveLength(2);
        expect(counter.parses).toBe(2);

        counter.reset();
        forceListRebuild();
        const second = await postJson('/api/characters/all');
        expect(second.status).toBe(200);
        expect(counter.parses).toBe(0);
        expect(second.body).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Nova', shallow: true }),
            expect.objectContaining({ name: 'Kit', shallow: true, tags: ['other'] }),
        ]));
        expect(second.body).toEqual(first.body);
    });

    test('parses a card again after its bytes change', async () => {
        const cardPath = path.join(directories.characters, 'Nova.png');
        fs.writeFileSync(cardPath, createCard('Nova', 'SHALLOW_CARD_MARKER first'));
        const counter = countCardParses();

        expect((await postJson('/api/characters/all')).status).toBe(200);
        expect(counter.parses).toBe(1);

        fs.writeFileSync(cardPath, createCard('Nova', 'SHALLOW_CARD_MARKER second', ['updated']));
        counter.reset();
        forceListRebuild();
        const response = await postJson('/api/characters/all');
        expect(response.status).toBe(200);
        expect(counter.parses).toBe(1);
        expect(response.body[0]).toMatchObject({ name: 'Nova', tags: ['updated'] });
    });

    test('reads a replaced card even when its size and modification time are restored', async () => {
        const cardPath = path.join(directories.characters, 'Nova.png');
        const original = createCard('Nova', 'SHALLOW_CARD_MARKER original', ['original']);
        const replacement = createCard('Nova', 'SHALLOW_CARD_MARKER replaced', ['replaced']);
        expect(replacement.length).toBe(original.length);
        const timestamp = new Date(1_700_000_500_000);

        fs.writeFileSync(cardPath, original);
        fs.utimesSync(cardPath, timestamp, timestamp);
        const before = fs.statSync(cardPath);
        const first = await postJson('/api/characters/all');
        expect(first.body[0].tags).toEqual(['original']);

        // The card was replaced in place: same path, same size, same inode and a
        // restored modification time. Only the change time moves.
        await new Promise(resolve => setTimeout(resolve, 30));
        fs.writeFileSync(cardPath, replacement);
        fs.utimesSync(cardPath, timestamp, timestamp);
        const after = fs.statSync(cardPath);
        expect(after.size).toBe(before.size);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.ctimeMs).not.toBe(before.ctimeMs);

        forceListRebuild();
        const second = await postJson('/api/characters/all');
        expect(second.status).toBe(200);
        expect(second.body[0].tags).toEqual(['replaced']);
    });

    test('recomputes chat size and last chat from the current chat directory', async () => {
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), createCard('Nova', 'SHALLOW_CARD_MARKER chats'));
        const chatDirectory = path.join(directories.chats, 'Nova');
        const firstChat = path.join(chatDirectory, 'First.jsonl');
        const notes = path.join(chatDirectory, 'Notes.txt');
        const nested = path.join(chatDirectory, 'Nested');
        fs.writeFileSync(firstChat, '12345');
        fs.writeFileSync(notes, '1234567');
        fs.mkdirSync(nested);
        fs.utimesSync(firstChat, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
        fs.utimesSync(notes, new Date(1_700_000_002_000), new Date(1_700_000_002_000));
        fs.utimesSync(nested, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
        const expectedSize = fs.statSync(firstChat).size + fs.statSync(notes).size + fs.statSync(nested).size;
        const expectedLastChat = Math.max(fs.statSync(firstChat).mtimeMs, fs.statSync(notes).mtimeMs, fs.statSync(nested).mtimeMs);

        const first = (await postJson('/api/characters/all')).body;
        expect(first[0].chat_size).toBe(expectedSize);
        expect(Math.abs(first[0].date_last_chat - expectedLastChat)).toBeLessThan(1);

        const secondChat = path.join(chatDirectory, 'Second.jsonl');
        fs.writeFileSync(secondChat, '1234567890');
        fs.utimesSync(secondChat, new Date(1_700_000_003_000), new Date(1_700_000_003_000));
        forceListRebuild();
        const second = await postJson('/api/characters/all');
        expect(second.body[0].chat_size).toBe(expectedSize + 10);
        expect(Math.abs(second.body[0].date_last_chat - 1_700_000_003_000)).toBeLessThan(1);

        fs.rmSync(notes);
        forceListRebuild();
        const third = await postJson('/api/characters/all');
        expect(third.body[0].chat_size).toBe(expectedSize + 10 - 7);
    });

    test('a chat switch serves the cached list without re-parsing cards and keeps the switched character fresh', async () => {
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), createCard('Nova', 'SHALLOW_CARD_MARKER switch'));
        const chatDirectory = path.join(directories.chats, 'Nova');
        fs.writeFileSync(path.join(chatDirectory, 'First.jsonl'), '12345');
        fs.utimesSync(path.join(chatDirectory, 'First.jsonl'), new Date(1_700_000_001_000), new Date(1_700_000_001_000));
        expect((await fetch(`${baseUrl}/api/characters/last-chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: 'Nova.png', chat: 'First' }) })).status).toBe(200);

        const counter = countCardParses();
        const first = (await postJson('/api/characters/all')).body;
        expect(first[0].chat).toBe('First');
        expect(first[0].chat_size).toBe(5);

        // Switching chats writes the sidecar only. The first cached hit rescans just
        // this character (a calculateChatSize run is the only readdir on the hit path).
        counter.reset();
        const readdirSpy = jest.spyOn(fs.promises, 'readdir');
        fs.writeFileSync(path.join(chatDirectory, 'Second.jsonl'), '1234567890');
        fs.utimesSync(path.join(chatDirectory, 'Second.jsonl'), new Date(1_700_000_003_000), new Date(1_700_000_003_000));
        expect((await fetch(`${baseUrl}/api/characters/last-chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: 'Nova.png', chat: 'Second' }) })).status).toBe(200);

        const second = await postJson('/api/characters/all');
        expect(counter.parses).toBe(0);
        expect(second.body[0].chat).toBe('Second');
        expect(second.body[0].chat_size).toBe(5 + 10);
        expect(Math.abs(second.body[0].date_last_chat - 1_700_000_003_000)).toBeLessThan(1);
        expect(readdirSpy.mock.calls.some(([directory]) => directory === chatDirectory)).toBe(true);

        // The refresh is cached: the immediately following hit serves the same fresh
        // values without rescanning the chat directory again.
        readdirSpy.mockClear();
        const third = await postJson('/api/characters/all');
        expect(counter.parses).toBe(0);
        expect(third.body[0].chat).toBe('Second');
        expect(third.body[0].chat_size).toBe(15);
        expect(Math.abs(third.body[0].date_last_chat - 1_700_000_003_000)).toBeLessThan(1);
        expect(readdirSpy).not.toHaveBeenCalled();

        // A later in-place save of the pointed chat is not hidden by the cached probe:
        // the next hit rescans once, and the one after that serves the new values.
        readdirSpy.mockClear();
        await new Promise(resolve => setTimeout(resolve, 25));
        fs.writeFileSync(path.join(chatDirectory, 'Second.jsonl'), '1234567890 plus a saved message');
        const fourth = await postJson('/api/characters/all');
        expect(fourth.body[0].chat_size).toBe(5 + '1234567890 plus a saved message'.length);
        expect(readdirSpy.mock.calls.some(([directory]) => directory === chatDirectory)).toBe(true);

        readdirSpy.mockClear();
        const fifth = await postJson('/api/characters/all');
        expect(fifth.body[0].chat_size).toBe(fourth.body[0].chat_size);
        expect(readdirSpy).not.toHaveBeenCalled();
    });

    test('a save landing after the scan cannot hide behind the initial probes', async () => {
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), createCard('Nova', 'SHALLOW_CARD_MARKER probe-order'));
        fs.writeFileSync(path.join(directories.characters, 'Kit.png'), createCard('Kit', 'SHALLOW_CARD_MARKER probe-order-kit'));
        const novaChatDirectory = path.join(directories.chats, 'Nova');
        const kitChatDirectory = path.join(directories.chats, 'Kit');
        fs.mkdirSync(kitChatDirectory, { recursive: true });
        const novaChat = path.join(novaChatDirectory, 'First.jsonl');
        const kitChat = path.join(kitChatDirectory, 'Kit.jsonl');
        fs.writeFileSync(novaChat, '12345');
        fs.writeFileSync(kitChat, '12345');
        expect((await fetch(`${baseUrl}/api/characters/last-chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: 'Nova.png', chat: 'First' }) })).status).toBe(200);

        // Hold Kit's chat stat so the first listing cannot finish, while Nova's scan
        // completes. A save landing in that window happened after Nova's scan observed
        // the file but before a post-scan probe sample would run.
        const originalStat = fs.promises.stat.bind(fs.promises);
        let releaseKitChat;
        const kitChatStat = new Promise(resolve => { releaseKitChat = resolve; });
        let novaChatStatObserved;
        const novaChatStatDone = new Promise(resolve => { novaChatStatObserved = resolve; });
        let kitChatStatRequested;
        const kitChatStatRequestedDone = new Promise(resolve => { kitChatStatRequested = resolve; });
        const statSpy = jest.spyOn(fs.promises, 'stat').mockImplementation((filePath, ...args) => {
            if (filePath === kitChat) {
                kitChatStatRequested();
                return kitChatStat;
            }
            if (filePath === novaChat) {
                const result = originalStat(filePath, ...args);
                result.then(() => novaChatStatObserved(), () => novaChatStatObserved());
                return result;
            }
            return originalStat(filePath, ...args);
        });

        try {
            const firstAll = postJson('/api/characters/all');
            await Promise.all([novaChatStatDone, kitChatStatRequestedDone]);
            fs.writeFileSync(novaChat, '1234567890');
            releaseKitChat({ size: 5, mtimeMs: 1_700_000_001_000 });
            const first = (await firstAll).body;
            const nova = first.find(character => character.avatar === 'Nova.png');
            expect(nova.chat_size).toBe(5);

            // The probes were captured before the scan started, so they record the
            // pre-save file: the next listing detects the save and refreshes instead of
            // serving the stale pre-save statistics forever.
            const second = await postJson('/api/characters/all');
            expect(second.body.find(character => character.avatar === 'Nova.png').chat_size).toBe(10);
        } finally {
            statSpy.mockRestore();
        }
    });

    test('keeps the surviving chats when one stat fails during the scan', async () => {
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), createCard('Nova', 'SHALLOW_CARD_MARKER stat'));
        const chatDirectory = path.join(directories.chats, 'Nova');
        const gone = path.join(chatDirectory, 'Gone.jsonl');
        const present = path.join(chatDirectory, 'Present.jsonl');
        fs.writeFileSync(gone, '12345');
        fs.writeFileSync(present, '1234567890');
        expect((await postJson('/api/characters/all')).status).toBe(200);

        const originalStat = fs.promises.stat;
        jest.spyOn(fs.promises, 'stat').mockImplementation((filePath, ...args) => {
            if (filePath === gone) {
                return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
            }
            return originalStat(filePath, ...args);
        });
        forceListRebuild();
        const response = await postJson('/api/characters/all');
        expect(response.status).toBe(200);
        expect(response.body[0].chat_size).toBe(10);
    });
});
