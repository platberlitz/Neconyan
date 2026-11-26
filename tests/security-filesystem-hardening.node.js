import { fixture, png } from './roleplay-transactions-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import express from 'express';
import '../src/fetch-patch.js';
const { importRelativePath } = await import('../src/operations/account-import-sources.js');
const { assertBoundedImage, readBoundedJimp } = await import('../src/jimp-safe.js');
const { extractFileFromZipBuffer } = await import('../src/util.js');
const { persistCharXAssets } = await import('../src/charx.js');
const { retainUploadedArchive, readUploadedArchive, pruneUploadedArchives } = await import('../src/operations/input-files.js');
const { roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { router: charactersRouter, diskCache: characterDiskCache } = await import('../src/endpoints/characters.js');
characterDiskCache.dispose();
const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { router: assetsRouter } = await import('../src/endpoints/assets.js');
const { router: operationsRouter } = await import('../src/endpoints/operations.js');
const { validateConversationAttachments } = await import('../src/endpoints/conversation-utils.js');
const { ByafParser } = await import('../src/byaf.js');
const { read: readCharacterCardPng } = await import('../src/character-card-parser.js');

function invoke(router, method, url, overrides = {}) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            Object.assign(req, overrides);
            next();
        });
        app.use(router);
        const server = app.listen(0, '127.0.0.1', async () => {
            try {
                const { port } = server.address();
                const response = await fetch(`http://127.0.0.1:${port}${url}`, {
                    method,
                    headers: overrides.body ? { 'Content-Type': 'application/json' } : {},
                    body: overrides.body ? JSON.stringify(overrides.body) : undefined,
                });
                const text = await response.text();
                let json;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: response.status, text, json });
            } catch (error) {
                reject(error);
            } finally {
                server.closeAllConnections();
                server.close();
            }
        });
    });
}

async function zipBuffer(entries) {
    const zip = archiver('zip');
    const chunks = [];
    zip.on('data', chunk => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject); });
    for (const [name, bytes] of entries) zip.append(bytes, { name });
    await zip.finalize();
    await done;
    return Buffer.concat(chunks);
}

async function zipFile(filename, entries) {
    const output = fs.createWriteStream(filename);
    const done = finished(output);
    output.end(await zipBuffer(entries));
    await done;
}

function pngHeader(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(13);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
}

function account(t) {
    const f = fixture(t);
    const directories = { ...f.scope.directories, assets: path.join(f.scope.directories.root, 'assets'), userImages: path.join(f.scope.directories.root, 'user', 'images') };
    fs.mkdirSync(directories.assets, { recursive: true });
    fs.mkdirSync(directories.userImages, { recursive: true });
    const base = { owner: 'fixture', directories };
    const user = { profile: { handle: 'fixture' }, directories };
    return { f, base, user, directories };
}

test('account import drops Git metadata in any spelling, including short names and bare repositories inside extensions', () => {
    for (const relative of [
        'extensions/Example/.git/config',
        'extensions/Example/.GIT/hooks/post-checkout',
        'extensions/Example/.git. /config',
        'extensions/Example/GIT~1/config',
        'extensions/Example/.gitmodules',
        'chats/.git/HEAD',
        'extensions/Example/HEAD',
        'extensions/Example/config',
        'extensions/Example/packed-refs',
        'extensions/Example/hooks/pre-commit',
        'extensions/Example/objects/aa/bb',
        'extensions/Example/refs/heads/main',
        'extensions/Example/info/attributes',
    ]) {
        assert.equal(importRelativePath(relative), null, relative);
    }
    for (const relative of ['extensions/Example/index.js', 'extensions/Example/src/hooks/useThing.js', 'extensions/Example/config.json', 'chats/Nova/Chat.jsonl', 'settings.json']) {
        assert.equal(importRelativePath(relative), relative, relative);
    }
});

test('image bounds are checked from the header before any decode', async () => {
    assert.throws(() => assertBoundedImage(pngHeader(20000, 10)), { status: 413, code: 'IMAGE_TOO_LARGE' });
    assert.throws(() => assertBoundedImage(pngHeader(9000, 9000)), { status: 413, code: 'IMAGE_TOO_LARGE' });
    assert.doesNotThrow(() => assertBoundedImage(pngHeader(4096, 4096)));
    await assert.rejects(readBoundedJimp(pngHeader(16385, 16385)), { status: 413 });
    await assert.rejects(readBoundedJimp(Buffer.from('not an image')), { status: 400 });
    const image = await readBoundedJimp(png);
    assert.equal(image.bitmap.width, 1);
});

