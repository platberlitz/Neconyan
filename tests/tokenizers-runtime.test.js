/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('web tokenizer runtime bootstrap', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
    const dataRoot = fileURLToPath(new URL('../data', import.meta.url));
    let originalLocationDescriptor;
    let originalDataRoot;
    let originalCwd;

    beforeEach(() => {
        jest.resetModules();
        originalCwd = process.cwd();
        process.chdir(repoRoot);
        originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
        originalDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = dataRoot;

        Object.defineProperty(globalThis, 'location', {
            value: { href: '' },
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        if (originalLocationDescriptor) {
            Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
        } else {
            delete globalThis.location;
        }

        globalThis.DATA_ROOT = originalDataRoot;
        process.chdir(originalCwd);
    });

    test('loads web tokenizers when the server runtime exposes an empty location href', async () => {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(defaultConfigPath);

        const { getWebTokenizer } = await import('../src/endpoints/tokenizers.js');
        const tokenizer = await getWebTokenizer('llama3').get();

        expect(tokenizer).toBeTruthy();
        expect(tokenizer.encode('hello world').length).toBeGreaterThan(0);
    });

    test('cancelling a local tokenizer wait leaves its shared load available to other callers', async () => {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(defaultConfigPath);
        const { getWebTokenizer, encodeGenerationText } = await import('../src/endpoints/tokenizers.js');
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const loading = jest.spyOn(getWebTokenizer('qwen2'), 'get').mockReturnValue(pending);
        const controller = new AbortController();
        const remove = jest.spyOn(controller.signal, 'removeEventListener');
        try {
            const cancelled = encodeGenerationText('qwen2', 'word', '', controller.signal);
            const continuing = encodeGenerationText('qwen2', 'word');
            controller.abort();
            await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
            release({ encode: () => [17] });
            await expect(continuing).resolves.toEqual([17]);
        } finally {
            release({ encode: () => [17] });
            loading.mockRestore();
        }
    });

    test('Mewmory rejects a silently substituted tokenizer even after its fallback is cached', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-tokenizer-'));
        globalThis.DATA_ROOT = root;
        jest.unstable_mockModule('node-fetch', () => ({ default: jest.fn(async () => ({ ok: false, status: 503, statusText: 'Test download failure' })) }));
        try {
            const { setConfigFilePath } = await import('../src/util.js');
            setConfigFilePath(defaultConfigPath);
            const { getWebTokenizer, encodeGenerationText } = await import('../src/endpoints/tokenizers.js');
            const tokenizer = getWebTokenizer('qwen2');
            await expect(encodeGenerationText('qwen2', 'word')).rejects.toThrow(/qwen2.*llama3/);
            expect(await tokenizer.get()).toBeTruthy();
            expect(tokenizer.loadedModel).toBe('llama3');
            await expect(encodeGenerationText('qwen2', 'word')).rejects.toThrow(/qwen2.*llama3/);
            const { getCounter } = await import('../src/mewmory/tokens.js');
            await expect(getCounter('qwen2')).rejects.toThrow(/qwen2.*llama3.*History has been kept/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
