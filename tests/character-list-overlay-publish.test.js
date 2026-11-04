import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Drives the real cache publish from characters.js: a refresh may only install its
// statistics and probe as one coherent pair, and a concurrent refresh that lost the row
// must discard both, because a lone newer probe over older statistics could hide a save.
const source = readFileSync(new URL('../src/endpoints/characters.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

function extractFunction(name, signature = `function ${name}(`) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`Missing declaration: ${name}`);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end + 3);
}

function buildContext({ statResults, calculateChatSize }) {
    const statCalls = [];
    const scanDirectories = [];
    const context = vm.createContext({
        path,
        console: { error: () => {} },
        fs: {
            statSync: filePath => {
                statCalls.push(filePath);
                const result = statResults.shift();
                if (!result) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return result;
            },
        },
        calculateChatSize: async directory => {
            scanDirectories.push(directory);
            return calculateChatSize(scanDirectories.length - 1);
        },
    });
    vm.runInContext(extractFunction('characterChatProbePath'), context);
    vm.runInContext(extractFunction('applyCharacterListChatOverlay', 'async function applyCharacterListChatOverlay('), context);
    return { context, statCalls, scanDirectories };
}

function makeEntry(context) {
    // Built inside the VM so `entry.probes instanceof Map` sees the same realm the
    // extracted code runs in; host-side reads of the map work across realms.
    return vm.runInContext(`({
        data: [{ avatar: 'Nova.png', chat: 'First', chat_size: 5, date_last_chat: 1000 }],
        probes: new Map([['Nova.png', { chat: 'First', size: 5, mtimeMs: 1000 }]]),
    })`, context);
}

const lastChatByFile = new Map([['Nova.png', 'Second']]);
const directories = { chats: '/data/chats' };
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('character list cache publish coherence', () => {
    test('a concurrent refresh that lost the row discards its probe with its statistics', async () => {
        // Refresh A samples the pointed file pre-save; refresh B samples it post-save.
        // A finishes first and publishes; B must discard its newer probe together with
        // its statistics instead of stamping it over A's pair.
        const pendingScans = [];
        const { context, scanDirectories } = buildContext({
            statResults: [
                { size: 10, mtimeMs: 2000 }, // A's sample: pre-save
                { size: 20, mtimeMs: 3000 }, // B's sample: post-save
            ],
            calculateChatSize: () => new Promise(resolve => pendingScans.push(resolve)),
        });
        const entry = makeEntry(context);

        const first = context.applyCharacterListChatOverlay(directories, entry, lastChatByFile);
        const second = context.applyCharacterListChatOverlay(directories, entry, lastChatByFile);
        expect(pendingScans).toHaveLength(2);

        pendingScans[0]({ chatSize: 30, dateLastChat: 2000 }); // A finishes first
        await flush();
        pendingScans[1]({ chatSize: 40, dateLastChat: 3000 }); // B finishes second
        await Promise.all([first, second]);

        // A's coherent pair survived; B's lone probe must not sit beside A's statistics.
        expect(entry.data[0].chat_size).toBe(30);
        expect(entry.probes.get('Nova.png')).toEqual({ chat: 'Second', size: 10, mtimeMs: 2000 });
        expect(scanDirectories).toHaveLength(2);

        // The save B sampled is still detected afterwards: the lagging A probe misses,
        // so the next refresh rescans and publishes the fresh pair.
        context.fs = {
            statSync: () => ({ size: 20, mtimeMs: 3000 }),
        };
        const third = context.applyCharacterListChatOverlay(directories, entry, lastChatByFile);
        await flush();
        expect(pendingScans).toHaveLength(3);
        pendingScans[2]({ chatSize: 40, dateLastChat: 3000 });
        await third;
        expect(scanDirectories).toHaveLength(3);
        expect(entry.data[0].chat_size).toBe(40);
        expect(entry.probes.get('Nova.png')).toEqual({ chat: 'Second', size: 20, mtimeMs: 3000 });
    });

    test('the winning refresh publishes its row and probe together', async () => {
        // Single refresh: pointer switched, so both statistics and probe move to the new
        // pointed file in one step.
        const { context, scanDirectories } = buildContext({
            statResults: [{ size: 10, mtimeMs: 2000 }],
            calculateChatSize: async () => ({ chatSize: 30, dateLastChat: 2000 }),
        });
        const entry = makeEntry(context);

        const response = await context.applyCharacterListChatOverlay(directories, entry, lastChatByFile);

        expect(entry.data[0]).toEqual({ avatar: 'Nova.png', chat: 'First', chat_size: 30, date_last_chat: 2000 });
        expect(entry.probes.get('Nova.png')).toEqual({ chat: 'Second', size: 10, mtimeMs: 2000 });
        // The response overlays the fresh pointer on a copy; the cached row keeps the card fallback.
        expect(response[0].chat).toBe('Second');
        expect(response[0]).not.toBe(entry.data[0]);
        expect(scanDirectories).toHaveLength(1);
    });
});
