/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { setConfigFilePath } from '../src/util.js';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { write as writeCard } from '../src/character-card-parser.js';

setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const retirement = await import('../src/endpoints/content-manager.js');

const roots = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function directoriesFor(root) {
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
    return directories;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-'));
    roots.push(root);
    const target = path.join(root, 'fixture.json');
    fs.writeFileSync(target, 'original bundle');
    const item = { stableName: 'fixture', filename: 'presets/fixture.json', filenameHash: digest('presets/fixture.json'), type: 'background', hashes: [digest('original bundle')] };
    const context = {
        getRetiredContentHash: retirement.getRetiredContentHash,
        getRetiredContentCandidates: (directories, log) => retirement.getRetiredContentCandidates({ ...directories, backgrounds: root }, log, [item]),
    };
    return { root, target, item, context };
}
afterEach(() => { jest.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

describe('retired bundle inventory', () => {
    test('only identifies exact logged content and never moves it', () => {
        const { root, target, item, context } = fixture();
        expect(context.getRetiredContentCandidates({ root }, [item.filename])).toHaveLength(1);
        expect(fs.readFileSync(target, 'utf8')).toBe('original bundle');
        expect(context.getRetiredContentCandidates({ root }, [])).toHaveLength(0);
        fs.writeFileSync(target, 'an edited bundle');
        expect(context.getRetiredContentCandidates({ root }, [item.filename])).toHaveLength(0);
    });
    test('preserves symlinks and handles absent files', () => {
        const { root, target, item, context } = fixture();
        const original = path.join(root, 'original.json');
        fs.renameSync(target, original);
        expect(context.getRetiredContentCandidates({ root }, [item.filename])).toHaveLength(0);
        fs.symlinkSync(original, target);
        expect(context.getRetiredContentCandidates({ root }, [item.filename])).toHaveLength(0);
        expect(fs.readFileSync(original, 'utf8')).toBe('original bundle');
    });
    test('hashes directories by sorted paths and bytes', () => {
        const { root, context } = fixture();
        const folder = path.join(root, 'sprites');
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'b.txt'), 'b');
        fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
        const first = context.getRetiredContentHash(folder);
        fs.unlinkSync(path.join(folder, 'a.txt'));
        fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
        expect(context.getRetiredContentHash(folder)).toBe(first);
        fs.writeFileSync(path.join(folder, 'a.txt'), 'changed');
        expect(context.getRetiredContentHash(folder)).not.toBe(first);
    });
    test('every active catalog entry has a source', () => {
        const folder = new URL('../default/content/', import.meta.url);
        const catalog = JSON.parse(fs.readFileSync(new URL('index.json', folder), 'utf8'));
        expect(catalog.filter(item => item.type === 'character')).toEqual([]);
        for (const item of catalog) expect(fs.existsSync(new URL(item.filename, folder))).toBe(true);
    });

    test('catalog contains the prepared backgrounds and avatar replacement', () => {
        expect(retirement.RETIRED_CONTENT_ITEMS.filter(item => item.type === 'background')).toHaveLength(22);
        const avatar = retirement.RETIRED_CONTENT_ITEMS.find(item => item.stableName === 'default-avatar');
        expect(avatar).toMatchObject({ action: 'replace', replacementHash: 'bf89657f0d536f2804976bb6b5988d637c92a69766e2b9078608e954630a37d2' });
        expect(avatar.hashes).toEqual(['ddf571f53289685b253d455a05f92b5ba1c11683314db2c1350a8542a5f83a0f']);
    });

    test('archives exact bytes and restores into a collision-safe name', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-archive-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const filename = 'backgrounds/fixture.jpg';
        const bytes = Buffer.from('untouched bytes');
        const item = { stableName: 'fixture', filename, filenameHash: digest(filename), type: 'background', hashes: [digest(bytes)] };
        fs.writeFileSync(path.join(root, 'content.log'), `${filename}\n`);
        fs.writeFileSync(path.join(directories.backgrounds, 'fixture.jpg'), bytes);
        expect(retirement.archiveRetiredContent(directories, ['fixture'], [item]).results[0].ok).toBe(true);
        const indexPath = path.join(directories.backups, '_neconyan-retired-content', 'index.json');
        const record = JSON.parse(fs.readFileSync(indexPath, 'utf8')).records[0];
        fs.writeFileSync(path.join(directories.backgrounds, 'fixture.jpg'), 'new user file');
        const restored = retirement.restoreRetiredContent(directories, record.id, [item]);
        expect(restored.name).toBe('fixture (restored).jpg');
        expect(fs.readFileSync(path.join(directories.backgrounds, restored.name))).toEqual(bytes);
        expect(fs.readFileSync(path.join(root, 'content.log'), 'utf8')).toBe(`${filename}\n`);
    });

    test('does not inventory symlinks, escaped targets, or changed files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-safety-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const filename = 'backgrounds/fixture.jpg';
        const bytes = Buffer.from('untouched bytes');
        const item = { stableName: 'fixture', filename, filenameHash: digest(filename), type: 'background', hashes: [digest(bytes)] };
        fs.writeFileSync(path.join(root, 'content.log'), `${filename}\n`);
        const outsideDirectory = path.join(root, '..', `${path.basename(root)}-outside`);
        const outside = path.join(outsideDirectory, 'fixture.jpg');
        roots.push(outsideDirectory);
        fs.mkdirSync(outsideDirectory, { recursive: true });
        fs.writeFileSync(outside, bytes);
        fs.symlinkSync(outside, path.join(directories.backgrounds, 'fixture.jpg'));
        expect(retirement.getRetiredContentCandidates(directories, [filename], [item])).toEqual([]);
        fs.unlinkSync(path.join(directories.backgrounds, 'fixture.jpg'));
        fs.writeFileSync(path.join(directories.backgrounds, 'fixture.jpg'), 'edited');
        expect(retirement.getRetiredContentCandidates(directories, [filename], [item])).toEqual([]);
        const escaped = { ...directories, backgrounds: outsideDirectory };
        expect(retirement.getRetiredContentCandidates(escaped, [filename], [item])).toEqual([]);
        fs.rmSync(outsideDirectory, { recursive: true, force: true });
    });

    test('protects selected characters, assistants, nested lorebooks, and presets', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-references-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const entries = [
            ['characters/Mittens.png', 'character', 'Mittens.png', writeCard(fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url)), JSON.stringify({ name: 'Mittens' }))],
            ['worlds/OldBook.json', 'world', 'OldBook.json', '{}'],
            ['OpenAI Settings/Old.json', 'openai_preset', 'Old.json', '{}'],
        ];
        const items = entries.map(([filename, type, name, value]) => ({ stableName: type, filename, filenameHash: digest(filename), type, hashes: [digest(value)] }));
        fs.writeFileSync(path.join(root, 'content.log'), `${entries.map(entry => entry[0]).join('\n')}\n`);
        const targetByType = { character: directories.characters, world: directories.worlds, openai_preset: directories.openAI_Settings };
        for (const [, type, name, value] of entries) {
            const target = targetByType[type];
            fs.writeFileSync(path.join(target, name), value);
        }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            active_character: 'Mittens.png',
            accountStorage: { assistant: 'Mittens.png' },
            world_info_settings: { world_info: { globalSelect: ['OldBook.json'], charLore: [{ name: 'Mittens', extraBooks: ['OldBook.json'] }] } },
            oai_settings: { preset_settings_openai: 'Old.json' },
        }));
        const inventory = retirement.inspectRetiredContent(directories, items);
        expect(inventory.candidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'character', state: 'in-use' }),
            expect.objectContaining({ id: 'world', state: 'in-use' }),
            expect.objectContaining({ id: 'openai_preset', state: 'in-use' }),
        ]));
    });

    test('keeps successful partial archives and recovers pending records', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-partial-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const goodName = 'backgrounds/good.jpg';
        const badName = 'backgrounds/changed.jpg';
        const good = Buffer.from('good');
        const bad = Buffer.from('bad');
        const items = [
            { stableName: 'good', filename: goodName, filenameHash: digest(goodName), type: 'background', hashes: [digest(good)] },
            { stableName: 'bad', filename: badName, filenameHash: digest(badName), type: 'background', hashes: [digest(bad)] },
        ];
        fs.writeFileSync(path.join(root, 'content.log'), `${goodName}\n${badName}\n`);
        fs.writeFileSync(path.join(directories.backgrounds, 'good.jpg'), good);
        fs.writeFileSync(path.join(directories.backgrounds, 'changed.jpg'), 'edited');
        const report = retirement.archiveRetiredContent(directories, ['good', 'bad'], items);
        expect(report.results).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'good', ok: true }),
            expect.objectContaining({ id: 'bad', ok: false }),
        ]));
        expect(fs.existsSync(path.join(directories.backgrounds, 'changed.jpg'))).toBe(true);
        const indexPath = path.join(directories.backups, '_neconyan-retired-content', 'index.json');
        const archive = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const pendingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const pendingPayload = path.join(directories.backups, '_neconyan-retired-content', 'records', pendingId, 'payload');
        fs.mkdirSync(path.dirname(pendingPayload), { recursive: true });
        fs.writeFileSync(pendingPayload, good);
        archive.records.push({ id: pendingId, itemId: 'good', type: 'background', name: 'good.jpg', kind: 'file', hash: digest(good), payload: `records/${pendingId}/payload`, status: 'pending', archivedAt: null, restoredName: null, restoredAt: null });
        fs.writeFileSync(indexPath, JSON.stringify(archive));
        const reconciled = retirement.inspectRetiredContent(directories, items);
        expect(reconciled.archived).toEqual(expect.arrayContaining([expect.objectContaining({ id: pendingId, status: 'archived' })]));
    });

    test('replaces the default avatar and keeps archive bytes for idempotent restore', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-avatar-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const oldBytes = Buffer.from('old avatar bytes');
        const bundledPath = path.join(new URL('../default/content/user-default.png', import.meta.url).pathname);
        const item = { stableName: 'avatar', filename: 'user-default.png', filenameHash: digest('user-default.png'), type: 'avatar', hashes: [digest(oldBytes)], replacementHash: digest(fs.readFileSync(bundledPath)), action: 'replace' };
        fs.writeFileSync(path.join(root, 'content.log'), 'user-default.png\n');
        fs.writeFileSync(path.join(directories.avatars, 'user-default.png'), oldBytes);
        const archived = retirement.archiveRetiredContent(directories, ['avatar'], [item]);
        expect(archived.results[0].ok).toBe(true);
        const indexPath = path.join(directories.backups, '_neconyan-retired-content', 'index.json');
        const record = JSON.parse(fs.readFileSync(indexPath, 'utf8')).records[0];
        expect(fs.readFileSync(path.join(directories.avatars, 'user-default.png'))).toEqual(fs.readFileSync(bundledPath));
        expect(retirement.archiveRetiredContent(directories, ['avatar'], [item]).results[0]).toMatchObject({ ok: true, replaced: true });
        expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).records).toHaveLength(1);
        fs.writeFileSync(path.join(directories.avatars, 'user-default.png'), 'user replacement');
        const first = retirement.restoreRetiredContent(directories, record.id, [item]);
        const second = retirement.restoreRetiredContent(directories, record.id, [item]);
        expect(first.name).toBe('user-default (restored).png');
        expect(second.name).toBe(first.name);
        expect(fs.readFileSync(path.join(directories.avatars, first.name))).toEqual(oldBytes);
    });

    test('rolls an avatar replacement back when installation fails', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-avatar-rollback-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const oldBytes = Buffer.from('old avatar bytes');
        const bundledPath = new URL('../default/content/user-default.png', import.meta.url).pathname;
        const item = { stableName: 'avatar', filename: 'user-default.png', filenameHash: digest('user-default.png'), type: 'avatar', hashes: [digest(oldBytes)], replacementHash: digest(fs.readFileSync(bundledPath)), action: 'replace' };
        fs.writeFileSync(path.join(root, 'content.log'), 'user-default.png\n');
        fs.writeFileSync(path.join(directories.avatars, 'user-default.png'), oldBytes);
        const copy = jest.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => { throw new Error('fixture install failure'); });
        try {
            const report = retirement.archiveRetiredContent(directories, ['avatar'], [item]);
            expect(report.results[0]).toEqual(expect.objectContaining({ id: 'avatar', ok: false, status: 'blocked' }));
        } finally {
            copy.mockRestore();
        }
        expect(fs.readFileSync(path.join(directories.avatars, 'user-default.png'))).toEqual(oldBytes);
    });

    test('fails closed on malformed archive paths without rewriting the index', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-index-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const indexPath = path.join(directories.backups, '_neconyan-retired-content', 'index.json');
        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        const malformed = JSON.stringify({ version: 1, records: [{ id: 'bad', itemId: 'fixture', type: 'background', name: 'fixture.jpg', kind: 'file', hash: digest('bad'), payload: '../outside', status: 'archived', archivedAt: null, restoredName: null, restoredAt: null }] });
        fs.writeFileSync(indexPath, malformed);
        expect(retirement.inspectRetiredContent(directories, [])).toEqual(expect.objectContaining({ candidates: [], archived: [] }));
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(malformed);
        expect(() => retirement.restoreRetiredContent(directories, 'bad', [{ stableName: 'fixture', filename: 'backgrounds/fixture.jpg', type: 'background' }])).toThrow();
    });

    test('binds mutation routes to the authenticated handle', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retirement-route-'));
        roots.push(root);
        const directories = directoriesFor(root);
        const filename = 'backgrounds/fixture.jpg';
        const bytes = Buffer.from('fixture');
        fs.writeFileSync(path.join(root, 'content.log'), `${filename}\n`);
        fs.writeFileSync(path.join(directories.backgrounds, 'fixture.jpg'), bytes);
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'fixture-user' }, directories };
            next();
        });
        app.use('/api/content', retirement.router);
        const server = app.listen(0);
        try {
            await new Promise(resolve => server.once('listening', resolve));
            const base = `http://127.0.0.1:${server.address().port}`;
            const listResponse = await fetch(`${base}/api/content/retired/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            expect(listResponse.status).toBe(200);
            expect((await listResponse.json()).handle).toBe('fixture-user');
            const staleResponse = await fetch(`${base}/api/content/retired/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'other-user', ids: ['fixture'] }) });
            expect(staleResponse.status).toBe(409);
            expect(fs.existsSync(path.join(directories.backgrounds, 'fixture.jpg'))).toBe(true);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});


