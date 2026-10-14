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
    'SillyTavern-CssSnippets',
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
    test('contains the pinned 18-entry release catalog and server halves', () => {
        const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/neconyan-native-release.json'), 'utf8'));
        expect(NECONYAN_NATIVE_EXTENSIONS).toHaveLength(18);
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
        expect(getNativeExtension('Neconyan-Terminal-UI')?.displayName).toBe('Termeownal UI');
        expect(getNativeExtension('third-party/Neconyan-Debugger')?.runtimeId).toBe('neconyan-debugger');
        expect(getNativeExtension('neconyan-debugger')?.displayName).toBe('Debugger');
        expect(getNativeExtension('third-party/SillyTavern-CssSnippets')?.runtimeId).toBe('css-snippets');
        expect(getNativeExtension('css-snippets')?.displayName).toBe('CSS Snippets');
        expect(getNativeExtension('SillyTavern-ChatCompletionTabs')?.displayName).toBe('Chat Completion Tabs');
        expect(getNativeExtension('third-party/Neconyan-MacroEnhanced')?.displayName).toBe('Macro Enhanced');
        expect(getNativeExtension('SILLYTAVERN-CHARACTER-COLORS')?.displayName).toBe('Dialogue Colors');
    });

    test('ships runtime manifests without development artifacts or nested repositories', () => {
        const forbidden = /(?:^|\/)(?:\.git|\.opencode|\.cursor-key|node_modules|tests?|test-results|screenshots|docs|scripts)(?:\/|$)|(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock)$/;
        for (const directory of expectedDirectories.filter(name => !['Neconyan-Debugger', 'Neconyan-Chats-Archive', 'SillyTavern-CssSnippets'].includes(name))) {
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

test('World Info Lab aligns Health panel padding and Scan surface tokens with the Neconyan shell', () => {
    const css = fs.readFileSync(path.join(runtimeRoot, 'Neconyan-WorldInfo-Lab/style.css'), 'utf8');

    expect(css).toMatch(/\.sbwil-panel-trace,\s*\.sbwil-panel-tests,\s*\.sbwil-panel-batch,\s*\.sbwil-panel-health\s*\{\s*padding:\s*20px;/);
    expect(css).toMatch(/\.sbwil-scan-output,\s*\.sbwil-panel-trace,\s*\.sbwil-panel-tests,\s*\.sbwil-panel-batch,\s*\.sbwil-panel-health\s*\{\s*padding:\s*24px 28px 32px;/);
    expect(css).toMatch(/\.sbwil-scan-controls,\s*\.sbwil-scan-output,\s*\.sbwil-panel-trace,\s*\.sbwil-panel-tests,\s*\.sbwil-panel-batch,\s*\.sbwil-panel-health\s*\{\s*padding:\s*16px 14px 22px;/);
    expect(css).toMatch(/\.sbwil-scan-form,\s*\.sbwil-batch-form,\s*\.sbwil-health-form\s*\{\s*display:\s*grid;\s*gap:\s*17px;/);

    expect(css).toContain('--sbwil-bg: var(--neco-surface,');
    expect(css).toContain('--sbwil-input-bg: var(--sb-input-bg, var(--neco-canvas, var(--sbwil-bg-alt)));');
    expect(css).toMatch(/\.sbwil-scan-controls\s*\{[^}]*background:\s*var\(--sbwil-bg\);/);
    expect(css).toMatch(/\.sbwil-scan-output\s*\{[^}]*background:\s*var\(--sbwil-bg\);/);
    expect(css).toMatch(/#sbwil-workbench\.sbwil-workbench h3:not\(#chat h3\)\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*none;/);
});

test('styles BotSearcher with Neconyan tokens, circular controls, and safe client rendering', () => {
    const botSearcherRoot = path.join(runtimeRoot, 'Neconyan-BotSearcher');
    const browserHtml = fs.readFileSync(path.join(botSearcherRoot, 'templates/browser.html'), 'utf8');
    const styleCss = fs.readFileSync(path.join(botSearcherRoot, 'style.css'), 'utf8');
    const detailJs = fs.readFileSync(path.join(botSearcherRoot, 'client/detail.js'), 'utf8');
    const intakeJs = fs.readFileSync(path.join(botSearcherRoot, 'client/intake.js'), 'utf8');

    expect(browserHtml).toContain('class="sbbs-masthead"');
    expect(browserHtml).toContain('class="sbbs-utility-row"');
    expect(browserHtml).toContain('id="sbbs_go" class="menu_button menu_button_primary sbbs-go"');
    expect(browserHtml).toContain('id="sbbs_import_selected" class="menu_button menu_button_primary sbbs-selection-action sbbs-import"');
    expect(browserHtml).not.toMatch(/id="sbbs_file_actions"[^>]*\bopen\b/);

    expect(detailJs).toContain('menu_button menu_button_primary sbbs-import');
    expect(intakeJs).toContain('menu_button menu_button_primary sbbs-import');
    expect(intakeJs).toContain('menu_button menu_button_primary sbbs-open-character');
    expect(intakeJs).toContain('menu_button menu_button_primary sbbs-bulk-start');

    for (const token of [
        '--neco-canvas',
        '--neco-surface',
        '--neco-raised',
        '--neco-rail',
        '--neco-ink',
        '--neco-muted',
        '--neco-ginger',
        '--neco-ginger-hover',
        '--neco-on-accent',
        '--neco-border',
        '--neco-user',
    ]) {
        expect(styleCss).toContain(token);
    }
    expect(styleCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(styleCss).toContain('input:is([type="checkbox"], [type="radio"])');
    expect(styleCss).toContain('--neconyan-control-radius: 999px;');
    expect(styleCss).toContain('#sbbs_search_form #sbbs_go.sbbs-go.menu_button');
    expect(styleCss).toContain('.sbbs-card-img:has(img) .sbbs-card-initial');
    expect(styleCss).toContain('.neconyan-included-tool-page #sbbs_settings > .inline-drawer > .sbbs-settings-toggle');
    expect(styleCss).toContain('@media (prefers-reduced-motion: reduce)');

    const clientFiles = walk(path.join(botSearcherRoot, 'client')).filter(file => file.endsWith('.js'));
    for (const file of clientFiles) {
        const content = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
        expect(content).not.toMatch(/https?:\/\//i);
        expect(content).not.toMatch(/\binnerHTML\b|\binsertAdjacentHTML\b|\.html\s*\(/);
    }
});
