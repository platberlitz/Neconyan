import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
const parser = source.match(/^export (async function parseJsonFile\(file\) \{[\s\S]*?^\})/m)[1];
const parseJsonFile = vm.runInNewContext(`(${parser})`, { TextDecoder });

describe('shared JSON file importer', () => {
    test('accepts Unicode and the optional UTF-8 byte-order mark', async () => {
        await expect(parseJsonFile(new Blob(['\uFEFF{"name":"猫"}']))).resolves.toEqual({ name: '猫' });
    });

    test('rejects malformed JSON rather than leaving the import pending', async () => {
        await expect(parseJsonFile(new Blob(['{"broken":']))).rejects.toThrow();
    });

    test('rejects damaged UTF-8 rather than changing imported text', async () => {
        await expect(parseJsonFile(new Blob([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]))).rejects.toThrow();
    });

    test('propagates an unreadable file to the importer', async () => {
        await expect(parseJsonFile({ arrayBuffer: async () => { throw new Error('Cannot read file'); } })).rejects.toThrow('Cannot read file');
    });
});
