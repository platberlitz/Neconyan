import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

// public/script.js is too large to load here, so the pieces behind the 'Cannot connect to Neconyan' and generation error toasts are
// cut out of its source as it stands.
const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function findFunction(node, name, test) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name && test(node)) return node;
    for (const value of Object.values(node)) {
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
            if (!child || typeof child.type !== 'string') continue;
            const found = findFunction(child, name, test);
            if (found) return found;
        }
    }
    return null;
}

function cut(name, test = () => true) {
    const found = findFunction(program, name, test);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
}

function loadPingServer(fetch) {
    const console = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    const host = { fetch, console, getRequestHeaders: () => ({}) };
    vm.runInNewContext(`${cut('pingServer')}\nthis.pingServer = pingServer;`, host);
    return { pingServer: host.pingServer, console };
}

describe('the server check before a reply', () => {
    test('a refused ping writes its HTTP status to the console', async () => {
        for (const [status, statusText] of [[401, 'Unauthorized'], [403, 'Forbidden'], [503, 'Service Unavailable'], [502, '']]) {
            const { pingServer, console } = loadPingServer(async () => ({ ok: false, status, statusText }));
            await expect(pingServer()).resolves.toBe(false);
            expect(console.warn).toHaveBeenCalledWith(`Server ping failed: HTTP ${status} ${statusText}`.trim());
        }
    });

    test('a ping that never arrives writes the network error to the console', async () => {
        const failure = new TypeError('Failed to fetch');
        const { pingServer, console } = loadPingServer(async () => { throw failure; });
        await expect(pingServer()).resolves.toBe(false);
        expect(console.error).toHaveBeenCalledWith('Error pinging server', failure);
    });

    test('a reachable server logs nothing', async () => {
        const { pingServer, console } = loadPingServer(async () => ({ ok: true, status: 200, statusText: 'OK' }));
        await expect(pingServer()).resolves.toBe(true);
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });
});

describe('a reply that fails while generating', () => {
    test('the failure goes to the console as a warning, not an info line', () => {
        // The generation's own handler; the image loaders have onError functions of their own.
        const onError = cut('onError', node => node.async && node.params[0]?.name === 'exception');
        expect(onError).toContain('console.warn(\'Reply generation failed:\', exception);');
        expect(onError).not.toMatch(/console\.log\(\s*exception\s*\)/);
    });
});
