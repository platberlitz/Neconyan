import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, jest, test } from '@jest/globals';
import { roleplayHash, roleplaySettingsHash } from '../src/roleplay-store.js';
import { readRoleplaySettingsJson } from '../src/generation/settings-cache.js';
import { readJsonShared } from '../src/mewmory/store.js';

const TOP_LEVEL_BOOKKEEPING = ['_version', '_settingsRevision', 'accountStorage'];
const UNBOUND_EXTENSIONS = ['neconyan_conversation', 'dialogue-colors'];

function settingsFixture() {
    return {
        _version: 4,
        _settingsRevision: 11,
        accountStorage: { mirrored: { revision: 11 }, chats: ['one', 'two'] },
        username: 'Ari',
        user_avatar: 'user-default.png',
        power_user: {
            auto_swipe: false,
            reply_generation_location: 'browser',
            context: { story_string: 'A saved story string', story_string_position: 0 },
            persona_descriptions: {
                'persona.png': { description: 'A saved persona', connections: [{ id: 'chat-one' }], appendices: [] },
            },
        },
        extension_settings: {
            neconyan_conversation: { lastSync: 1000, events: [{ id: 'conversation-event' }] },
            'dialogue-colors': { palette: ['#ffffff', '#000000'] },
            vectors: { enabled_chats: true, enabled_files: false, source: 'A saved vector source' },
            regex: [{ findRegex: '/alpha/g', replaceString: 'beta', placement: [1, 2], disabled: false }],
        },
        world_info: { globalSelect: ['Lore'], charLore: [{ name: 'Nova', extraBooks: ['Nova Lore'] }] },
        world_info_settings: { world_info_include_names: true, world_info_depth: 2, world_info_budget: 25 },
        nested: { list: [1, 2, { label: 'three' }], flags: { enabled: true } },
    };
}

/** The original implementation, kept in the test as the hash contract. */
function referenceHash(settings) {
    const bound = { ...settings };
    for (const key of TOP_LEVEL_BOOKKEEPING) delete bound[key];
    const extensions = bound.extension_settings;
    if (extensions && typeof extensions === 'object' && !Array.isArray(extensions)
        && UNBOUND_EXTENSIONS.some(key => Object.hasOwn(extensions, key))) {
        bound.extension_settings = { ...extensions };
        for (const key of UNBOUND_EXTENSIONS) delete bound.extension_settings[key];
    }
    const powerUser = bound.power_user;
    if (powerUser && typeof powerUser === 'object' && !Array.isArray(powerUser)
        && Object.hasOwn(powerUser, 'reply_generation_location')) {
        bound.power_user = { ...powerUser };
        delete bound.power_user.reply_generation_location;
    }
    return roleplayHash(bound);
}

function outcome(fn) {
    try {
        return { hash: fn() };
    } catch (error) {
        return { error: error.code ?? error.name };
    }
}

function expectMatchesReference(settings) {
    const expected = outcome(() => referenceHash(settings));
    const actual = outcome(() => roleplaySettingsHash(settings));
    expect(actual).toEqual(expected);
}

test('the cached settings fingerprint is identical to the uncached binding hash', () => {
    const settings = settingsFixture();
    const expected = referenceHash(settings);
    expect(roleplaySettingsHash(settings)).toBe(expected);
    expect(roleplaySettingsHash(settings)).toBe(expected);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
});

test('a repeated read reuses the fingerprint without serialising the settings again', () => {
    const settings = settingsFixture();
    const expected = roleplaySettingsHash(settings);
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
        expect(roleplaySettingsHash(settings)).toBe(expected);
        expect(stringify).not.toHaveBeenCalled();
    } finally {
        stringify.mockRestore();
    }
});

test('a relevant in-memory change invalidates the cached fingerprint', () => {
    const settings = settingsFixture();
    const original = roleplaySettingsHash(settings);
    roleplaySettingsHash(settings);
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
        settings.power_user.context.story_string = 'A changed story string';
        expect(roleplaySettingsHash(settings)).not.toBe(original);
        expect(stringify).toHaveBeenCalled();
        expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    } finally {
        stringify.mockRestore();
    }
    settings.extension_settings.vectors.enabled_chats = false;
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    settings.nested.list[0] = 'one';
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    settings.nested.flags = { enabled: true };
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    delete settings.nested.flags;
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    settings.nested.list.push(4);
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
});

test('key order changes that canonical hashing ignores keep the same fingerprint', () => {
    const settings = { beta: 1, alpha: 2, nested: { delta: 4, charlie: 3 } };
    const original = roleplaySettingsHash(settings);
    const reordered = { alpha: 2, beta: 1, nested: { charlie: 3, delta: 4 } };
    expect(roleplaySettingsHash(reordered)).toBe(original);
    delete settings.alpha;
    settings.alpha = 2;
    expect(roleplaySettingsHash(settings)).toBe(original);
});

