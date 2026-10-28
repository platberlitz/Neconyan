/* eslint playwright/expect-expect: off -- Node assertions exercise saved image settings. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { invalidateParsedSettingsFile, readParsedSettingsFile } from '../src/settings-file-cache.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { readQuickImageGenSettings } = await import('../src/generation/quick-image-gen.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-settings-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'settings.json');
    const write = model => fs.writeFileSync(file, JSON.stringify({
        extension_settings: { 'quick-image-gen': { provider: 'openai', nested: { model } }, unrelated: 'large block' },
    }));
    return { root, file, write };
}

test('image settings reuse the file parse but return an independently mutable block', t => {
    const f = fixture(t);
    f.write('one');
    const read = t.mock.method(fs, 'readFileSync');
    const first = readQuickImageGenSettings(f);
    first.nested.model = 'mutated';
    first.__prepared = true;
    assert.deepEqual(readQuickImageGenSettings(f), { provider: 'openai', nested: { model: 'one' } });
    assert.equal(read.mock.calls.filter(call => call.arguments[0] === f.file).length, 1);
});

test('image settings detect same-size edits, replacement, missing files and corruption', t => {
    const f = fixture(t);
    f.write('one');
    const before = fs.statSync(f.file);
    assert.equal(readQuickImageGenSettings(f).nested.model, 'one');
    f.write('two');
    fs.utimesSync(f.file, before.atime, before.mtime);
    assert.equal(readQuickImageGenSettings(f).nested.model, 'two');
    const replacement = path.join(f.root, 'replacement.json');
    fs.writeFileSync(replacement, fs.readFileSync(f.file, 'utf8').replace('two', 'new'));
    fs.renameSync(replacement, f.file);
    assert.equal(readQuickImageGenSettings(f).nested.model, 'new');
    fs.writeFileSync(f.file, '{broken');
    assert.deepEqual(readQuickImageGenSettings(f), {});
    fs.unlinkSync(f.file);
    assert.deepEqual(readQuickImageGenSettings(f), {});
    f.write('restored');
    assert.equal(readQuickImageGenSettings(f).nested.model, 'restored');
});

test('accounts with the same settings filename remain isolated', t => {
    const first = fixture(t);
    const second = fixture(t);
    first.write('one');
    second.write('two');
    assert.equal(readQuickImageGenSettings(first).nested.model, 'one');
    assert.equal(readQuickImageGenSettings(second).nested.model, 'two');
    assert.equal(readQuickImageGenSettings(first).nested.model, 'one');
});

test('a named account write invalidates both request and background settings snapshots', t => {
    const f = fixture(t);
    f.write('one');
    const named = readParsedSettingsFile(f.file, 'owner');
    const background = readParsedSettingsFile(f.file);
    invalidateParsedSettingsFile(f.file, 'owner');
    assert.notStrictEqual(readParsedSettingsFile(f.file, 'owner'), named);
    assert.notStrictEqual(readParsedSettingsFile(f.file), background);
});