const fixtureImage = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
function recoveryFixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-recovery-'));
    roots.push(base);
    const root = path.join(base, 'profile');
    const directories = directoriesFor(root);
    const catalog = [];
    const indexPath = path.join(directories.backups, '_neconyan-retired-content', 'index.json');
    const add = (type, name, bytes = '{}', extra = {}) => {
        const filename = type === 'avatar' ? name : `${type}/${name}`;
        const item = { stableName: `item-${catalog.length + 1}`, filename, filenameHash: digest(filename), type, hashes: [digest(bytes)], ...extra };
        const target = path.join(retirement.getUserTargetByType(type, directories), name);
        fs.writeFileSync(target, bytes);
        fs.appendFileSync(path.join(root, 'content.log'), `${filename}\n`);
        catalog.push(item);
        return { item, target, bytes: Buffer.from(bytes) };
    };
    const card = (name, world = '', display = path.parse(name).name) => add('character', name, writeCard(fixtureImage, JSON.stringify({ name: display, data: { name: display, extensions: { world } } })));
    const sprites = name => {
        const target = path.join(directories.characters, name);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'joy.png'), fixtureImage);
        const filename = `sprites/${name}`;
        const item = { stableName: `item-${catalog.length + 1}`, filename, filenameHash: digest(filename), type: 'sprites', hashes: [retirement.getRetiredContentHash(target)] };
        catalog.push(item);
        fs.appendFileSync(path.join(root, 'content.log'), `${filename}\n`);
        return { item, target };
    };
    const index = () => JSON.parse(fs.readFileSync(indexPath, 'utf8')).records;
    const writeIndex = records => {
        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, records }));
    };
    const pending = (entry, move = true) => {
        const id = randomUUID();
        const record = { id, itemId: entry.item.stableName, type: entry.item.type, name: path.basename(entry.target),
            kind: entry.item.type === 'sprites' ? 'directory' : 'file', hash: entry.item.hashes[0], payload: `records/${id}/payload`,
            status: 'pending', archivedAt: null, restoredName: null, restoredAt: null };
        const payload = path.join(path.dirname(indexPath), ...record.payload.split('/'));
        fs.mkdirSync(path.dirname(payload), { recursive: true });
        if (move) fs.renameSync(entry.target, payload);
        writeIndex([record]);
        return { record, payload };
    };
    return { base, root, directories, catalog, indexPath, add, card, sprites, index, writeIndex, pending,
        settings: value => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(value)),
        inspect: () => retirement.inspectRetiredContent(directories, catalog),
        archive: ids => retirement.archiveRetiredContent(directories, ids, catalog),
        restore: id => retirement.restoreRetiredContent(directories, id, catalog),
    };
}
function indexFault(fixture, number, after) {
    const rename = fs.renameSync;
    let writes = 0;
    return jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === fixture.indexPath && ++writes === number) {
            if (after) {
                rename(source, destination);
                after();
                return;
            }
            throw Object.assign(new Error(`fixture failure at ${destination}`), { code: 'EIO' });
        }
        return rename(source, destination);
    });
}

