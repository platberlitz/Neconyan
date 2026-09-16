/* global globalThis */
import express from 'express';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
    NECONYAN_NATIVE_EXTENSIONS,
    getNativeExtension,
    getNativeExtensionIds,
    getNativeServerExtensions,
} from '../src/neconyan-native-extensions.js';
let createRouter;
let privateData;
beforeAll(async () => {
    privateData = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-native-health-'));
    const previousRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = privateData;
    try {
        ({ createRouter } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/router.js'));
    } finally {
        if (previousRoot === undefined) delete globalThis.DATA_ROOT;
        else globalThis.DATA_ROOT = previousRoot;
    }
});
afterAll(() => fs.rmSync(privateData, { recursive: true, force: true }));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0'));
const runtimeRoot = path.join(repoRoot, 'public', 'scripts', 'extensions', 'third-party');
const expectedDirectories = [
    'Neconyan-Preset-Tools',
    'ChatCompletionTabs',
    'sillytavern-character-colors',
    'Neconyan-Terminal-UI',
    'Neconyan-BotSearcher',
    'Neconyan-PromptTags',
    'Neconyan-Regex-Agent-Themes',
    'MacroEnhanced',
    'Neconyan-WorldInfo-Lab',
    'Neconyan-Prompting-Lab',
    'Neconyan-Debugger',
    'Neconyan-Chats-Archive',
    'Neconyan-Lorebook-Distiller',
    'Neconyan-Time-Machine',
    'Neconyan-Deep-Swipe',
    'Neconyan-Story-Mode',
    'Neconyan-Hopper',
];

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? [file, ...walk(file)] : [file];
    });
}

describe('Neconyan native extension catalog', () => {
    test('contains the pinned 17-entry release catalog and server halves', () => {
        const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/neconyan-native-release.json'), 'utf8'));
        expect(NECONYAN_NATIVE_EXTENSIONS).toHaveLength(17);
        for (const extension of NECONYAN_NATIVE_EXTENSIONS) {
            expect(extension).toMatchObject(release[extension.directory]);
            const directory = extension.runtimeDirectory
                ? path.join(repoRoot, 'public/scripts/extensions', extension.runtimeDirectory)
                : path.join(runtimeRoot, extension.directory);
            const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
            expect(manifest.version).toBe(extension.version);
            expect(manifest.license ?? null).toBe(extension.license);
            expect(manifest.js).toBe(extension.entry);
            expect(manifest.css).toBe(extension.style);
            expect(manifest.author).toEqual(expect.any(String));
            expect(fs.existsSync(path.join(directory, manifest.js))).toBe(true);
            for (const file of walk(directory).filter(file => fs.statSync(file).isFile())) {
                expect(trackedFiles.has(path.relative(repoRoot, file).split(path.sep).join('/'))).toBe(true);
            }
        }
        expect(NECONYAN_NATIVE_EXTENSIONS.map(extension => extension.directory)).toEqual(expectedDirectories);
        expect(getNativeServerExtensions().map(extension => extension.serverId)).toEqual([
            'neconyan-botsearcher',
            'hopper',
        ]);
        expect(getNativeExtensionIds()).toContain('third-party/sillytavern-character-colors');
    });

    test('keeps legacy IDs and native runtime aliases deduplicated', () => {
        expect(getNativeExtension('third-party/Neconyan-Story-Mode')?.version).toBe('0.2.4');
        expect(getNativeExtension('Neconyan-Hopper')?.displayName).toBe('Meower');
        expect(getNativeExtension('SillyBunny-Terminal-UI')?.displayName).toBe('Termeownal UI');
        expect(getNativeExtension('third-party/Neconyan-Debugger')?.runtimeId).toBe('neconyan-debugger');
        expect(getNativeExtension('neconyan-debugger')?.displayName).toBe('Debugger');
        expect(getNativeExtension('SillyTavern-ChatCompletionTabs')?.displayName).toBe('Chat Completion Tabs');
        expect(getNativeExtension('third-party/Neconyan-MacroEnhanced')?.displayName).toBe('Macro Enhanced');
        expect(getNativeExtension('SILLYTAVERN-CHARACTER-COLORS')?.displayName).toBe('Dialogue Colors');
    });

    test('ships runtime manifests without development artifacts or nested repositories', () => {
        const forbidden = /(?:^|\/)(?:\.git|\.opencode|\.cursor-key|node_modules|tests?|test-results|screenshots|docs|scripts)(?:\/|$)|(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock)$/;
        for (const directory of expectedDirectories.filter(name => !['Neconyan-Debugger', 'Neconyan-Chats-Archive'].includes(name))) {
            const root = path.join(runtimeRoot, directory);
            expect(fs.existsSync(path.join(root, 'manifest.json'))).toBe(true);
            for (const licenseFile of (getNativeExtension(directory)?.licenseFiles ?? [])) {
                expect(fs.existsSync(path.join(root, licenseFile))).toBe(true);
            }
            for (const file of walk(root)) {
                expect(path.relative(root, file)).not.toMatch(forbidden);
                expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
            }
        }
    });

    test('reports optional Janny browser capability without remote startup work', async () => {
        const router = express.Router();
        const capability = jest.fn(async () => ({ available: false, reason: 'playwright-missing' }));
        createRouter(router, {
            startedAt: Date.now(),
            accounts: {},
            saucepan: {},
            jannyBrowser: { capability },
        });
        const layer = router.stack.find(entry => entry.route?.path === '/healthz');
        const response = { set: jest.fn(), json: jest.fn() };
        await layer.route.stack[0].handle({ user: { profile: { admin: false } } }, response, jest.fn());

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(capability).toHaveBeenCalledTimes(1);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            capabilities: { jannyBrowser: { available: false, reason: 'playwright-missing' } },
        }));
    });
});


test('automatic Dialogue Colors scans stay quiet while manual scans still report their result', () => {
    const directory = path.join(runtimeRoot, 'sillytavern-character-colors/src');
    const source = fs.readFileSync(path.join(directory, 'color-blocks.js'), 'utf8');
    const code = source.slice(source.indexOf('export function scanAllMessages('), source.indexOf('export function parseColorAssignmentsFromText(')).replace('export function', 'function');
    const info = jest.fn();
    const context = vm.createContext({
        getContext: () => ({ chat: [{ mes: 'A plain message.' }] }),
        isHostSystemOrToolMessage: () => false, processColorBlocksInText() {},
        recountDialogueCountsFromChat() {}, commit() {}, stripColorBlocksFromDisplay() {},
        isDomEngine: () => false, repaintDomAfterCharacterDataChange() {},
        checkColorConflicts: () => [], characterColors: {}, toast: { info },
    });
    vm.runInContext(code, context);
    context.scanAllMessages({ notify: false });
    expect(info).not.toHaveBeenCalled();
    context.scanAllMessages({ type: 'click' });
    expect(info).toHaveBeenCalledWith('Found 0 characters');
    expect(fs.readFileSync(path.join(directory, 'main.js'), 'utf8')).toContain('scanAllMessages({ notify: false })');
});
