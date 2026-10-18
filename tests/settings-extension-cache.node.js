/* eslint playwright/expect-expect: off -- Node assertions exercise the settings route. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/settings.js');
const get = router.stack.find(layer => layer.route?.path === '/get').route.stack[0].handle;

const CACHE_MARKER = 'settings-extension-cache-probe';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-extension-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, file: path.join(root, 'settings.json') };
}

function request(root, handle = 'fixture') {
    return {
        body: { extensionSettings: ['dialogue-colors', 'other'] },
        user: { directories: { root }, profile: { handle } },
    };
}

function call(settingsRequest) {
    let result;
    let status = 200;
    get(settingsRequest, {
        send: body => { result = body; },
        status: code => { status = code; return { send: body => { result = body; } }; },
        sendStatus: code => { status = code; },
    });
    return { result, status };
}

function writeSettings(file, value, variant = 0) {
    const text = JSON.stringify({
        cacheProbe: CACHE_MARKER,
        extension_settings: {
            'dialogue-colors': { value, variant },
            other: { untouched: true },
        },
    });
    fs.writeFileSync(file, text);
    return text;
}

function instrument(t, settingsFile) {
    const originalRead = fs.readFileSync;
    const originalParse = JSON.parse;
    let reads = 0;
    let parses = 0;
    fs.readFileSync = function (file, ...args) {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(settingsFile)) reads++;
        return originalRead.call(this, file, ...args);
    };
    JSON.parse = function (text, reviver) {
        if (typeof text === 'string' && text.includes(CACHE_MARKER)) parses++;
        return originalParse.call(this, text, reviver);
    };
    t.after(() => {
        fs.readFileSync = originalRead;
        JSON.parse = originalParse;
    });
    return { counts: () => ({ reads, parses }) };
}

test('unchanged extension requests reuse one parse and return independent copies', t => {
    const { root, file } = fixture(t);
    writeSettings(file, 'first');
    const probe = instrument(t, file);

    const first = call(request(root));
    const second = call(request(root));

    assert.equal(first.status, 200);
    assert.deepEqual(first.result, {
        extension_settings: {
            'dialogue-colors': { value: 'first', variant: 0 },
            other: { untouched: true },
        },
    });
    assert.deepEqual(second.result, first.result);
    assert.notStrictEqual(second.result.extension_settings['dialogue-colors'], first.result.extension_settings['dialogue-colors']);
    assert.deepEqual(probe.counts(), { reads: 1, parses: 1 });

    first.result.extension_settings['dialogue-colors'].value = 'mutated by caller';
    first.result.extension_settings.other.untouched = false;
    const third = call(request(root));
    assert.deepEqual(third.result, second.result);
    assert.deepEqual(probe.counts(), { reads: 1, parses: 1 });
});

test('a same-size rewrite with the old mtime restored is read again', t => {
    const { root, file } = fixture(t);
    const before = writeSettings(file, 'AA');
    const beforeStat = fs.statSync(file);
    const probe = instrument(t, file);
    assert.equal(call(request(root)).result.extension_settings['dialogue-colors'].value, 'AA');

    const after = before.replace('"value":"AA"', '"value":"BB"');
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    fs.writeFileSync(file, after);
    fs.utimesSync(file, beforeStat.atime, beforeStat.mtime);

    const updated = call(request(root));
    assert.equal(updated.result.extension_settings['dialogue-colors'].value, 'BB');
    assert.equal(fs.statSync(file).size, beforeStat.size);
    assert.deepEqual(probe.counts(), { reads: 2, parses: 2 });
});

test('a renamed replacement is read again even when its size matches', t => {
    const { root, file } = fixture(t);
    const before = writeSettings(file, 'AA');
    const probe = instrument(t, file);
    assert.equal(call(request(root)).result.extension_settings['dialogue-colors'].value, 'AA');

    const replacement = path.join(path.dirname(file), 'settings.next.json');
    const after = before.replace('"value":"AA"', '"value":"CC"');
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    fs.writeFileSync(replacement, after);
    fs.renameSync(replacement, file);

    const updated = call(request(root));
    assert.equal(updated.result.extension_settings['dialogue-colors'].value, 'CC');
    assert.deepEqual(probe.counts(), { reads: 2, parses: 2 });
});

test('different accounts do not share a cached parse', t => {
    const { root, file } = fixture(t);
    writeSettings(file, 'shared-file');
    const probe = instrument(t, file);

    assert.equal(call(request(root, 'first-user')).status, 200);
    assert.equal(call(request(root, 'second-user')).status, 200);
    assert.equal(call(request(root, 'first-user')).status, 200);
    assert.deepEqual(probe.counts(), { reads: 2, parses: 2 });
});

test('missing and corrupt files keep their error and recover after a valid write', t => {
    const { root, file } = fixture(t);
    const probe = instrument(t, file);

    assert.equal(call(request(root)).status, 500);
    writeSettings(file, 'recovered');
    const recovered = call(request(root));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.result.extension_settings['dialogue-colors'].value, 'recovered');

    fs.writeFileSync(file, '{broken');
    assert.equal(call(request(root)).status, 500);
    writeSettings(file, 'fixed');
    assert.equal(call(request(root)).result.extension_settings['dialogue-colors'].value, 'fixed');
    assert.deepEqual(probe.counts(), { reads: 3, parses: 2 });
});
