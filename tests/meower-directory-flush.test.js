/* eslint-disable jest/no-standalone-expect -- Shared helpers assert filesystem invariants within each test. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { initialiseRoleplayAccount } from '../src/roleplay-store.js';
import { init as initHopper, mutateMeowerStore, readMeowerStore } from '../public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const temporaryDirectories = [];
const owner = 'native-test';
const receiptKey = 'a'.repeat(64);
const receipt = { version: 1, jobId: 'permanent', units: { applied: { posts: ['deleted-post'] } }, closed: true };

function privateDirectory() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'meower-directory-flush-'));
    temporaryDirectories.push(parent);
    const root = path.join(parent, owner);
    const files = path.join(root, 'files');
    fs.mkdirSync(files, { recursive: true });
    const directories = { root, files };
    initialiseRoleplayAccount({ owner, directories });
    return directories;
}

async function seedPrivateStore(directories) {
    const { store } = await readMeowerStore(directories, owner);
    const directory = path.join(directories.root, 'hopper');
    fs.mkdirSync(directory);
    // Backup and rollback must preserve bytes, including non-canonical whitespace.
    const bytes = Buffer.from(` \r\n${JSON.stringify({ ...store, revision: 7, account: owner, jobReceipts: { [receiptKey]: receipt } }, null, 2)}\t\r\n`);
    fs.writeFileSync(path.join(directory, 'store.json'), bytes);
    return bytes;
}

async function requestStore(directories) {
    const router = express.Router();
    await initHopper(router);
    return async (method, body) => {
        const route = router.stack.find(layer => layer.route?.methods[method]).route.stack[0].handle;
        const result = { status: 200, body: undefined };
        const response = {
            set() {},
            status(value) { result.status = value; return this; },
            json(value) { result.body = value; return this; },
        };
        await route({ user: { profile: { handle: owner }, directories }, headers: {}, query: {}, body }, response);
        return result;
    };
}

function expectClean(directories) {
    const directory = path.join(directories.root, 'hopper');
    expect(fs.existsSync(path.join(directory, 'store.lock'))).toBe(false);
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
}

function ioError() {
    return Object.assign(new Error('Injected Meower flush failure'), { code: 'EIO' });
}

function flushProbe(directories, { simulateSupported = false, onDirectory, onFile } = {}) {
    const descriptors = new Map();
    const events = [];
    const open = fs.openSync.bind(fs);
    const close = fs.closeSync.bind(fs);
    const flush = fs.fsyncSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    const storePath = path.join(directories.root, 'hopper', 'store.json');
    if (simulateSupported) Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    jest.spyOn(fs, 'openSync').mockImplementation((filename, ...args) => {
        const descriptor = open(filename, ...args);
        descriptors.set(descriptor, typeof filename === 'string' ? path.resolve(filename) : undefined);
        return descriptor;
    });
    jest.spyOn(fs, 'closeSync').mockImplementation(descriptor => {
        try { return close(descriptor); } finally { descriptors.delete(descriptor); }
    });
    jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        const result = rename(source, destination);
        if (destination === storePath) events.push({ kind: 'publication', bytes: fs.readFileSync(storePath) });
        return result;
    });
    jest.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
        const filename = descriptors.get(descriptor);
        if (fs.fstatSync(descriptor).isDirectory()) {
            events.push({ kind: 'directory', filename });
            onDirectory?.(filename, events);
            // Windows cannot perform this operation; only directory flushing is simulated.
            if (simulateSupported && platform.value === 'win32') return;
        } else {
            events.push({ kind: 'file', filename });
            onFile?.(filename);
        }
        return flush(descriptor);
    });
    return events;
}

afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platform);
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Meower directory flushing', () => {
    test.each([false, true])('saves existing private bytes and receipts with relative paths: %s', async relative => {
        const absoluteDirectories = privateDirectory();
        const oldBytes = await seedPrivateStore(absoluteDirectories);
        const directories = relative ? Object.fromEntries(Object.entries(absoluteDirectories).map(([key, value]) => [key, path.relative(process.cwd(), value)])) : absoluteDirectories;
        const request = await requestStore(directories);
        const initial = await request('get');
        expect(initial.status).toBe(200);
        expect(initial.body.revision).toBe(7);
        const savedPath = path.join(absoluteDirectories.root, 'hopper', 'store.json');
        const backupPath = path.join(absoluteDirectories.root, 'hopper', 'store.previous.json');
        const first = await request('post', initial.body);
        expect(first.status).toBe(200);
        expect(first.body.revision).toBe(8);
        expect(fs.readFileSync(backupPath)).toEqual(oldBytes);
        const firstBytes = fs.readFileSync(savedPath);
        const second = await request('post', first.body);
        expect(second.status).toBe(200);
        expect(second.body.revision).toBe(9);
        expect(fs.readFileSync(backupPath)).toEqual(firstBytes);
        expect((await request('post', first.body)).status).toBe(409);
        expect((await readMeowerStore(directories, owner)).receipts[receiptKey]).toEqual(receipt);
        expectClean(absoluteDirectories);
    });

    (platform.value === 'win32' ? test : test.skip)('on real Windows avoids directory fsync while retaining real-file flushing', async () => {
        const directories = privateDirectory();
        const events = flushProbe(directories);
        const result = await mutateMeowerStore(directories, owner, () => {});
        expect(result.store.revision).toBe(1);
        expect(events.filter(event => event.kind === 'directory')).toEqual([]);
        expect(events.filter(event => event.kind === 'file' && path.dirname(event.filename) === directories.files)).toHaveLength(1);
        expect(events.filter(event => event.kind === 'file' && path.dirname(event.filename) === path.join(directories.root, 'hopper'))).toHaveLength(3);
        expect((await readMeowerStore(directories, owner)).store.revision).toBe(1);
        expectClean(directories);
    });

    test('rejects a private temporary-file flush failure, preserves exact bytes and permits retry', async () => {
        const directories = privateDirectory();
        const oldBytes = await seedPrivateStore(directories);
        const privateFolder = path.join(directories.root, 'hopper');
        let injected = false;
        flushProbe(directories, { onFile: filename => {
            if (!injected && path.dirname(filename) === privateFolder && /^store-.*\.tmp$/.test(path.basename(filename))) {
                injected = true;
                throw ioError();
            }
        } });
        await expect(mutateMeowerStore(directories, owner, () => {})).rejects.toMatchObject({ code: 'EIO' });
        expect(injected).toBe(true);
        expect(fs.readFileSync(path.join(privateFolder, 'store.json'))).toEqual(oldBytes);
        expect((await readMeowerStore(directories, owner)).store.revision).toBe(7);
        expectClean(directories);
        expect((await mutateMeowerStore(directories, owner, () => {})).store.revision).toBe(8);
        expect(fs.readFileSync(path.join(privateFolder, 'store.previous.json'))).toEqual(oldBytes);
        expectClean(directories);
    });

    test('supported-platform simulation keeps flush order and tolerates only an unsupported directory operation', async () => {
        const directories = privateDirectory();
        await seedPrivateStore(directories);
        let injected = false;
        const events = flushProbe(directories, { simulateSupported: true, onDirectory: filename => {
            if (!injected && filename === directories.files) {
                injected = true;
                throw Object.assign(new Error('Directory flush unsupported'), { code: 'EINVAL' });
            }
        } });
        expect((await mutateMeowerStore(directories, owner, () => {})).store.revision).toBe(8);
        expect(injected).toBe(true);
        expect(events.filter(event => event.kind !== 'file').map(event => event.kind === 'publication' ? 'publish' : path.relative(directories.root, event.filename))).toEqual([
            '', 'files', 'hopper', 'publish', 'hopper',
        ]);
        expectClean(directories);
    });

    test('supported-platform simulation rolls back a post-publication failure to exact existing bytes', async () => {
        const directories = privateDirectory();
        const oldBytes = await seedPrivateStore(directories);
        const privateFolder = path.join(directories.root, 'hopper');
        const savedPath = path.join(privateFolder, 'store.json');
        let injected = false;
        let visibleBytes;
        const events = flushProbe(directories, { simulateSupported: true, onDirectory: (filename, observed) => {
            if (!injected && filename === privateFolder && observed.some(event => event.kind === 'publication')) {
                visibleBytes = fs.readFileSync(savedPath);
                injected = true;
                throw ioError();
            }
        } });
        await expect(mutateMeowerStore(directories, owner, () => {})).rejects.toMatchObject({ code: 'EIO' });
        expect(injected).toBe(true);
        expect(JSON.parse(visibleBytes).revision).toBe(8);
        expect(fs.readFileSync(savedPath)).toEqual(oldBytes);
        expect(fs.readFileSync(path.join(privateFolder, 'store.previous.json'))).toEqual(oldBytes);
        expect((await readMeowerStore(directories, owner)).store.revision).toBe(7);
        expect(events.filter(event => event.kind !== 'file').map(event => event.kind === 'publication' ? 'publish' : path.relative(directories.root, event.filename))).toEqual([
            '', 'files', 'hopper', 'publish', 'hopper', 'publish', 'hopper',
        ]);
        expectClean(directories);
        expect((await mutateMeowerStore(directories, owner, () => {})).store.revision).toBe(8);
        expectClean(directories);
    });

    test.each([1, 2])('supported-platform simulation restores the correct first-save state after publication %s fails', async publication => {
        const directories = privateDirectory();
        const privateFolder = path.join(directories.root, 'hopper');
        const savedPath = path.join(privateFolder, 'store.json');
        let injected = false;
        let visibleBytes;
        const events = flushProbe(directories, { simulateSupported: true, onDirectory: (filename, observed) => {
            if (!injected && filename === privateFolder && observed.filter(event => event.kind === 'publication').length === publication) {
                visibleBytes = fs.readFileSync(savedPath);
                injected = true;
                throw ioError();
            }
        } });
        await expect(mutateMeowerStore(directories, owner, () => {})).rejects.toMatchObject({ code: 'EIO' });
        expect(injected).toBe(true);
        expect(JSON.parse(visibleBytes).revision).toBe(publication - 1);
        const baseline = events.find(event => event.kind === 'publication').bytes;
        const backupPath = path.join(privateFolder, 'store.previous.json');
        const retained = filename => fs.existsSync(filename) ? fs.readFileSync(filename) : null;
        expect(retained(savedPath)).toEqual(publication === 1 ? null : baseline);
        expect(retained(backupPath)).toEqual(publication === 1 ? null : baseline);
        expect(events.at(-1)).toEqual({ kind: 'directory', filename: privateFolder });
        expect((await readMeowerStore(directories, owner)).store.revision).toBe(0);
        expectClean(directories);
        expect((await mutateMeowerStore(directories, owner, () => {})).store.revision).toBe(1);
        expect(fs.readFileSync(path.join(privateFolder, 'store.previous.json'))).toEqual(baseline);
        expectClean(directories);
    });
});