describe('retirement transaction and reference regressions', () => {
    test('retains every successful record in a multi-item batch and restores both originals', () => {
        const f = recoveryFixture();
        const first = f.add('background', 'first.jpg', 'first');
        const second = f.add('background', 'second.jpg', 'second');
        const log = fs.readFileSync(path.join(f.root, 'content.log'));
        expect(f.archive(f.catalog.map(item => item.stableName)).results.every(result => result.ok)).toBe(true);
        expect(f.index()).toHaveLength(2);
        for (const record of f.index()) f.restore(record.id);
        expect(fs.readFileSync(first.target)).toEqual(first.bytes);
        expect(fs.readFileSync(second.target)).toEqual(second.bytes);
        expect(fs.readFileSync(path.join(f.root, 'content.log'))).toEqual(log);
    });

    test.each([2, 3, 4])('index failure at write %s never orphans a moved source or drops earlier records', write => {
        const f = recoveryFixture();
        const entries = [f.add('background', 'first.jpg', 'first'), f.add('background', 'second.jpg', 'second')];
        const fault = indexFault(f, write);
        const result = f.archive(f.catalog.map(item => item.stableName));
        fault.mockRestore();
        expect(JSON.stringify(result)).not.toContain(f.root);
        const records = f.index();
        for (const entry of entries) {
            const record = records.find(record => record.itemId === entry.item.stableName);
            const retainedPath = fs.existsSync(entry.target) ? entry.target : record && path.join(path.dirname(f.indexPath), record.payload);
            expect(retainedPath).toBeDefined();
            expect(fs.readFileSync(retainedPath)).toEqual(entry.bytes);
        }
        const inspected = f.inspect();
        expect(inspected.archived.every(record => ['archived', 'restored'].includes(record.status))).toBe(true);
    });

    test.each(['bytes', 'reference'])('rechecks a new %s change after writing the pending record', kind => {
        const f = recoveryFixture();
        const entry = f.add('background', 'Old room.jpg', 'original');
        expect(f.inspect().candidates[0].state).toBe('ready');
        const fault = indexFault(f, 1, () => {
            if (kind === 'bytes') fs.writeFileSync(entry.target, 'edited');
            else f.settings({ background: { name: 'Old room.jpg' } });
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        fault.mockRestore();
        expect(fs.readFileSync(entry.target, 'utf8')).toBe(kind === 'bytes' ? 'edited' : 'original');
        expect(f.index()).toEqual([]);
    });

    test.each(['background', 'sprites'])('returns edited %s bytes to their original path after a post-move verification failure', type => {
        const f = recoveryFixture();
        const entry = type === 'sprites' ? f.sprites('Mittens') : f.add(type, 'old.jpg', 'original');
        const log = fs.readFileSync(path.join(f.root, 'content.log'));
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            rename(source, destination);
            if (source === entry.target) fs.writeFileSync(type === 'sprites' ? path.join(destination, 'joy.png') : destination, 'edited during archive');
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        const original = type === 'sprites' ? path.join(entry.target, 'joy.png') : entry.target;
        expect(fs.readFileSync(original, 'utf8')).toBe('edited during archive');
        const record = f.index()[0];
        const payload = path.join(path.dirname(f.indexPath), record.payload);
        expect(fs.readFileSync(type === 'sprites' ? path.join(payload, 'joy.png') : payload, 'utf8')).toBe('edited during archive');
        expect(f.inspect().archived[0].status).toBe('attention');
        expect(fs.readFileSync(path.join(f.root, 'content.log'))).toEqual(log);
    });

    test.each(['background', 'sprites'])('records a proven %s rollback without discarding its payload', type => {
        const f = recoveryFixture();
        const entry = type === 'sprites' ? f.sprites('Mittens') : f.add(type, 'old.jpg', 'original');
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            rename(source, destination);
            if (source === entry.target) throw new Error('Failure after move');
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        const record = f.index()[0];
        expect(record).toMatchObject({ status: 'restored', restoredName: path.basename(entry.target) });
        expect(retirement.getRetiredContentHash(entry.target)).toBe(entry.item.hashes[0]);
        expect(retirement.getRetiredContentHash(path.join(path.dirname(f.indexPath), record.payload))).toBe(entry.item.hashes[0]);
        expect(f.inspect().archived[0].status).toBe('restored');
    });

    test.each(['background', 'sprites'])('reconciles a completed %s rollback after its index write fails', type => {
        const f = recoveryFixture();
        const entry = type === 'sprites' ? f.sprites('Mittens') : f.add(type, 'old.jpg', 'original');
        const rename = fs.renameSync;
        let writes = 0;
        const fault = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (destination === f.indexPath && ++writes === 2) throw new Error('Rollback index failure');
            rename(source, destination);
            if (source === entry.target) throw new Error('Failure after move');
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        fault.mockRestore();
        expect(f.index()[0].status).toBe('pending');
        expect(f.inspect().archived[0].status).toBe('restored');
        expect(retirement.getRetiredContentHash(entry.target)).toBe(entry.item.hashes[0]);
        expect(f.index()).toHaveLength(1);
    });

    test.each(['background', 'sprites'])('preserves a racing %s source when rollback cannot claim its original path', type => {
        const f = recoveryFixture();
        const entry = type === 'sprites' ? f.sprites('Mittens') : f.add(type, 'old.jpg', 'original');
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            rename(source, destination);
            if (source === entry.target) {
                fs.writeFileSync(type === 'sprites' ? path.join(destination, 'joy.png') : destination, 'edited during archive');
                if (type === 'sprites') fs.mkdirSync(source);
                fs.writeFileSync(type === 'sprites' ? path.join(source, 'joy.png') : source, 'racing personal file');
            }
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        expect(fs.readFileSync(type === 'sprites' ? path.join(entry.target, 'joy.png') : entry.target, 'utf8')).toBe('racing personal file');
        expect(f.index()).toHaveLength(1);
        expect(f.inspect().archived[0].status).toBe('attention');
    });

    test.each([
        ['active character', 'character', 'Mittens.png', { active_character: 'Mittens.png' }],
        ['assistant', 'character', 'Mittens.png', { accountStorage: { assistant: 'Mittens.png' } }],
        ['tag map keys', 'character', 'Mittens.png', { tag_map: { 'Mittens.png': ['important'] } }],
        ['attachment owner keys', 'character', 'Mittens.png', { extension_settings: { character_attachments: { 'Mittens.png': [{ url: 'user/files/note.txt' }] } } }],
        ['expression override', 'character', 'Mittens.png', { extension_settings: { expressionOverrides: [{ name: 'Mittens', path: 'custom' }] } }],
        ['nested global lore', 'world', 'OldBook.json', { world_info_settings: { world_info: { globalSelect: ['OldBook'] } } }],
        ['legacy global lore', 'world', 'OldBook.json', { world_info: { globalSelect: ['OldBook'] } }],
        ['extra character lore', 'world', 'OldBook.json', { world_info_settings: { world_info: { charLore: [{ name: 'Mittens', extraBooks: ['OldBook'] }] } } }],
        ['persona lore', 'world', 'OldBook.json', { power_user: { persona_descriptions: { 'user.png': { lorebook: 'OldBook' } } } }],
        ['legacy persona lore', 'world', 'OldBook.json', { power_user: { persona_description_lorebook: 'OldBook' } }],
        ['OpenAI preset', 'openai_preset', 'Old.json', { oai_settings: { preset_settings_openai: 'Old' } }],
        ['context preset', 'context', 'Old.json', { power_user: { context: { preset: 'Old' } } }],
        ['instruct preset', 'instruct', 'Old.json', { power_user: { instruct: { preset: 'Old' } } }],
        ['system prompt preset', 'sysprompt', 'Old.json', { power_user: { sysprompt: { preset: 'Old' } } }],
        ['selected background', 'background', 'Old room.jpg', { background: { name: 'Old room.jpg' } }],
    ])('protects %s independently', (_name, type, name, settings) => {
        const f = recoveryFixture();
        const entry = type === 'character' ? f.card(name) : f.add(type, name);
        expect(f.inspect().candidates[0].state).toBe('ready');
        f.settings(settings);
        expect(f.inspect().candidates[0].state).toBe('in-use');
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        expect(fs.existsSync(entry.target)).toBe(true);
    });

    test.each(['members', 'disabled_members'])('protects group %s', key => {
        const f = recoveryFixture(); const entry = f.card('Mittens.png');
        fs.writeFileSync(path.join(f.directories.groups, 'group.json'), JSON.stringify({ [key]: ['Mittens.png'] }));
        expect(f.inspect().candidates[0].state).toBe('in-use');
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
    });

    test.each(['chats', 'groupChats'])('reads encoded backgrounds and Unicode lore from %s headers', key => {
        const f = recoveryFixture();
        f.add('background', 'Old room.jpg'); f.add('world', '桜の庭.json');
        const directory = key === 'chats' ? path.join(f.directories.chats, 'someone') : f.directories.groupChats;
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'chat.jsonl'), JSON.stringify({ chat_metadata: { custom_background: 'url("backgrounds/Old%20room.jpg")', world_info: '桜の庭' } }) + '\n');
        expect(f.inspect().candidates.map(candidate => candidate.state)).toEqual(['in-use', 'in-use']);
    });

    test('protects any saved character chat, including an empty or unreadable header', () => {
        const f = recoveryFixture(); f.card('Mittens.png');
        const directory = path.join(f.directories.chats, 'Mittens'); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'chat.jsonl'), '');
        expect(f.inspect().candidates[0].state).toBe('in-use');
    });

    test('folder assignments and covers protect backgrounds while cached dimensions do not', () => {
        const f = recoveryFixture(); f.add('background', 'Old room.jpg');
        const metadata = path.join(f.root, 'image-metadata.json');
        fs.writeFileSync(metadata, JSON.stringify({ images: { 'Old room.jpg': { folderIds: [], hash: 'cache', aspectRatio: 1 } }, folders: [] }));
        expect(f.inspect().candidates[0].state).toBe('ready');
        fs.writeFileSync(metadata, JSON.stringify({ images: { 'Old room.jpg': { folderIds: ['folder'] } }, folders: [] }));
        expect(f.inspect().candidates[0].state).toBe('in-use');
        fs.writeFileSync(metadata, JSON.stringify({ images: {}, folders: [{ id: 'folder', thumbnailFile: 'Old room.jpg' }] }));
        expect(f.inspect().candidates[0].state).toBe('in-use');
    });

    test.each([
        { images: {}, folders: {} },
        { images: [], folders: [] },
        { images: { 'Old room.jpg': null }, folders: [] },
        { images: { 'Old room.jpg': { folderIds: 'folder' } }, folders: [] },
        { images: { 'Old room.jpg': { folderIds: [null] } }, folders: [] },
        { images: {}, folders: [null] },
        { images: {}, folders: [{ id: 'folder', thumbnailFile: {} }] },
    ])('protects backgrounds when folder metadata is malformed: %j', metadata => {
        const f = recoveryFixture(); const entry = f.add('background', 'Old room.jpg');
        fs.writeFileSync(path.join(f.root, 'image-metadata.json'), JSON.stringify(metadata));
        expect(f.inspect().candidates[0].state).toBe('in-use');
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        expect(fs.readFileSync(entry.target)).toEqual(entry.bytes);
    });

    test('does not treat empty tags or empty attachment lists as active references', () => {
        const f = recoveryFixture(); f.card('Mittens.png');
        f.settings({ tag_map: { 'Mittens.png': [] }, extension_settings: { character_attachments: { 'Mittens.png': [] } } });
        expect(f.inspect().candidates[0].state).toBe('ready');
    });

    test('uses real card metadata for default_Seraphina sprite and lore dependencies', () => {
        const f = recoveryFixture();
        const character = f.card('default_Seraphina.png', 'Eldoria', 'Seraphina');
        const sprites = f.sprites('Seraphina');
        const world = f.add('world', 'Eldoria.json', JSON.stringify({ entries: { 0: { content: 'Eldoria' } } }));
        const list = f.inspect();
        for (const entry of [sprites, world]) expect(list.candidates.find(candidate => candidate.id === entry.item.stableName)).toMatchObject({ state: 'ready', dependencies: [character.item.stableName] });
        expect(f.archive([sprites.item.stableName]).results[0].ok).toBe(false);
        expect(f.archive([sprites.item.stableName, world.item.stableName, character.item.stableName]).results.every(result => result.ok)).toBe(true);
        expect(f.index()).toHaveLength(3);
    });

    test('retained cards keep dependent content protected after the selected card is archived', () => {
        const f = recoveryFixture(); const character = f.card('Mittens.png', 'OldBook');
        const sprites = f.sprites('Mittens'); const world = f.add('world', 'OldBook.json');
        fs.writeFileSync(path.join(f.directories.characters, 'personal.png'), writeCard(fixtureImage, JSON.stringify({ name: 'Mittens', data: { name: 'Mittens', extensions: { world: 'OldBook' } } })));
        const result = f.archive([character.item.stableName, sprites.item.stableName, world.item.stableName]);
        expect(result.results.filter(entry => entry.ok)).toHaveLength(1);
        expect(fs.existsSync(sprites.target)).toBe(true); expect(fs.existsSync(world.target)).toBe(true);
    });

    test('a failed selected character blocks its dependent archives', () => {
        const f = recoveryFixture(); const character = f.card('Mittens.png', 'OldBook');
        const world = f.add('world', 'OldBook.json');
        const fault = indexFault(f, 2);
        const report = f.archive([world.item.stableName, character.item.stableName]); fault.mockRestore();
        expect(report.results.every(result => !result.ok)).toBe(true);
        expect(fs.existsSync(world.target)).toBe(true);
        expect(f.index()).toHaveLength(1);
    });

    test.each(['groups', 'characters', 'chats', 'groupChats'])('a %s directory read failure protects affected content', key => {
        const f = recoveryFixture(); f.add('world', 'OldBook.json');
        const read = fs.readdirSync;
        jest.spyOn(fs, 'readdirSync').mockImplementation((directory, ...args) => {
            if (String(directory) === f.directories[key]) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return read(directory, ...args);
        });
        expect(f.inspect().candidates[0].state).toBe('in-use');
    });

    test.each(['over-limit', 'invalid UTF-8', 'malformed JSON'])('unreadable %s chat metadata stays protected', kind => {
        const f = recoveryFixture(); f.add('world', 'OldBook.json');
        const bytes = kind === 'over-limit' ? JSON.stringify({ padding: 'x'.repeat(128 * 1024), chat_metadata: { world_info: 'OldBook' } })
            : kind === 'invalid UTF-8' ? Buffer.from([0xc3, 0x28]) : '{broken';
        fs.writeFileSync(path.join(f.directories.groupChats, 'chat.jsonl'), bytes);
        expect(f.inspect().candidates[0].state).toBe('in-use');
    });

    test('rejects hard-linked candidates and metadata', () => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg');
        const link = path.join(f.base, 'other-link'); fs.linkSync(entry.target, link);
        expect(f.inspect().candidates).toEqual([]);
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        fs.unlinkSync(link);
        fs.linkSync(path.join(f.root, 'content.log'), link);
        expect(f.inspect().candidates).toEqual([]);
    });

    test('rejects linked files inside sprite directories', () => {
        const f = recoveryFixture(); const sprites = f.sprites('Mittens');
        fs.linkSync(path.join(sprites.target, 'joy.png'), path.join(f.base, 'other.png'));
        expect(f.inspect().candidates).toEqual([]);
    });

    /* eslint-disable jest/no-standalone-expect -- This platform-specific test uses Jest's real skip function. */
    (process.platform === 'win32' ? test.skip : test)('rejects FIFOs and sockets without opening them', async () => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg');
        fs.unlinkSync(entry.target); execFileSync('mkfifo', [entry.target]);
        expect(retirement.getRetiredContentHash(entry.target)).toBeNull();
        execFileSync('mkfifo', [path.join(f.root, 'settings.json')]);
        const socket = path.join(f.directories.backgrounds, 'socket.jpg');
        const server = net.createServer(); await new Promise(resolve => server.listen(socket, resolve));
        try { expect(retirement.getRetiredContentHash(socket)).toBeNull(); } finally { await new Promise(resolve => server.close(resolve)); }
    });
    /* eslint-enable jest/no-standalone-expect */

    test.each(['missing', 'corrupt', 'hard-linked'])('never reports an unsafe %s archived payload as an idempotent success', mode => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg');
        f.archive([entry.item.stableName]); const record = f.index()[0];
        const payload = path.join(path.dirname(f.indexPath), record.payload);
        if (mode === 'missing') fs.unlinkSync(payload);
        if (mode === 'corrupt') fs.writeFileSync(payload, 'corrupted');
        if (mode === 'hard-linked') fs.linkSync(payload, path.join(f.base, 'payload-link'));
        expect(f.inspect().archived[0].status).toBe('attention');
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        expect(() => f.restore(record.id)).toThrow();
    });

    test.each(['../escape.jpg', '..\\escape.jpg', 'NUL', '/absolute.jpg'])('rejects unsafe restoredName %s and leaves the index untouched', restoredName => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg'); f.archive([entry.item.stableName]);
        const records = f.index(); records[0].restoredName = restoredName; f.writeIndex(records);
        const original = fs.readFileSync(f.indexPath);
        expect(f.inspect().warnings.length).toBeGreaterThan(0);
        expect(() => f.restore(records[0].id)).toThrow();
        expect(fs.readFileSync(f.indexPath)).toEqual(original);
    });

    test('validates portable payload paths and rejects duplicate recovery IDs', () => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg'); f.archive([entry.item.stableName]);
        const records = f.index(); expect(records[0].payload).toBe(`records/${records[0].id}/payload`);
        expect(f.inspect().archived[0].status).toBe('archived');
        f.writeIndex([...records, records[0]]);
        expect(f.inspect().warnings.length).toBeGreaterThan(0);
    });

    test.each(['file', 'directory', 'dangling link'])('preserves an existing %s at the restore name', kind => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg', 'original'); f.archive([entry.item.stableName]);
        if (kind === 'file') fs.writeFileSync(entry.target, 'personal');
        if (kind === 'directory') fs.mkdirSync(entry.target);
        if (kind === 'dangling link') fs.symlinkSync(path.join(f.base, 'absent'), entry.target);
        const result = f.restore(f.index()[0].id);
        expect(result.name).toBe('old (restored).jpg');
        expect(fs.lstatSync(entry.target)[kind === 'file' ? 'isFile' : kind === 'directory' ? 'isDirectory' : 'isSymbolicLink']()).toBe(true);
        expect(fs.readFileSync(path.join(f.directories.backgrounds, result.name))).toEqual(entry.bytes);
    });

    test.each(['background', 'sprites'])('reserves a %s restore name before copying and retries a completed copy without duplicates', type => {
        const f = recoveryFixture(); const entry = type === 'sprites' ? f.sprites('Mittens') : f.add('background', 'old.jpg', 'original');
        f.archive([entry.item.stableName]); const id = f.index()[0].id;
        if (type === 'sprites') fs.mkdirSync(entry.target); else fs.writeFileSync(entry.target, 'personal');
        const fault = indexFault(f, 2);
        expect(() => f.restore(id)).toThrow(); fault.mockRestore();
        const pending = f.index()[0]; expect(pending.status).toBe('restoring'); expect(pending.restoredName).toContain('(restored)');
        const restored = f.restore(id); expect(restored.name).toBe(pending.restoredName);
        expect(fs.readdirSync(path.dirname(entry.target)).filter(name => name.includes('(restored')).length).toBe(1);
    });

    test.each(['before move', 'after move', 'after replacement'])('recovers avatar crash state %s without losing the original', phase => {
        const f = recoveryFixture(); const bundled = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));
        const entry = f.add('avatar', 'user-default.png', 'original', { action: 'replace', replacementHash: digest(bundled) });
        const staged = f.pending(entry, phase !== 'before move');
        if (phase === 'after replacement') fs.writeFileSync(entry.target, bundled);
        const inspected = f.inspect();
        expect(retirement.getRetiredContentHash(staged.payload)).toBe(phase === 'before move' ? null : entry.item.hashes[0]);
        expect(inspected.archived.map(record => record.status)).toEqual(phase === 'before move' ? [] : [phase === 'after replacement' ? 'archived' : 'restored']);
        expect(fs.readFileSync(entry.target)).toEqual(phase === 'after replacement' ? bundled : entry.bytes);
    });

    test.each(['symlink', 'kind mismatch'])('keeps an ambiguous pending %s payload indexed', kind => {
        const f = recoveryFixture(); const entry = f.add('background', 'old.jpg', ''); const staged = f.pending(entry, false);
        if (kind === 'symlink') fs.symlinkSync(entry.target, staged.payload); else fs.mkdirSync(staged.payload);
        const original = fs.readFileSync(f.indexPath);
        expect(f.inspect().archived[0].status).toBe('attention');
        expect(fs.readFileSync(f.indexPath)).toEqual(original);
        expect(fs.readFileSync(entry.target)).toEqual(entry.bytes);
    });

    test('a racing avatar write is never overwritten or removed', () => {
        const f = recoveryFixture(); const bundled = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));
        const entry = f.add('avatar', 'user-default.png', 'original', { action: 'replace', replacementHash: digest(bundled) });
        const link = fs.linkSync;
        jest.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
            if (String(target) === entry.target && !fs.existsSync(target)) fs.writeFileSync(target, 'personal racing avatar', { flag: 'wx' });
            return link(source, target);
        });
        expect(f.archive([entry.item.stableName]).results[0].ok).toBe(false);
        expect(fs.readFileSync(entry.target, 'utf8')).toBe('personal racing avatar');
        const record = f.index()[0]; expect(fs.readFileSync(path.join(path.dirname(f.indexPath), record.payload))).toEqual(entry.bytes);
        expect(f.inspect().archived[0].status).toBe('attention');
    });
});
