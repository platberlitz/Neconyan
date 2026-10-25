/* eslint playwright/expect-expect: off -- Node assertions exercise the settings route. */
/* global globalThis */
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

function tokenRequest(root, token, handle = 'fixture', names = ['dialogue-colors', 'other']) {
    const body = { extensionSettings: names };
    if (token !== undefined) body.extensionSettingsToken = token;
    return { body, user: { directories: { root }, profile: { handle } } };
}

function writeTokenSettings(file, value, { revision = 1, extra = {} } = {}) {
    const text = JSON.stringify({
        _settingsRevision: revision,
        cacheProbe: `${CACHE_MARKER}-${value}`,
        extension_settings: {
            'dialogue-colors': { value, marker: `block-${value}` },
            other: { untouched: true },
            regex: [{ id: `${CACHE_MARKER}-${value}` }],
        },
        ...extra,
    });
    fs.writeFileSync(file, text);
    return text;
}

function instrumentClone(t) {
    const original = globalThis.structuredClone;
    let count = 0;
    globalThis.structuredClone = value => {
        count++;
        return original(value);
    };
    t.after(() => { globalThis.structuredClone = original; });
    return () => count;
}

function instrumentBlockStringify(t, marker) {
    const original = JSON.stringify;
    let count = 0;
    JSON.stringify = function (value, ...args) {
        const text = original.call(this, value, ...args);
        if (typeof text === 'string' && text.includes(marker)) count++;
        return text;
    };
    t.after(() => { JSON.stringify = original; });
    return () => count;
}

test('a matching token returns unchanged without copying or serialising the block', t => {
    const { root, file } = fixture(t);
    writeTokenSettings(file, 'first');
    const full = call(tokenRequest(root, ''));
    assert.equal(full.status, 200);
    const token = full.result.extensionSettingsToken;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.deepEqual(full.result.extension_settings['dialogue-colors'], { value: 'first', marker: 'block-first' });

    const clones = instrumentClone(t);
    const blockStringifies = instrumentBlockStringify(t, 'block-first');
    const unchanged = call(tokenRequest(root, token));

    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.result.unchanged, true);
    assert.equal(unchanged.result.extensionSettingsToken, token);
    assert.equal(unchanged.result.extension_settings, undefined);
    assert.equal(clones(), 0);
    assert.equal(blockStringifies(), 0);
});

test('an external edit that keeps settingsRevision changes the token and returns the new block', t => {
    const { root, file } = fixture(t);
    writeTokenSettings(file, 'first', { revision: 7 });
    const oldToken = call(tokenRequest(root, '')).result.extensionSettingsToken;

    writeTokenSettings(file, 'second', { revision: 7 });
    const updated = call(tokenRequest(root, oldToken));

    assert.equal(updated.status, 200);
    assert.equal(updated.result.unchanged, undefined);
    assert.deepEqual(updated.result.extension_settings['dialogue-colors'], { value: 'second', marker: 'block-second' });
    assert.notEqual(updated.result.extensionSettingsToken, oldToken);
});

test('a change outside the requested blocks keeps the token and returns unchanged', t => {
    const { root, file } = fixture(t);
    const source = writeTokenSettings(file, 'first', { revision: 7 });
    const token = call(tokenRequest(root, '')).result.extensionSettingsToken;

    fs.writeFileSync(file, JSON.stringify({
        ...JSON.parse(source),
        _settingsRevision: 8,
        unrelated: { changed: true },
    }));
    const unchanged = call(tokenRequest(root, token));

    assert.equal(unchanged.result.unchanged, true);
    assert.equal(unchanged.result.extensionSettingsToken, token);
});

