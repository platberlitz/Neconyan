/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createHash, webcrypto } from 'node:crypto';
import { commitPreparedCardImport, removeCharacter } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/client/importer.js';

const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const revision = createHash('sha256').update(png).digest('hex');
const avatar = 'Imported.png';
let host;
let request;
const originals = new Map(['SillyTavern', 'document', 'fetch', 'crypto'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

beforeEach(() => {
    host = { streamingProcessor: null, characters: [], getRequestHeaders: () => ({}),
        getCharacters: jest.fn(async () => { host.characters = [{ avatar, name: 'Imported' }]; }) };
    Object.defineProperty(globalThis, 'SillyTavern', { configurable: true, value: { getContext: () => ({ ...host }) } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { dataset: {} } } });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    request = jest.fn(async url => {
        if (url === '/api/characters/all') return Response.json([]);
        if (url === '/api/characters/import') return Response.json({ file_name: avatar });
        if (url === `/characters/${avatar}`) return new Response(png);
        if (url === '/api/characters/delete') return Response.json({});
        throw new Error(`Unexpected request: ${url}`);
    });
    globalThis.fetch = request;
});

afterEach(() => {
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});

function importCharacter(options = {}) {
    return commitPreparedCardImport({ file: new File(['{"name":"Imported"}'], 'card.json'), kind: 'json' }, options);
}

const operations = [
    ['import', () => importCharacter(), '/api/characters/import'],
    ['replace', () => importCharacter({ replaceAvatar: avatar, expectedRevision: revision }), '/api/characters/import'],
    ['undo', () => removeCharacter(avatar, { expectedRevision: revision }), '/api/characters/delete'],
];

describe.each(operations)('%s generation guard', (_name, run, writeUrl) => {
    test.each([
        ['no processor', null],
        ['finished reply', { isFinished: true, isStopped: false }],
        ['finished stopped reply', { isFinished: true, isStopped: true }],
    ])('allows an idle host with %s', async (_state, processor) => {
        host.streamingProcessor = processor;
        await run();
        expect(request.mock.calls.filter(([url]) => url === writeUrl)).toHaveLength(1);
        expect(host.getCharacters).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['streaming reply', { isFinished: false }, false],
        ['stopping reply not yet finished', { isFinished: false, isStopped: true }, false],
        ['non-streaming reply', null, true],
        ['host still busy after stream ends', { isFinished: true }, true],
    ])('blocks a %s', async (_state, processor, busy) => {
        host.streamingProcessor = processor;
        if (busy) globalThis.document.body.dataset.generating = 'true';
        await expect(run()).rejects.toThrow('generation_active');
        expect(request).not.toHaveBeenCalled();
    });

    test('rechecks the current host context after asynchronous preflight', async () => {
        host.streamingProcessor = { isFinished: true };
        request.mockImplementationOnce(async url => {
            host.streamingProcessor = { isFinished: false };
            return url === '/api/characters/all' ? Response.json([]) : new Response(png);
        });
        await expect(run()).rejects.toThrow('generation_active');
        expect(request.mock.calls.filter(([url]) => url === writeUrl)).toHaveLength(0);
    });
});

test('rechecks generation after the commit callback', async () => {
    await expect(importCharacter({ onCommitStart: () => { host.streamingProcessor = { isFinished: false }; } }))
        .rejects.toThrow('generation_active');
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/characters/all']);
});

test('a blocked import can be retried after that reply finishes', async () => {
    host.streamingProcessor = { isFinished: false };
    await expect(importCharacter()).rejects.toThrow('generation_active');
    host.streamingProcessor.isFinished = true;
    await expect(importCharacter()).resolves.toMatchObject({ avatar, committed: true, canUndo: true, refreshed: true });
    expect(request.mock.calls.filter(([url]) => url === '/api/characters/import')).toHaveLength(1);
});