test('a structurally equal replacement keeps the fingerprint but a new value does not', () => {
    const settings = settingsFixture();
    const original = roleplaySettingsHash(settings);
    const equalReplacement = JSON.parse(JSON.stringify(settings.extension_settings.regex));
    settings.extension_settings.regex = equalReplacement;
    expect(roleplaySettingsHash(settings)).toBe(original);
    settings.extension_settings.regex[0].replaceString = 'gamma';
    expect(roleplaySettingsHash(settings)).not.toBe(original);
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
});

test('bookkeeping and reply-location changes do not invalidate a running reply', () => {
    const settings = settingsFixture();
    const original = roleplaySettingsHash(settings);
    roleplaySettingsHash(settings);
    settings._version++;
    settings._settingsRevision += 5;
    settings.accountStorage = { mirrored: { revision: 99 }, chats: ['different'] };
    settings.extension_settings.neconyan_conversation = { lastSync: 2000, events: [] };
    settings.extension_settings['dialogue-colors'] = { palette: ['#123456'] };
    settings.power_user.reply_generation_location = 'server';
    expect(roleplaySettingsHash(settings)).toBe(original);
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
    // A setting that a prompt actually reads must still stop the reply.
    settings.world_info_settings.world_info_depth = 4;
    expect(roleplaySettingsHash(settings)).not.toBe(original);
    expect(roleplaySettingsHash(settings)).toBe(referenceHash(settings));
});

test('a mutation that makes the settings invalid cannot fall through to the cached hash', () => {
    const settings = settingsFixture();
    const original = roleplaySettingsHash(settings);
    settings.callback = () => 'not JSON';
    expect(() => roleplaySettingsHash(settings)).toThrow(/JSON-only/);
    delete settings.callback;
    expect(roleplaySettingsHash(settings)).toBe(original);

    settings.nested.list[1] = NaN;
    expect(() => roleplaySettingsHash(settings)).toThrow(/JSON-only/);
    settings.nested.list[1] = 2;
    expect(roleplaySettingsHash(settings)).toBe(original);

    settings.self = settings;
    expect(() => roleplaySettingsHash(settings)).toThrow(/circular/i);
    delete settings.self;
    expect(roleplaySettingsHash(settings)).toBe(original);

    settings.nested.list.extra = 'not an array element';
    expect(() => roleplaySettingsHash(settings)).toThrow(/JSON-only/);
    delete settings.nested.list.extra;
    expect(roleplaySettingsHash(settings)).toBe(original);

    const hidden = Symbol('not JSON');
    settings[hidden] = true;
    expect(() => roleplaySettingsHash(settings)).toThrow(/JSON-only/);
    delete settings[hidden];
    expect(roleplaySettingsHash(settings)).toBe(original);
});

test('a null prototype below the root cannot reuse a cached JSON hash', () => {
    const settings = { a: 1, nested: { b: 2 } };
    roleplaySettingsHash(settings);
    Object.setPrototypeOf(settings.nested, null);
    expect(() => roleplaySettingsHash(settings)).toThrow(/JSON-only/);
    expectMatchesReference(settings);

    const fresh = { a: 1, nested: Object.assign(Object.create(null), { b: 2 }) };
    expectMatchesReference(fresh);

    const extension = { a: 1, extension_settings: { vectors: { enabled: true } } };
    roleplaySettingsHash(extension);
    Object.setPrototypeOf(extension.extension_settings, null);
    expectMatchesReference(extension);

    const unboundExtension = { a: 1, extension_settings: { neconyan_conversation: { lastSync: 1 } } };
    roleplaySettingsHash(unboundExtension);
    Object.setPrototypeOf(unboundExtension.extension_settings, null);
    expectMatchesReference(unboundExtension);

    const powerUser = { a: 1, power_user: { auto_swipe: false, reply_generation_location: 'browser' } };
    roleplaySettingsHash(powerUser);
    Object.setPrototypeOf(powerUser.power_user, null);
    expectMatchesReference(powerUser);
});

test('a root accessor that changes between reads cannot leave a stale cached hash', () => {
    let reads = 0;
    const settings = { a: 1 };
    Object.defineProperty(settings, 'x', { enumerable: true, configurable: true,
        get() { reads++; return reads === 1 ? 'old' : 'new'; } });
    const first = roleplaySettingsHash(settings);
    const second = roleplaySettingsHash(settings);
    expect(first).toBe(roleplayHash({ a: 1, x: 'old' }));
    expect(second).toBe(roleplayHash({ a: 1, x: 'new' }));
    expect(second).not.toBe(first);
});