test('the save-check block map yields the token a single-block poll accepts', t => {
    const { root, file } = fixture(t);
    writeTokenSettings(file, 'first');
    const full = call(tokenRequest(root, '', 'fixture', ['dialogue-colors', 'regex']));
    const moduleToken = full.result.extensionSettingsTokens['dialogue-colors'];
    assert.match(moduleToken, /^[a-f0-9]{64}$/);
    assert.notEqual(full.result.extensionSettingsToken, moduleToken);

    const poll = call(tokenRequest(root, moduleToken, 'fixture', ['dialogue-colors']));
    assert.equal(poll.result.unchanged, true);
    assert.equal(poll.result.extensionSettingsToken, moduleToken);
});

test('an empty known token always asks for full data', t => {
    const { root, file } = fixture(t);
    writeTokenSettings(file, 'first');
    const full = call(tokenRequest(root, ''));
    assert.equal(full.result.unchanged, undefined);
    assert.deepEqual(full.result.extension_settings['dialogue-colors'], { value: 'first', marker: 'block-first' });
    assert.match(full.result.extensionSettingsToken, /^[a-f0-9]{64}$/);
});

test('the token is opaque, path-independent and scoped to the account', t => {
    const first = fixture(t);
    const second = fixture(t);
    writeTokenSettings(first.file, 'shared');
    writeTokenSettings(second.file, 'shared');

    const firstToken = call(tokenRequest(first.root, '', 'shared-account')).result.extensionSettingsToken;
    const secondToken = call(tokenRequest(second.root, '', 'shared-account')).result.extensionSettingsToken;
    const otherAccountToken = call(tokenRequest(second.root, '', 'other-account')).result.extensionSettingsToken;

    assert.equal(firstToken, secondToken);
    assert.notEqual(firstToken, otherAccountToken);
    assert.ok(!firstToken.includes(path.basename(first.root)));
    assert.ok(!firstToken.includes('shared-account'));
});

test('a same-size external rewrite with the old mtime restored changes the token', t => {
    const { root, file } = fixture(t);
    const before = JSON.stringify({
        _settingsRevision: 7,
        extension_settings: { 'dialogue-colors': { value: 'AA' } },
    });
    fs.writeFileSync(file, before);
    const beforeStat = fs.statSync(file);
    const oldToken = call(tokenRequest(root, '')).result.extensionSettingsToken;

    const after = before.replace('"value":"AA"', '"value":"BB"');
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    fs.writeFileSync(file, after);
    fs.utimesSync(file, beforeStat.atime, beforeStat.mtime);

    const updated = call(tokenRequest(root, oldToken));
    assert.equal(updated.result.unchanged, undefined);
    assert.equal(updated.result.extension_settings['dialogue-colors'].value, 'BB');
    assert.notEqual(updated.result.extensionSettingsToken, oldToken);
});

test('a missing requested block has a stable token and an unchanged response', t => {
    const { root, file } = fixture(t);
    const names = ['dialogue-colors'];
    fs.writeFileSync(file, JSON.stringify({
        _settingsRevision: 7,
        extension_settings: { other: { untouched: true } },
    }));

    const full = call(tokenRequest(root, '', 'fixture', names));
    assert.equal(full.status, 200);
    assert.deepEqual(full.result.extension_settings, {});
    const token = full.result.extensionSettingsToken;
    assert.match(token, /^[a-f0-9]{64}$/);

    const unchanged = call(tokenRequest(root, token, 'fixture', names));
    assert.equal(unchanged.result.unchanged, true);
    assert.equal(unchanged.result.extensionSettingsToken, token);
    assert.equal(unchanged.result.extension_settings, undefined);

    fs.writeFileSync(file, JSON.stringify({
        _settingsRevision: 7,
        extension_settings: { 'dialogue-colors': { value: 'appeared' } },
    }));
    const appeared = call(tokenRequest(root, token, 'fixture', names));
    assert.equal(appeared.result.unchanged, undefined);
    assert.deepEqual(appeared.result.extension_settings['dialogue-colors'], { value: 'appeared' });
    assert.notEqual(appeared.result.extensionSettingsToken, token);
});
