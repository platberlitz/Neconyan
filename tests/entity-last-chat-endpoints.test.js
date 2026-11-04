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

const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { router: charactersRouter } = await import('../src/endpoints/characters.js');
const { ENTITY_LAST_CHAT_FILE } = await import('../src/entity-last-chat.js');

describe('entity last chat endpoints', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'last-chat-test-user' },
                directories,
            };
            next();
        });
        app.use('/api/characters', charactersRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-last-chat-endpoints-')), 'last-chat-test-user');
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        initialiseRoleplayAccount({ owner: 'last-chat-test-user', directories });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(path.dirname(tempRoot), { recursive: true, force: true });
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

    test('switching chats records the name without rewriting the card', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');
        const cardBefore = fs.readFileSync(cardPath);
        const statBefore = fs.statSync(cardPath);

        await delay();
        const saveResponse = await postJson('/api/characters/last-chat', {
            avatar: 'Alice.png',
            chat: 'Alice - second chat',
        });
        expect(saveResponse.status).toBe(200);

        // The whole point: the character file must be byte-identical and untouched.
        expect(fs.readFileSync(cardPath).equals(cardBefore)).toBe(true);
        expect(fs.statSync(cardPath).mtimeMs).toBe(statBefore.mtimeMs);

        const [listed] = await getCharacters();
        expect(listed.chat).toBe('Alice - second chat');
        expect((await getCharacter('Alice.png')).chat).toBe('Alice - second chat');
    });

    test('a card with no sidecar entry still reports its embedded chat', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        fs.rmSync(path.join(tempRoot, ENTITY_LAST_CHAT_FILE), { force: true });

        const [listed] = await getCharacters();
        expect(typeof listed.chat).toBe('string');
        expect(listed.chat.length).toBeGreaterThan(0);

        // Seeding the sidecar afterwards takes precedence.
        await postJson('/api/characters/last-chat', { avatar: 'Alice.png', chat: 'Alice - later' });
        expect((await getCharacters())[0].chat).toBe('Alice - later');
    });

    test('the recorded chat follows a rename and disappears with the character', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        await postJson('/api/characters/last-chat', { avatar: 'Alice.png', chat: 'Alice - kept' });

        const renameResponse = await postJson('/api/characters/rename', {
            avatar_url: 'Alice.png',
            new_name: 'Alicia',
        });
        expect(renameResponse.status).toBe(200);
        const renamedAvatar = (await renameResponse.json()).avatar;

        const renamed = (await getCharacters()).find(character => character.avatar === renamedAvatar);
        expect(renamed.chat).toBe('Alice - kept');

        const deleteResponse = await postJson('/api/characters/delete', {
            avatar_url: renamedAvatar,
            delete_chats: false,
        });
        expect(deleteResponse.status).toBe(200);
        expect(readStore().characters.entries[renamedAvatar]).toBeUndefined();
    });

    test('repeating a merge that changes nothing leaves the card alone', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const cardPath = path.join(directories.characters, 'Alice.png');

        // The first merge is a real edit, so it writes.
        const firstResponse = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Somebody',
        });
        expect(firstResponse.status).toBe(200);
        const cardAfterFirst = fs.readFileSync(cardPath);
        const statAfterFirst = fs.statSync(cardPath);

        await delay();
        const repeatResponse = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Somebody',
        });
        expect(repeatResponse.status).toBe(200);
        expect(fs.readFileSync(cardPath).equals(cardAfterFirst)).toBe(true);
        expect(fs.statSync(cardPath).mtimeMs).toBe(statAfterFirst.mtimeMs);

        await delay();
        const changedResponse = await postJson('/api/characters/merge-attributes', {
            avatar: 'Alice.png',
            creator: 'Someone else',
        });
        expect(changedResponse.status).toBe(200);
        expect(fs.statSync(cardPath).mtimeMs).toBeGreaterThan(statAfterFirst.mtimeMs);
        expect((await getCharacter('Alice.png')).creator).toBe('Someone else');
    });

    test('the endpoint rejects a missing avatar and a non-string chat name', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await postJson('/api/characters/last-chat', { chat: 'orphan' })).status).toBe(400);
        expect((await postJson('/api/characters/last-chat', {
            avatar: 'Alice.png',
            chat: { nope: true },
        })).status).toBe(400);
    });

    async function createAlice() {
        const createResponse = await postJson('/api/characters/create', {
            ch_name: 'Alice',
            file_name: 'Alice',
        });
        expect(createResponse.status).toBe(200);
        return createResponse;
    }

    function readStore() {
        const filePath = path.join(tempRoot, ENTITY_LAST_CHAT_FILE);
        if (!fs.existsSync(filePath)) {
            return { characters: { entries: {} } };
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    function postJson(resource, body = {}) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function getCharacters() {
        const response = await postJson('/api/characters/all');
        expect(response.status).toBe(200);
        return response.json();
    }

    test('a cached list refreshes chat statistics when the pointed chat file is saved', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        const chatDirectory = path.join(directories.chats, 'Alice');
        fs.mkdirSync(chatDirectory, { recursive: true });
        const chatPath = path.join(chatDirectory, 'first.jsonl');
        fs.writeFileSync(chatPath, JSON.stringify([{ name: 'Alice', is_user: false, mes: 'Hello!', send_date: 0 }]));
        await postJson('/api/characters/last-chat', { avatar: 'Alice.png', chat: 'first' });

        const [before] = await getCharacters();
        expect(before.chat).toBe('first');
        expect(before.chat_size).toBeGreaterThan(0);
        expect(before.date_last_chat).toBeGreaterThan(0);

        // A plain save: the card file and the characters directory stay untouched, so the
        // next listing is a cache hit that must still see the grown chat file.
        await delay();
        fs.writeFileSync(chatPath, JSON.stringify([
            { name: 'Alice', is_user: false, mes: 'Hello!', send_date: 0 },
            { name: 'Alice', is_user: false, mes: 'A second message makes the file longer.', send_date: 0 },
        ]));

        const [after] = await getCharacters();
        expect(after.chat).toBe('first');
        expect(after.chat_size).toBeGreaterThan(before.chat_size);
        expect(after.date_last_chat).toBeGreaterThan(before.date_last_chat);

        // The card was never rewritten, so the second listing cannot have been a rebuild.
        const statBefore = fs.statSync(path.join(directories.characters, 'Alice.png'));
        await delay();
        const [again] = await getCharacters();
        expect(again.chat_size).toBe(after.chat_size);
        expect(fs.statSync(path.join(directories.characters, 'Alice.png')).mtimeMs).toBe(statBefore.mtimeMs);
    });

    test('a cached list still reports the embedded chat once the sidecar row is removed', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        await createAlice();
        await postJson('/api/characters/last-chat', { avatar: 'Alice.png', chat: 'first' });
        const [before] = await getCharacters();
        expect(before.chat).toBe('first');

        fs.rmSync(path.join(tempRoot, ENTITY_LAST_CHAT_FILE), { force: true });

        const [after] = await getCharacters();
        expect(typeof after.chat).toBe('string');
        expect(after.chat.length).toBeGreaterThan(0);
        expect(after.chat).not.toBe('first');
    });

    async function getCharacter(avatarUrl) {
        const response = await postJson('/api/characters/get', { avatar_url: avatarUrl });
        expect(response.status).toBe(200);
        return response.json();
    }

    function delay() {
        return new Promise(resolve => setTimeout(resolve, 25));
    }
});