test('ZIP lookups match exact relative paths and keep nested root folders working', async () => {
    const archive = await zipBuffer([
        ['Root/manifest.json', '{"root":true}'],
        ['Root/scenarios/xscen.json', 'wrong'],
        ['Root/scenarios/scen.json', 'right'],
    ]);
    assert.equal((await extractFileFromZipBuffer(archive, 'manifest.json')).toString(), '{"root":true}');
    assert.equal((await extractFileFromZipBuffer(archive, 'scenarios/scen.json')).toString(), 'right');
    assert.equal((await extractFileFromZipBuffer(archive, './scenarios/scen.json')).toString(), 'right');
    assert.equal(await extractFileFromZipBuffer(archive, 'scen.json'), null);
    assert.equal(await extractFileFromZipBuffer(archive, '../manifest.json'), null);
    assert.equal((await extractFileFromZipBuffer(archive, '.json'))?.length > 0, true);
});

test('CharX assets refuse to use the top-level characters folder', t => {
    const { directories } = account(t);
    const keep = path.join(directories.characters, 'Nova.png');
    const assets = [{ type: 'emotion', name: 'happy', ext: 'png', uri: 'embeded://assets/happy.png' }];
    const buffers = new Map([['assets/happy.png', png]]);
    for (const folder of ['', '.', '..', '../escape', 'a/b']) {
        assert.throws(() => persistCharXAssets(assets, buffers, directories, folder), /outside a character folder/, folder);
    }
    assert.equal(fs.existsSync(keep), true);
});

test('malformed character and chat requests get 400 instead of crashing the server', async t => {
    const { user } = account(t);
    let response = await invoke(charactersRouter, 'POST', '/rename', { user, body: { avatar_url: 'Nova.png', new_name: ['Nova'] } });
    assert.equal(response.status, 400);
    response = await invoke(charactersRouter, 'POST', '/rename', { user, body: { avatar_url: 'Nova.png', new_name: '///' } });
    assert.equal(response.status, 400);
    response = await invoke(charactersRouter, 'POST', '/edit', { user, body: { ch_name: 'Nova' } });
    assert.equal(response.status, 400);
    response = await invoke(chatsRouter, 'POST', '/export', { user, body: { avatar_url: 'Nova.png', file: { name: 'Source.jsonl' }, is_group: false } });
    assert.equal(response.status, 400);
    response = await invoke(chatsRouter, 'POST', '/export', { user, body: { avatar_url: 'Nova.png', file: 'Missing.jsonl', format: 'jsonl', is_group: false } });
    assert.equal(response.status, 404);
    assert.equal(response.text.includes(user.directories.root), false);
    response = await invoke(chatsRouter, 'POST', '/search', { user, body: { query: '', avatar_url: '...png' } });
    assert.equal(response.status, 400);
    response = await invoke(assetsRouter, 'POST', '/delete', { user, body: { category: 'bgm', filename: ['x.mp3'] } });
    assert.equal(response.status, 400);
});

