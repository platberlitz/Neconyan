/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../src/fetch-patch.js';
import { read as readCard, write as writeCard } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'default/content/assistants/manifest.json'), 'utf8'));
const variantIds = manifest.personalities.flatMap(personality => personality.variants.map(variant => variant.id));
const expectedExpressionNames = new Set(['admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy', 'love', 'nervousness', 'neutral', 'optimism', 'pride', 'realization', 'relief', 'remorse', 'sadness', 'surprise']);
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
jest.setTimeout(30000);
setConfigFilePath(path.join(repoRoot, 'default/config.yaml'));
const { router: charactersRouter } = await import('../src/endpoints/characters.js');

describe('Neconyan assistant catalog and installer', () => {
    let baseUrl;
    let directories;
    let otherDirectories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'assistant-endpoint-test' }, directories: request.header('x-test-profile') === 'other' ? otherDirectories : directories };
            next();
        });
        app.use('/api/characters', charactersRouter);
        await new Promise((resolve, reject) => {
            server = app.listen(0, '127.0.0.1', resolve);
            server.once('error', reject);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-assistant-endpoint-'));
        globalThis.DATA_ROOT = tempRoot;
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
        Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
    });

    afterEach(() => {
        if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
        delete globalThis.DATA_ROOT;
    });

    afterAll(async () => {
        if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        jest.restoreAllMocks();
        if (originalDiskCacheSetting === undefined) delete process.env[diskCacheEnvironmentKey];
        else process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
    });

    function requestJson(resource, body, headers = {}) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    }

    async function legacyAssistant(id = 'miso-male', headers = {}, version = 1) {
        const response = await requestJson('/api/characters/assistants/install', { id }, headers);
        expect(response.status).toBe(200);
        const installed = await response.json();
        const profile = headers['x-test-profile'] === 'other' ? otherDirectories : directories;
        const cardPath = path.join(profile.characters, installed.avatar);
        const card = JSON.parse(readCard(fs.readFileSync(cardPath)));
        card.data.extensions.neconyan_assistant.version = version;
        card.name = card.data.name = 'My edited assistant';
        card.description = card.data.description = 'Keep these personal instructions.';
        const bytes = writeCard(fs.readFileSync(cardPath), JSON.stringify(card));
        fs.writeFileSync(cardPath, bytes);
        return { installed, cardPath, bytes };
    }

    test('updated copies preserve edited cards and chats and reuse concurrent retry cards and sprites', async () => {
        const old = await legacyAssistant('miso-male', {}, 0);
        const spritePath = path.join(directories.characters, old.installed.spriteFolder, 'neutral.webp');
        fs.writeFileSync(spritePath, 'my expression');
        const chatDirectory = path.join(directories.chats, path.parse(old.installed.avatar).name);
        fs.mkdirSync(chatDirectory, { recursive: true });
        const chatPath = path.join(chatDirectory, 'kept.jsonl');
        fs.writeFileSync(chatPath, '{"mes":"Keep my chat"}\n');
        const catalog = await (await fetch(`${baseUrl}/api/characters/assistants`)).json();
        const variant = catalog.personalities.flatMap(item => item.variants).find(item => item.id === 'miso-male');
        expect(variant).toMatchObject({ bundledVersion: 1, installed: [{ avatar: old.installed.avatar, version: 0, updateAvailable: true }] });
        const updates = await Promise.all([1, 2].map(async () => {
            const response = await requestJson('/api/characters/assistants/update-copy', { id: 'miso-male', avatar: old.installed.avatar });
            expect(response.status).toBe(200);
            return response.json();
        }));
        expect(updates[0].avatar).not.toBe(old.installed.avatar);
        expect(updates[0].avatar).toBe(updates[1].avatar);
        expect(updates[0].spriteFolder).toBe(updates[1].spriteFolder);
        expect(updates[0].spriteFolder).not.toBe(old.installed.spriteFolder);
        expect(fs.readFileSync(old.cardPath).equals(old.bytes)).toBe(true);
        expect(fs.readFileSync(chatPath, 'utf8')).toBe('{"mes":"Keep my chat"}\n');
        expect(fs.readFileSync(spritePath, 'utf8')).toBe('my expression');
        expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toHaveLength(2);
        expect(fs.readdirSync(path.join(directories.characters, 'Neconyan Assistants'))).toHaveLength(2);
        const revised = JSON.parse(readCard(fs.readFileSync(path.join(directories.characters, updates[0].avatar))));
        expect(revised.data.extensions.neconyan_assistant).toMatchObject({ id: 'miso-male', version: 1 });
        expect(revised.data.description).toContain('`Interviewer`:');
    });

    test.each([0, 1, 2])('offers updated artwork only for older installed cards (version %i)', async (version) => {
        const installed = await legacyAssistant('miso-neutral', {}, version);
        const catalog = await (await fetch(`${baseUrl}/api/characters/assistants`)).json();
        const variant = catalog.personalities.flatMap(item => item.variants).find(item => item.id === 'miso-neutral');
        expect(variant).toMatchObject({ bundledVersion: 1, installed: [{ avatar: installed.installed.avatar, version, updateAvailable: version < 1 }] });
    });

    test('update-copy rejects wrong targets and isolates two profiles', async () => {
        const old = await legacyAssistant('taro-neutral', {}, 0);
        const otherRoot = path.join(tempRoot, 'other-profile');
        otherDirectories = Object.fromEntries(Object.entries(directories).map(([key, value]) => [key, path.join(otherRoot, path.relative(tempRoot, value))]));
        Object.values(otherDirectories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
        const request = { id: 'taro-neutral', avatar: old.installed.avatar };
        expect((await requestJson('/api/characters/assistants/update-copy', request, { 'x-test-profile': 'other' })).status).toBe(404);
        expect((await requestJson('/api/characters/assistants/update-copy', { ...request, avatar: '../outside.png' })).status).toBe(404);
        expect((await requestJson('/api/characters/assistants/update-copy', { ...request, id: 'miso-male' })).status).toBe(404);
        const other = await legacyAssistant('taro-neutral', { 'x-test-profile': 'other' }, 0);
        const results = await Promise.all([
            requestJson('/api/characters/assistants/update-copy', request),
            requestJson('/api/characters/assistants/update-copy', { ...request, avatar: other.installed.avatar }, { 'x-test-profile': 'other' }),
        ]);
        expect(results.every(response => response.status === 200)).toBe(true);
        expect(fs.readFileSync(old.cardPath).equals(old.bytes)).toBe(true);
        expect(fs.readFileSync(other.cardPath).equals(other.bytes)).toBe(true);
        expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toHaveLength(2);
        expect(fs.readdirSync(otherDirectories.characters).filter(file => file.endsWith('.png'))).toHaveLength(2);
    });

    test('failed update staging cleans only the new sprite pack and can be retried', async () => {
        const old = await legacyAssistant('nori-female', {}, 0);
        const mkdtemp = fs.promises.mkdtemp.bind(fs.promises);
        const fail = jest.spyOn(fs.promises, 'mkdtemp').mockImplementation((prefix, ...args) => String(prefix).includes('neconyan-assistant-update-')
            ? Promise.reject(new Error('Temporary storage unavailable')) : mkdtemp(prefix, ...args));
        try {
            expect((await requestJson('/api/characters/assistants/update-copy', { id: 'nori-female', avatar: old.installed.avatar })).status).toBe(500);
            expect(fs.readFileSync(old.cardPath).equals(old.bytes)).toBe(true);
            expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toEqual([old.installed.avatar]);
            expect(fs.readdirSync(path.join(directories.characters, 'Neconyan Assistants'))).toHaveLength(1);
        } finally {
            fail.mockRestore();
        }
        const retry = await requestJson('/api/characters/assistants/update-copy', { id: 'nori-female', avatar: old.installed.avatar });
        expect(retry.status).toBe(200);
        expect((await retry.json()).avatar).not.toBe(old.installed.avatar);
    });

    test('ships the revised personalities in the actual installed PNG payloads', () => {
        const voices = new Set();
        for (const personality of manifest.personalities) {
            const variants = personality.variants.map(variant => {
                const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'default/content/assistants', variant.source), 'utf8'));
                const packed = JSON.parse(readCard(fs.readFileSync(path.join(repoRoot, 'default/content/assistants', variant.card))));
                expect(packed.data).toEqual(source.data);
                expect(source.data.character_version).toBe('1.0');
                expect(source.data.description).not.toContain('calico');
                expect(source.data.description).toContain({ miso: 'tiger stripes', taro: 'blue-grey', nori: 'tuxedo' }[personality.id]);
                expect(source.data.description).toContain('`Interviewer`:');
                expect(source.data.mes_example).toContain('<START>');
                expect(source.data.alternate_greetings).toHaveLength(3);
                expect(source.data.extensions.depth_prompt).toMatchObject({ depth: 4, role: 'system' });
                expect(source.data.extensions.depth_prompt.prompt).toMatch(/^\[[\s\S]*'s persona:[\s\S]*\]$/);
                expect(JSON.stringify(source.data)).not.toMatch(/NSFW|sexual|erotic|\bsex\b|\u2014/i);
                expect(source.data.extensions.neconyan_assistant).toMatchObject({ id: variant.id, gender: variant.gender, pronouns: variant.pronouns, version: 1 });
                return source.data;
            });
            expect(new Set(variants.map(variant => variant.personality)).size).toBe(1);
            voices.add(variants[0].personality);
        }
        expect(voices.size).toBe(3);
    });

    test('exposes only the safe nine-variant catalog and approved portraits', async () => {
        const response = await fetch(`${baseUrl}/api/characters/assistants`);
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.personalities).toHaveLength(3);
        expect(payload.personalities.flatMap(personality => personality.variants)).toHaveLength(9);
        expect(JSON.stringify(payload)).not.toMatch(/card|expressions|source/);

        const portraitUrl = payload.personalities.flatMap(item => item.variants).find(item => item.id === 'miso-male').portrait;
        expect(portraitUrl).toBe('/api/characters/assistants/miso-male/portrait?v=1');
        const portrait = await fetch(`${baseUrl}${portraitUrl}`);
        expect(portrait.status).toBe(200);
        expect(portrait.headers.get('content-type')).toMatch(/^image\/png/);
        expect((await fetch(`${baseUrl}/api/characters/assistants/%2e%2e%2fmiso-male/portrait`)).status).toBe(404);
        expect((await requestJson('/api/characters/assistants/install', { id: '../miso-male' })).status).toBe(400);
    });

    test('installs all variants atomically, preserves edits, and reuses concurrent retries', async () => {
        const spriteRoot = path.join(directories.characters, 'Neconyan Assistants');
        fs.mkdirSync(path.join(spriteRoot, 'taro-male'), { recursive: true });
        fs.writeFileSync(path.join(spriteRoot, 'taro-male', 'user-file.txt'), 'keep me');

        const firstResults = await Promise.all(variantIds.map(async id => {
            const response = await requestJson('/api/characters/assistants/install', { id });
            expect(response.status).toBe(200);
            return response.json();
        }));
        expect(firstResults).toHaveLength(9);
        expect(firstResults.every(result => result.created)).toBe(true);
        expect(new Set(firstResults.map(result => result.avatar)).size).toBe(9);
        expect(new Set(firstResults.map(result => result.spriteFolder)).size).toBe(9);

        const cards = fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'));
        expect(cards).toHaveLength(9);
        for (const result of firstResults) {
            const card = JSON.parse(readCard(fs.readFileSync(path.join(directories.characters, result.avatar))));
            expect(card.data.extensions.neconyan_assistant.id).toBe(result.id);
            const spritePath = path.join(directories.characters, result.spriteFolder);
            const expressions = fs.readdirSync(spritePath)
                .filter(file => /\.(?:webp|png|jpe?g)$/i.test(file))
                .map(file => path.parse(file).name);
            expect(new Set(expressions)).toEqual(expectedExpressionNames);
            expect(fs.readdirSync(spritePath).filter(file => file.endsWith('.webp'))).toHaveLength(28);
        }
        expect(fs.readFileSync(path.join(spriteRoot, 'taro-male', 'user-file.txt'), 'utf8')).toBe('keep me');
        expect(firstResults.find(result => result.id === 'taro-male').spriteFolder).toBe('Neconyan Assistants/taro-male-1');

        const chosen = firstResults.find(result => result.id === 'miso-male');
        const chosenCardPath = path.join(directories.characters, chosen.avatar);
        const beforeEdit = JSON.parse(readCard(fs.readFileSync(chosenCardPath)));
        beforeEdit.data.name = 'My edited Miso';
        fs.writeFileSync(chosenCardPath, writeCard(fs.readFileSync(chosenCardPath), JSON.stringify(beforeEdit)));
        const editedSprite = path.join(directories.characters, chosen.spriteFolder, 'neutral.webp');
        fs.writeFileSync(editedSprite, 'user expression override');

        const retries = await Promise.all([
            requestJson('/api/characters/assistants/install', { id: 'miso-male', preferred_avatar: chosen.avatar }),
            requestJson('/api/characters/assistants/install', { id: 'miso-male', preferred_avatar: chosen.avatar }),
        ]);
        const retryResults = await Promise.all(retries.map(response => {
            expect(response.status).toBe(200);
            return response.json();
        }));
        expect(retryResults[0]).toEqual(retryResults[1]);
        expect(retryResults[0]).toMatchObject({ id: 'miso-male', avatar: chosen.avatar, spriteFolder: chosen.spriteFolder, created: false });
        expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toHaveLength(9);
        expect(JSON.parse(readCard(fs.readFileSync(chosenCardPath))).data.name).toBe('My edited Miso');
        expect(fs.readFileSync(editedSprite, 'utf8')).toBe('user expression override');
    });

    test('first-install concurrency stays idempotent and profiles remain separate', async () => {
        const otherRoot = path.join(tempRoot, 'other-profile');
        otherDirectories = Object.fromEntries(Object.entries(directories).map(([key, value]) => [key, path.join(otherRoot, path.relative(tempRoot, value))]));
        Object.values(otherDirectories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
        const responses = await Promise.all([
            requestJson('/api/characters/assistants/install', { id: 'nori-neutral' }),
            requestJson('/api/characters/assistants/install', { id: 'nori-neutral' }),
            requestJson('/api/characters/assistants/install', { id: 'nori-neutral' }, { 'x-test-profile': 'other' }),
        ]);
        expect(responses.every(response => response.ok)).toBe(true);
        const results = await Promise.all(responses.map(response => response.json()));
        expect(results[0].avatar).toBe(results[1].avatar);
        expect(results.slice(0, 2).filter(result => result.created)).toHaveLength(1);
        expect(results[2].created).toBe(true);
        for (const profile of [directories, otherDirectories]) {
            expect(fs.readdirSync(profile.characters).filter(file => file.endsWith('.png'))).toHaveLength(1);
        }
    });

    test('a sprite copy failure leaves no card and retry completes the same install', async () => {
        const copyFile = fs.promises.copyFile.bind(fs.promises);
        const copy = jest.spyOn(fs.promises, 'copyFile').mockImplementation((source, destination, ...args) => {
            if (String(source).endsWith('.webp')) return Promise.reject(new Error('Simulated storage failure'));
            return copyFile(source, destination, ...args);
        });
        try {
            expect((await requestJson('/api/characters/assistants/install', { id: 'miso-female' })).status).toBe(500);
            expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toHaveLength(0);
            expect(fs.readdirSync(path.join(directories.characters, 'Neconyan Assistants'))).toHaveLength(0);
        } finally {
            copy.mockRestore();
        }
        const retry = await requestJson('/api/characters/assistants/install', { id: 'miso-female' });
        expect(retry.status).toBe(200);
        expect((await retry.json()).created).toBe(true);
    });

    (process.platform === 'win32' ? describe.skip : describe)('POSIX symlink handling', () => {
        test('rejects a sprite-root escape and preserves a dangling collision link', async () => {
            const root = path.join(directories.characters, 'Neconyan Assistants');
            const outside = path.join(tempRoot, 'outside-characters');
            fs.mkdirSync(outside);
            fs.symlinkSync(outside, root, 'dir');
            expect((await requestJson('/api/characters/assistants/install', { id: 'taro-male' })).status).toBe(500);
            expect(fs.readdirSync(outside)).toEqual([]);
            expect(fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'))).toHaveLength(0);
            fs.unlinkSync(root);
            fs.mkdirSync(root);
            const dangling = path.join(root, 'taro-male');
            fs.symlinkSync(path.join(outside, 'missing'), dangling, 'dir');
            const response = await requestJson('/api/characters/assistants/install', { id: 'taro-male' });
            expect(response.status).toBe(200);
            expect((await response.json()).spriteFolder).toBe('Neconyan Assistants/taro-male-1');
            expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
        });
    });

    test('rechecks physical bundle containment before serving or installing assets', async () => {
        const realpath = fs.realpathSync.bind(fs);
        const assetRoot = path.join(repoRoot, 'default/content/assistants/miso-male');
        const resolve = jest.spyOn(fs, 'realpathSync').mockImplementation((file, ...args) => String(file).startsWith(assetRoot)
            ? path.join(tempRoot, 'outside-bundle') : realpath(file, ...args));
        try {
            expect((await fetch(`${baseUrl}/api/characters/assistants/miso-male/portrait`)).status).toBe(404);
            expect((await requestJson('/api/characters/assistants/install', { id: 'miso-male' })).status).toBe(500);
            expect(fs.readdirSync(directories.characters)).toEqual([]);
        } finally {
            resolve.mockRestore();
        }
    });
});
