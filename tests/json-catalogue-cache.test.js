import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonCatalogueCache } from '../src/json-catalogue-cache.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-catalogue-')); });
afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});
const file = name => path.join(root, `${name}.json`);
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2));

describe('JSON catalogue reads', () => {
    test('reuses validation, preserves original text and isolates returned objects', () => {
        write('one', { nested: { name: 'one' } });
        const source = fs.readFileSync(file('one'), 'utf8');
        const reads = jest.spyOn(fs, 'readFileSync');
        const parses = jest.spyOn(JSON, 'parse');
        const cache = createJsonCatalogueCache();
        expect(cache.read(file('one'))).toBe(source);
        const first = cache.read(file('one'), true);
        first.nested.name = 'mutated';
        expect(cache.read(file('one'), true)).toEqual({ nested: { name: 'one' } });
        expect(reads).toHaveBeenCalledTimes(1);
        expect(parses).toHaveBeenCalledTimes(1);
    });

    test('detects same-size edits with restored mtime and atomic replacement', () => {
        const cache = createJsonCatalogueCache();
        write('one', { name: 'one' });
        const before = fs.statSync(file('one'));
        expect(cache.read(file('one'), true).name).toBe('one');
        write('one', { name: 'two' });
        fs.utimesSync(file('one'), before.atime, before.mtime);
        expect(cache.read(file('one'), true).name).toBe('two');
        write('replacement', { name: 'new' });
        fs.renameSync(file('replacement'), file('one'));
        expect(cache.read(file('one'), true).name).toBe('new');
    });

    test('missing and corrupt files fail rather than serving a cached copy', () => {
        const cache = createJsonCatalogueCache();
        write('one', { valid: true });
        cache.read(file('one'));
        fs.writeFileSync(file('one'), '{broken');
        expect(() => cache.read(file('one'))).toThrow(SyntaxError);
        fs.unlinkSync(file('one'));
        expect(() => cache.read(file('one'))).toThrow();
        write('one', { restored: true });
        expect(cache.read(file('one'), true)).toEqual({ restored: true });
    });

    test('separate paths stay independent and the least recently read entry is evicted', () => {
        const cache = createJsonCatalogueCache({ maxEntries: 2 });
        for (const name of ['one', 'two', 'three']) write(name, { name });
        cache.read(file('one'));
        cache.read(file('two'));
        cache.read(file('one'));
        cache.read(file('three'));
        const reads = jest.spyOn(fs, 'readFileSync');
        expect(cache.read(file('one'), true).name).toBe('one');
        expect(reads).not.toHaveBeenCalled();
        expect(cache.read(file('two'), true).name).toBe('two');
        expect(reads).toHaveBeenCalledTimes(1);
    });

    test('byte limits evict old entries and an oversized file does not evict useful ones', () => {
        const cache = createJsonCatalogueCache({ maxBytes: 100 });
        for (const name of ['one', 'two', 'three']) write(name, { name });
        write('large', { text: 'x'.repeat(200) });
        cache.read(file('one'));
        cache.read(file('two'));
        cache.read(file('three'));
        cache.read(file('large'));
        const reads = jest.spyOn(fs, 'readFileSync');
        cache.read(file('three'));
        expect(reads).not.toHaveBeenCalled();
        cache.read(file('one'));
        cache.read(file('large'));
        expect(reads).toHaveBeenCalledTimes(2);
    });

    test('does not cache text when the file changes during its read', () => {
        const cache = createJsonCatalogueCache();
        write('one', { name: 'old' });
        const original = fs.readFileSync;
        const spy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce((...args) => {
            const text = original(...args);
            write('one', { name: 'new' });
            return text;
        });
        expect(cache.read(file('one'), true).name).toBe('old');
        expect(cache.read(file('one'), true).name).toBe('new');
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
