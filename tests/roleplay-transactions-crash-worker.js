/* global Atomics, SharedArrayBuffer */
// Test-only process: pause at a real filesystem boundary until the parent sends SIGKILL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath, FILE_WRITE_RECOVERY_SUFFIX } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { commitSingleChatWrite, reconcileSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
const { prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
const { parseChatJsonl } = await import('../src/chat-recovery.js');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = roleplayStoreDirectory(spec.scope);
const originals = Object.fromEntries(['openSync', 'closeSync', 'fsyncSync', 'writeSync', 'renameSync', 'unlinkSync'].map(name => [name, fs[name]]));
const descriptors = new Map();
let chatWrites = 0;

function pause(boundary) {
    if (spec.boundary !== boundary) return;
    originals.writeSync(1, JSON.stringify({ boundary }) + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Crash pause unexpectedly resumed.');
}

fs.openSync = (filename, ...args) => {
    if (filename === spec.memory?.guard && args[0] === 'wx') pause('before-memory-guard');
    const fd = originals.openSync(filename, ...args);
    descriptors.set(fd, String(filename));
    return fd;
};
fs.closeSync = fd => {
    descriptors.delete(fd);
    return originals.closeSync(fd);
};
fs.writeSync = (fd, buffer, ...args) => {
    if (descriptors.get(fd) === spec.filename) {
        chatWrites++;
        if (spec.boundary === 'partial-create') {
            const written = originals.writeSync(fd, buffer, 0, 1, 0);
            originals.fsyncSync(fd);
            pause('partial-create');
            return written;
        }
    }
    const written = originals.writeSync(fd, buffer, ...args);
    if (descriptors.get(fd) === spec.filename && chatWrites === 2) {
        originals.fsyncSync(fd);
        pause('partial-update');
    }
    return written;
};
fs.fsyncSync = fd => {
    originals.fsyncSync(fd);
    const filename = descriptors.get(fd);
    if (filename?.startsWith(path.join(root, 'pending') + path.sep) && filename.endsWith('/chat.after.jsonl')) pause('payload-durable');
    if (filename === spec.filename && parseChatJsonl(fs.readFileSync(filename)).status === 'ok') pause('chat-durable');
    if (filename === spec.memory?.guard) pause('memory-guard-durable');
    if (filename === spec.memory?.archive) pause('memory-archive-durable');
    if (filename === root) {
        const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).state;
        if (state.pending?.journal && state.pending.phase === 'prepared') pause('journal-recorded');
        if (state.pending?.phase === 'prepared' && !state.pending.repair) pause('pending-durable');
        if (!state.pending && Object.keys(state.submissions).length) pause('receipt-durable');
    }
};
fs.renameSync = (from, to) => {
    originals.renameSync(from, to);
    if (to === spec.filename) pause('restore-published');
    if (path.dirname(to) === spec.scope.directories.backups && path.basename(to).startsWith('chat_nova_')) pause('backup-published');
};
fs.unlinkSync = filename => {
    const result = originals.unlinkSync(filename);
    if (String(filename).startsWith(path.join(root, 'pending') + path.sep) && String(filename).endsWith('/chat.after.jsonl')) pause('payload-unlinked');
    if (filename === spec.filename + FILE_WRITE_RECOVERY_SUFFIX) pause('journal-unlinked');
    return result;
};

const host = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };
const result = spec.reconcile
    ? reconcileSingleChatWrite(spec.scope, spec.input.operationKey, host)
    : commitSingleChatWrite(spec.scope, spec.input, host);
for (const [name, fn] of Object.entries(originals)) fs[name] = fn;
process.stdout.write(JSON.stringify({ result }) + '\n');
