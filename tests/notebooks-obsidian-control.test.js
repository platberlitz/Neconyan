import fs from 'node:fs';
import vm from 'node:vm';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../src/notebooks/obsidian.js', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');

test('an exited owned sync process cancels its termination timer instead of leaving a reused PID at risk', async () => {
    let closed;
    const timer = { unref: jest.fn() };
    const child = { exitCode: null, signalCode: null, connected: true, once: (_event, callback) => { closed = callback; },
        send: () => queueMicrotask(() => { child.exitCode = 0; closed(); }), kill: jest.fn() };
    const entry = { child, clientPid: 12345, base: { directories: { root: '/owned' } }, notebookId: 'nb_1111111111111111', folder: { physical: { dev: 1, ino: 2 } } };
    const clearTimeout = jest.fn();
    const kill = jest.fn();
    const context = vm.createContext({ entry, clearTimeout, clearInterval: jest.fn(), setTimeout: () => timer, process: { kill },
        runtimes: new Map(), folderClaims: new Map(), stoppedRuntimes: new Map(), runtimeKey: () => 'owned', physicalKey: () => '1:2' });
    vm.runInContext(functionSource('stopEntry'), context);
    await context.stopEntry(entry);
    expect(clearTimeout).toHaveBeenCalledWith(timer);
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
});
