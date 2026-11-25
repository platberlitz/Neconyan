import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';
import { createChatSearchMatcher } from '../src/chat-search-matcher.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: chatsRouter } = await import('../src/endpoints/chats.js');

const owner = 'chat-search-matcher-user';
let baseUrl;
let directories;
let server;
let tempParent;

function createDirectories() {
    tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-chat-search-'));
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

function writeChat(filePath, messages = [{ name: 'Nova', mes: 'One' }]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const bytes = [
        JSON.stringify({ user_name: 'User', character_name: 'Nova', chat_metadata: {} }),
        ...messages.map(message => JSON.stringify(message)),
    ].join('\n');
    fs.writeFileSync(filePath, bytes);
    return filePath;
}

async function searchChats(query) {
    const response = await fetch(`${baseUrl}/api/chats/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: 'Nova.png', query }),
    });
    assert.equal(response.status, 200);
    return response.json();
}

describe('server chat search Turkish İ/ı folding', () => {
    before(async () => {
        const app = express();
        app.use(express.json({ limit: '5mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: owner }, directories };
            next();
        });
        app.use('/api/chats', chatsRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        createDirectories();
    });

    afterEach(() => {
        if (tempParent) {
            fs.rmSync(tempParent, { recursive: true, force: true });
            tempParent = undefined;
        }
    });

    after(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
    });

    test('createChatSearchMatcher folds Turkish İ/ı and ASCII/English terms across messages', () => {
        const matcher = createChatSearchMatcher(['İçe', 'API', 'isik']);
        assert.equal(matcher(['içe aktar']), false);
        assert.equal(matcher(['içe aktar', 'api anahtarı', 'Işık']), true);
    });

    test('/api/chats/search matches Turkish İ/ı in filenames and message bodies separately', async () => {
        const charDir = path.join(directories.chats, 'Nova');
        writeChat(path.join(charDir, 'İçe_aktar.jsonl'), [{ name: 'Nova', mes: 'Sade bir sohbet metni' }]);
        writeChat(path.join(charDir, 'kır_notu.jsonl'), [{ name: 'Nova', mes: 'Başka bir günlük kayıt' }]);
        writeChat(path.join(charDir, 'Sohbet_1.jsonl'), [{ name: 'Nova', mes: 'İçe doğru API ve Işık' }]);

        const byFilenameDotted = await searchChats('içe');
        assert.deepEqual(
            byFilenameDotted.map(item => item.file_name).sort(),
            ['Sohbet_1', 'İçe_aktar'].sort(),
        );

        const byFilenameAscii = await searchChats('ice');
        assert.deepEqual(
            byFilenameAscii.map(item => item.file_name).sort(),
            ['Sohbet_1', 'İçe_aktar'].sort(),
        );

        const byFilenameDotless = await searchChats('kir');
        assert.deepEqual(byFilenameDotless.map(item => item.file_name), ['kır_notu']);

        const byBodyApi = await searchChats('api');
        assert.deepEqual(byBodyApi.map(item => item.file_name), ['Sohbet_1']);

        const byBodyIsik = await searchChats('ışık');
        assert.deepEqual(byBodyIsik.map(item => item.file_name), ['Sohbet_1']);

        const byBodyIsikAscii = await searchChats('isik');
        assert.deepEqual(byBodyIsikAscii.map(item => item.file_name), ['Sohbet_1']);
    });
});
