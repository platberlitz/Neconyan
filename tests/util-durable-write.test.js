import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { tryWriteFileSync, decodeFileWriteRecovery } from '../src/util.js';

const describeDirectoryFsync = process.platform === 'win32' ? describe.skip : describe;
let tempRoot;

afterEach(() => {
    jest.restoreAllMocks();
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = undefined;
    }
});

describe('bounded legacy write evidence', () => {
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const record = () => ({ version: 1, dev: '1', ino: '2', originalHash: hash('abc'), nextHash: hash('next'), originalData: 'YWJj' });
    const encode = value => Buffer.from(JSON.stringify(value));

    for (const birthtime of [undefined, '123']) {
        test(`decodes the real journal shape with birthtime ${birthtime} without returning old bytes`, () => {
            const value = { ...record(), birthtime };
            expect(decodeFileWriteRecovery(encode(value), 3)).toEqual({ originalHash: value.originalHash, nextHash: value.nextHash,
                dev: '1', ino: '2', birthtime: birthtime ?? null });
        });
    }

    for (const [name, mutate] of [
        ['version', value => { value.version = 2; }],
        ['identity type', value => { value.dev = 1; }],
        ['birthtime', value => { value.birthtime = '-1'; }],
        ['unknown field', value => { value.unrecognised = true; }],
        ['hash mismatch', value => { value.originalHash = '0'.repeat(64); }],
        ['padding', value => { value.originalData = 'YWJj===='; }],
        ['noncanonical bits', value => { value.originalData = 'YR=='; value.originalHash = hash('a'); }],
        ['invalid alphabet', value => { value.originalData = 'YW J'; }],
    ]) {
        test(`refuses malformed ${name}`, () => {
            const value = record();
            mutate(value);
            expect(decodeFileWriteRecovery(encode(value), 16)).toBeNull();
        });
    }

    test('refuses excessive encoded bytes before any base64 allocation', () => {
        const bytes = encode({ ...record(), originalData: 'YWJjYWJj' });
        const from = jest.spyOn(Buffer, 'from');
        expect(decodeFileWriteRecovery(bytes, 3)).toBeNull();
        expect(from).not.toHaveBeenCalled();
    });

    test('checks decoded length, UTF-8 and the caller byte limit', () => {
        expect(decodeFileWriteRecovery(encode(record()), 2)).toBeNull();
        expect(decodeFileWriteRecovery(Buffer.from([0xff]), 3)).toBeNull();
        expect(decodeFileWriteRecovery(encode(record()), Infinity)).toBeNull();
    });
});

describeDirectoryFsync('tryWriteFileSync durable writes', () => {
    test('flushes the parent directory after committing a durable write', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-durable-'));
        const filePath = path.join(tempRoot, 'metadata.json');
        const fsyncSync = fs.fsyncSync.bind(fs);
        let directoryFlushed = false;
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (fs.fstatSync(fileDescriptor).isDirectory()) {
                directoryFlushed = true;
            }
            return fsyncSync(fileDescriptor);
        });

        tryWriteFileSync(filePath, '{}', 'utf8', { durable: true });

        expect(directoryFlushed).toBe(true);
    });

    test('accepts filesystems that do not support directory fsync', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-durable-'));
        const filePath = path.join(tempRoot, 'metadata.json');
        const fsyncSync = fs.fsyncSync.bind(fs);
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (fs.fstatSync(fileDescriptor).isDirectory()) {
                throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
            }
            return fsyncSync(fileDescriptor);
        });

        expect(() => tryWriteFileSync(filePath, '{}', 'utf8', { durable: true })).not.toThrow();
        expect(fs.readFileSync(filePath, 'utf8')).toBe('{}');
    });

    test('protected create failures retain the named file while legacy cleanup remains unchanged', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-protected-create-'));
        const fsync = fs.fsyncSync.bind(fs);
        jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
            if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error('Flush failed'), { code: 'EIO' });
            return fsync(fd);
        });
        const protectedPath = path.join(tempRoot, 'protected.json');
        const legacyPath = path.join(tempRoot, 'legacy.json');
        expect(() => tryWriteFileSync(protectedPath, 'evidence', 'utf8', {
            expectedFileAbsent: true, durable: true, preserveOnCreateError: true,
        })).toThrow('Flush failed');
        expect(fs.readFileSync(protectedPath, 'utf8')).toBe('evidence');
        expect(() => tryWriteFileSync(legacyPath, 'legacy', 'utf8', { expectedFileAbsent: true, durable: true })).toThrow('Flush failed');
        expect(fs.existsSync(legacyPath)).toBe(false);
    });

    test('replacement validation rejects asynchronous and incompatible options before publication', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-replace-validation-'));
        const filename = path.join(tempRoot, 'source');
        fs.writeFileSync(filename, 'original');
        expect(() => tryWriteFileSync(filename, 'new', 'utf8', { replaceFileOnly: true, validateBeforeReplace: async () => {} })).toThrow(/synchronous/);
        expect(() => tryWriteFileSync(filename, 'new', 'utf8', { validateBeforeReplace: () => {} })).toThrow(/replacement-only/);
        expect(() => tryWriteFileSync(filename, 'new', 'utf8', { preserveOnCreateError: true })).toThrow(/create-only/);
        expect(() => tryWriteFileSync(filename, 'new', 'utf8', { replaceFileOnly: true, validateBeforeReplace: () => Promise.resolve() })).toThrow(/promise/);
        expect(fs.readFileSync(filename, 'utf8')).toBe('original');
        expect(fs.readdirSync(tempRoot)).toEqual(['source']);
    });
});