test('accessors and proxies added after capture force a fresh hash', () => {
    const accessor = { a: 1, nested: { value: 'old' } };
    const accessorHash = roleplaySettingsHash(accessor);
    Object.defineProperty(accessor, 'a', { enumerable: true, configurable: true, get() { return 1; } });
    let stringify = jest.spyOn(JSON, 'stringify');
    let actual;
    let calls;
    try {
        actual = outcome(() => roleplaySettingsHash(accessor));
        calls = stringify.mock.calls.length;
    } finally {
        stringify.mockRestore();
    }
    expect(calls).toBeGreaterThan(0);
    expect(actual).toEqual(outcome(() => referenceHash(accessor)));
    expect(actual.hash).toBe(accessorHash);

    const proxied = { a: 1, nested: { value: 'old' } };
    const proxiedHash = roleplaySettingsHash(proxied);
    proxied.nested = new Proxy(proxied.nested, { get(target, key, receiver) { return Reflect.get(target, key, receiver); } });
    stringify = jest.spyOn(JSON, 'stringify');
    try {
        actual = outcome(() => roleplaySettingsHash(proxied));
        calls = stringify.mock.calls.length;
    } finally {
        stringify.mockRestore();
    }
    expect(calls).toBeGreaterThan(0);
    expect(actual).toEqual(outcome(() => referenceHash(proxied)));
    expect(actual.hash).toBe(proxiedHash);
});

test('the cache is per settings object and cannot leak one account hash into another', () => {
    const first = settingsFixture();
    const second = settingsFixture();
    second.username = 'Bea';
    second.nested.list.push(3);
    const firstHash = roleplaySettingsHash(first);
    const secondHash = roleplaySettingsHash(second);
    expect(firstHash).toBe(referenceHash(first));
    expect(secondHash).toBe(referenceHash(second));
    expect(firstHash).not.toBe(secondHash);
    second.username = 'Ari';
    second.nested.list.pop();
    expect(roleplaySettingsHash(second)).toBe(firstHash);
    expect(roleplaySettingsHash(first)).toBe(firstHash);
    first.username = 'Bea';
    expect(roleplaySettingsHash(first)).not.toBe(firstHash);
    expect(roleplaySettingsHash(second)).toBe(firstHash);
});

test('a same-size in-place settings save gives the hot shared loader a new snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-settings-shared-hash-'));
    try {
        const filename = path.join(root, 'settings.json');
        const firstText = JSON.stringify({ username: 'first', nested: { value: 1 } });
        const secondText = JSON.stringify({ username: 'other', nested: { value: 2 } });
        expect(Buffer.byteLength(firstText)).toBe(Buffer.byteLength(secondText));
        fs.writeFileSync(filename, firstText);
        const firstStat = fs.statSync(filename);
        const first = readJsonShared(filename, {});
        const firstHash = roleplaySettingsHash(first);
        expect(readJsonShared(filename, {})).toBe(first);
        fs.writeFileSync(filename, secondText);
        fs.utimesSync(filename, firstStat.atime, new Date(firstStat.mtimeMs + 2000));
        const changed = readJsonShared(filename, {});
        expect(changed).not.toBe(first);
        expect(roleplaySettingsHash(changed)).not.toBe(firstHash);
        expect(roleplaySettingsHash(changed)).toBe(referenceHash(changed));
        expect(roleplaySettingsHash(first)).toBe(firstHash);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a changed settings file is hashed from its new loaded snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-settings-hash-'));
    try {
        const filename = path.join(root, 'settings.json');
        fs.writeFileSync(filename, JSON.stringify({ value: 'first', power_user: { auto_swipe: false } }));
        const first = readRoleplaySettingsJson(filename, { limit: 1024 * 1024 });
        const firstHash = roleplaySettingsHash(first);
        expect(readRoleplaySettingsJson(filename, { limit: 1024 * 1024 })).toBe(first);
        expect(roleplaySettingsHash(first)).toBe(firstHash);

        fs.writeFileSync(filename, JSON.stringify({ value: 'second', power_user: { auto_swipe: true } }));
        const changed = readRoleplaySettingsJson(filename, { limit: 1024 * 1024 });
        expect(changed).not.toBe(first);
        expect(roleplaySettingsHash(changed)).not.toBe(firstHash);
        expect(roleplaySettingsHash(changed)).toBe(referenceHash(changed));
        expect(roleplaySettingsHash(first)).toBe(firstHash);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
