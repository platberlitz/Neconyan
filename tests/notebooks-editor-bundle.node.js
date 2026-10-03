import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import webpack from 'webpack';
import getPublicLibConfig, { getPublicLibCacheInfo, prunePublicLibCache } from '../webpack.config.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function isolatedRoot(t) {
    const parent = path.join(os.tmpdir(), 'opencode');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'notes-editor-bundle-'));
    const cwd = process.cwd();
    process.chdir(root);
    t.after(() => {
        process.chdir(cwd);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('the Notes editor has its own lazy bundle and cache signature', t => {
    isolatedRoot(t);
    const main = getPublicLibCacheInfo({ forceDist: true });
    const editor = getPublicLibCacheInfo({ forceDist: true, bundle: 'notes-editor' });
    assert.equal(main.outputFile, 'lib.js');
    assert.equal(editor.outputFile, 'notes-editor.js');
    assert.equal(editor.webpackRoot, path.join(main.webpackRoot, 'notes-editor'));
    assert.notEqual(editor.cacheVersion, main.cacheVersion);
    assert.ok(getPublicLibConfig({ forceDist: true }).entry.endsWith('/public/lib.js'));
    assert.ok(getPublicLibConfig({ forceDist: true, bundle: 'notes-editor' }).entry.endsWith('/public/notes-editor.js'));
    assert.throws(() => getPublicLibCacheInfo({ forceDist: true, bundle: '../other' }), /Unknown frontend bundle/);
    const read = fs.readFileSync.bind(fs);
    t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        const value = read(filename, ...args);
        return String(filename).endsWith('/scripts/notebooks/folding.js') ? Buffer.concat([value, Buffer.from('\n/* new folding code */')]) : value;
    });
    assert.equal(getPublicLibCacheInfo({ forceDist: true }).cacheVersion, main.cacheVersion);
    assert.notEqual(getPublicLibCacheInfo({ forceDist: true, bundle: 'notes-editor' }).cacheVersion, editor.cacheVersion);
});

test('pruning startup caches preserves the editor cache and unfamiliar directories', t => {
    isolatedRoot(t);
    const main = getPublicLibCacheInfo({ forceDist: true });
    const editor = getPublicLibCacheInfo({ forceDist: true, bundle: 'notes-editor' });
    const retained = path.join(main.webpackRoot, 'personal-files');
    for (const directory of [retained, editor.outputDirectory, path.join(main.webpackRoot, main.cacheVersion),
        ...['1', '2', '3'].map(value => path.join(main.webpackRoot, value.padStart(16, '0')))]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(editor.outputDirectory, 'notes-editor.js'), 'editor fixture');
    prunePublicLibCache({ forceDist: true, keepCount: 1 });
    assert.equal(fs.existsSync(retained), true);
    assert.equal(fs.readFileSync(path.join(editor.outputDirectory, 'notes-editor.js'), 'utf8'), 'editor fixture');
    assert.equal(fs.existsSync(path.join(main.webpackRoot, main.cacheVersion)), true);
    assert.equal(fs.existsSync(path.join(main.webpackRoot, '1'.padStart(16, '0'))), false);
});

test('the production editor bundle is self-contained and stays below its lazy byte cap', async t => {
    const root = isolatedRoot(t);
    const config = getPublicLibConfig({ forceDist: true, bundle: 'notes-editor', outputPath: path.join(root, 'output') });
    config.cache = false;
    const compiler = webpack(config);
    let stats;
    try {
        stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
    } finally {
        await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    }
    assert.equal(stats.hasErrors(), false, stats.toString());
    const bytes = fs.readFileSync(path.join(root, 'output', 'notes-editor.js'));
    assert.ok(bytes.length < 512 * 1024, `Editor bundle: ${bytes.length} bytes`);
    assert.doesNotMatch(bytes.toString(), /from\s*['"]@codemirror\//);
    const module = await import(`data:text/javascript;base64,${bytes.toString('base64')}`);
    assert.equal(typeof module.createNotesEditor, 'function');
    assert.equal(typeof module.headingFoldTransaction, 'function');
    console.log(JSON.stringify({ notesEditorBytes: bytes.length, gzipBytes: gzipSync(bytes).length }));
});

test('the real frontend build ships compiled editor aliases, hashed assets and licences without touching the worktree build', async t => {
    const root = isolatedRoot(t);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'tmp'));
    for (const filename of ['webpack.config.js', 'package.json', 'package-lock.json', 'bun.lock', 'scripts/build-frontend-assets.js']) {
        fs.copyFileSync(path.join(repoRoot, filename), path.join(root, filename));
    }
    for (const directory of ['public', 'src', 'node_modules']) fs.symlinkSync(path.join(repoRoot, directory), path.join(root, directory), 'dir');
    await promisify(execFile)(process.execPath, [path.join(root, 'scripts/build-frontend-assets.js')], {
        cwd: root, env: { ...process.env, TMPDIR: path.join(root, 'tmp') }, timeout: 300000, maxBuffer: 32 * 1024 * 1024,
    });
    const output = path.join(root, 'dist', 'frontend');
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'asset-manifest.json'), 'utf8'));
    const alias = fs.readFileSync(path.join(output, 'notes-editor.js'));
    const hashed = fs.readFileSync(path.join(output, manifest.assets['notes-editor.js'].output));
    assert.deepEqual(alias, hashed);
    assert.doesNotMatch(alias.toString(), /from\s*['"]@codemirror\//);
    const module = await import(`data:text/javascript;base64,${alias.toString('base64')}`);
    assert.equal(typeof module.createNotesEditor, 'function');
    assert.equal(typeof module.revealFoldedSelectionTransaction, 'function');
    assert.ok(alias.length < 512 * 1024);
    assert.doesNotMatch(fs.readFileSync(path.join(output, 'lib.js'), 'utf8'), /createNotesEditor|revealFoldedSelectionTransaction/);
    assert.match(fs.readFileSync(path.join(output, 'notes-editor.LICENSE.txt'), 'utf8'), /Permission is hereby granted/);
});