test('import uploads reject non-ZIP bytes and stop piling up idle retained inputs', async t => {
    const { base, user, f } = account(t);
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-import-input-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const garbage = path.join(sourceRoot, 'garbage.zip');
    fs.writeFileSync(garbage, Buffer.alloc(64, 1));
    const refused = await invoke(operationsRouter, 'POST', '/import-input', { user, file: { path: garbage }, body: { key: 'garbage' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'IMPORT_NOT_ZIP');
    assert.equal(fs.existsSync(garbage), false);

    const inputs = [];
    for (let index = 0; index < 6; index++) {
        const upload = path.join(sourceRoot, `upload-${index}.zip`);
        await zipFile(upload, [[`settings-${index}.json`, '{}']]);
        inputs.push(await retainUploadedArchive(base, f.scope, `key-${index}`, upload));
    }
    const extra = path.join(sourceRoot, 'extra.zip');
    await zipFile(extra, [['extra.json', '{}']]);
    await assert.rejects(retainUploadedArchive(base, f.scope, 'key-extra', extra), { status: 429, code: 'IMPORT_UPLOAD_LIMIT' });

    const root = path.join(roleplayStoreDirectory(base), 'application-inputs');
    const idle = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(path.join(root, `${inputs[0].id}.json`), idle, idle);
    const accepted = await retainUploadedArchive(base, f.scope, 'key-extra', extra);
    assert.equal(fs.existsSync(accepted.filename), true);
    assert.equal(readUploadedArchive(base, f.scope, 'key-0'), null);
    assert.equal(fs.existsSync(inputs[0].filename), false);

    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.join(root, `${inputs[1].id}.json`), stale, stale);
    pruneUploadedArchives(base, f.scope);
    assert.equal(fs.existsSync(inputs[1].filename), false);
    assert.equal(readUploadedArchive(base, f.scope, 'key-2').id, inputs[2].id);
});

test('character card import strips forged neconyan_assistant metadata', async t => {
    const { user, directories } = account(t);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-card-assistant-strip-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const uploadPath = path.join(tmp, 'forged.json');
    fs.writeFileSync(uploadPath, JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Forged Helper',
        extensions: { neconyan_assistant: { id: 'miso-male', version: 1 } },
        data: {
            name: 'Forged Helper',
            description: 'Pretends to be an assistant',
            extensions: { neconyan_assistant: { id: 'miso-male', version: 1 }, benign: 'kept' },
        },
    }));

    const imported = await invoke(charactersRouter, 'POST', '/import', {
        user,
        file: { destination: tmp, filename: 'forged.json', originalname: 'forged.json' },
        body: { file_type: 'json' },
    });
    assert.equal(imported.status, 200);
    const avatarFile = path.join(directories.characters, `${imported.json.file_name}.png`);
    const saved = JSON.parse(readCharacterCardPng(fs.readFileSync(avatarFile)));
    assert.equal(saved.data?.extensions?.neconyan_assistant, undefined);
    assert.equal(saved.extensions?.neconyan_assistant, undefined);
    assert.equal(saved.data?.extensions?.benign, 'kept');
});

test('validateConversationAttachments rejects dangerous schemes while keeping safe attachment URLs', () => {
    assert.deepEqual(validateConversationAttachments({
        image_url: '/user/images/pic.png',
        attachments: [{ url: 'selfie.png' }, { url: 'https://example.com/a.png' }, { url: 'data:image/png;base64,iVBORw0KGgo=' }],
        files: [{ url: 'data:application/pdf;base64,JVBERi0=' }],
    }), { valid: true });

    for (const badUrl of [
        'javascript:alert(1)',
        'vbscript:msgbox(1)',
        'data:text/html,<script>alert(1)</script>',
        'data:image/svg+xml;base64,PHN2Zz4=',
        'file:///etc/passwd',
        'blob:https://example.com/123',
        '//evil.example/x.png',
        '/\\evil.example/x.png',
        'https://example.com/\r\nX-Injected: 1',
    ]) {
        assert.equal(validateConversationAttachments({ attachments: [{ url: badUrl }] }).valid, false, `attachment should reject ${badUrl}`);
        assert.equal(validateConversationAttachments({ image_url: badUrl }).valid, false, `image_url should reject ${badUrl}`);
    }
    assert.equal(validateConversationAttachments({ image_url: 'data:application/pdf;base64,JVBERi0=' }).valid, false);
});

test('ByafParser enforces a shared JSON budget across scenarios and deduplicates repeated paths', async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-byaf-budget-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const zipPath = path.join(tmp, 'bomb.byaf');
    const filler = 'A'.repeat(9 * 1024 * 1024);
    const makeScenario = title => JSON.stringify({
        schemaVersion: 1,
        title,
        narrative: filler,
        firstMessages: [],
        exampleMessages: [],
    });
    const manifest = JSON.stringify({
        schemaVersion: 1,
        created: new Date().toISOString(),
        author: { name: 'test', website: '' },
        characters: ['character.json'],
        scenarios: ['s1.json', './s1.json', 's1.json', 's2.json', 's3.json', 's4.json'],
    });
    const character = JSON.stringify({
        schemaVersion: 1,
        id: 'c1',
        name: 'Test',
        displayName: 'Test',
        isNSFW: false,
        persona: 'p',
        loreItems: [],
        images: [],
    });
    await zipFile(zipPath, [
        ['manifest.json', manifest],
        ['character.json', character],
        ['s1.json', makeScenario('one')],
        ['s2.json', makeScenario('two')],
        ['s3.json', makeScenario('three')],
        ['s4.json', makeScenario('four')],
    ]);
    const buf = fs.readFileSync(zipPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const parsed = await new ByafParser(ab).parse();
    assert.deepEqual(parsed.scenarios.map(s => s.title), ['one', 'two', 'three']);
});
