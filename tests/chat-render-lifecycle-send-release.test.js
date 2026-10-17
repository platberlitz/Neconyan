import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => row.id?.name === 'createChatSendReleaseGuard')
    .map(row => source.slice(row.start, row.end)).join('\n');

function fixture({ sending = true, revision = 7 } = {}) {
    const runtime = vm.createContext({ is_send_press: sending, chatSendStartRevision: revision });
    vm.runInContext(functions, runtime);
    return runtime;
}

test('the generation already running when the hold starts does not release it', () => {
    const runtime = fixture({ sending: true, revision: 7 });
    const sendStarted = runtime.createChatSendReleaseGuard(7);

    expect(sendStarted()).toBe(false);
    expect(sendStarted()).toBe(false);

    runtime.is_send_press = false;
    expect(sendStarted()).toBe(false);

    runtime.is_send_press = true;
    expect(sendStarted()).toBe(true);
});

test('a new start revision releases even when idle and the next Send were never observed', () => {
    const runtime = fixture({ sending: true, revision: 7 });
    const sendStarted = runtime.createChatSendReleaseGuard(7);

    runtime.chatSendStartRevision = 8;
    expect(sendStarted()).toBe(true);
});

test('an idle hold releases on the first Send that follows', () => {
    const runtime = fixture({ sending: false, revision: 9 });
    const sendStarted = runtime.createChatSendReleaseGuard(9);

    expect(sendStarted()).toBe(false);
    runtime.is_send_press = true;
    expect(sendStarted()).toBe(true);
});

test('a stale guard stays released after a newer start revision', () => {
    const runtime = fixture({ sending: false, revision: 3 });
    const sendStarted = runtime.createChatSendReleaseGuard(3);

    runtime.chatSendStartRevision = 4;
    expect(sendStarted()).toBe(true);
    runtime.chatSendStartRevision = 5;
    expect(sendStarted()).toBe(true);
});
