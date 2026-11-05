/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const { checkForNewContent, getDefaultPresets, recordDefaultPresetDeletion } = await import('../src/endpoints/content-manager.js');
let root;
let directories;
let originalDataRoot;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-startup-content-'));
    originalDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = root;
    const userRoot = path.join(root, 'default-user');
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(userRoot, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    globalThis.DATA_ROOT = originalDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
});

test('unchanged startup reads each content log once and preserves both files', async () => {
    await checkForNewContent([directories]);
    const logs = [path.join(root, 'content.log'), path.join(directories.root, 'content.log')];
    const before = logs.map(file => fs.statSync(file, { bigint: true }));
    const read = jest.spyOn(fs, 'readFileSync');
    await checkForNewContent([directories]);
    for (const [index, file] of logs.entries()) {
        expect(read.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
        expect(fs.statSync(file, { bigint: true }).ctimeNs).toBe(before[index].ctimeNs);
    }
});

test('new log entries are saved even when the target exists, and forced categories restore missing files', async () => {
    await checkForNewContent([directories]);
    const preset = getDefaultPresets(directories)[0];
    expect(preset).toBeDefined();
    const log = path.join(directories.root, 'content.log');
    const target = path.join(preset.folder, path.basename(preset.filename));
    fs.writeFileSync(target, 'user edited preset');
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').split('\n').filter(name => name !== preset.filename).join('\n'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await checkForNewContent([directories]);
    expect(fs.readFileSync(log, 'utf8').split('\n')).toContain(preset.filename);
    expect(fs.readFileSync(target, 'utf8')).toBe('user edited preset');
    fs.unlinkSync(target);
    await checkForNewContent([directories], [preset.type]);
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(path.join(preset.sourceFolder, preset.filename)));
});

test('preset deletions are read once per operation and later changes remain visible', async () => {
    const presets = getDefaultPresets(directories);
    expect(presets.length).toBeGreaterThan(2);
    recordDefaultPresetDeletion(directories, presets[0]);
    const deletionPath = path.join(directories.root, 'default-preset-deletions.json');
    const read = jest.spyOn(fs, 'readFileSync');
    expect(getDefaultPresets(directories, { includeDeleted: false })).toHaveLength(presets.length - 1);
    expect(read.mock.calls.filter(([name]) => name === deletionPath)).toHaveLength(1);
    recordDefaultPresetDeletion(directories, presets[1]);
    read.mockClear();
    await checkForNewContent([directories]);
    expect(read.mock.calls.filter(([name]) => name === deletionPath)).toHaveLength(1);
    expect(getDefaultPresets(directories, { includeDeleted: false })).toHaveLength(presets.length - 2);
    for (const preset of presets.slice(0, 2)) {
        expect(fs.existsSync(path.join(preset.folder, path.basename(preset.filename)))).toBe(false);
    }
});
