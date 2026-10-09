import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = path.resolve('android/app/src/main/java/io/github/platberlitz/neconyan/Tombstone.java');
const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

// A small protobuf writer, enough to build a debuggerd tombstone the way Android does.
function varint(value) {
    const bytes = [];
    let rest = BigInt(value);
    if (rest < 0n) rest += 1n << 64n;
    do {
        let byte = Number(rest & 0x7fn);
        rest >>= 7n;
        if (rest > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (rest > 0n);
    return Buffer.from(bytes);
}
const number = (field, value) => Buffer.concat([varint((field << 3) | 0), varint(value)]);
const bytes = (field, value) => Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
const string = (field, value) => bytes(field, Buffer.from(value, 'utf8'));
const message = (field, ...parts) => bytes(field, Buffer.concat(parts));
const fixed64 = (field, value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return Buffer.concat([varint((field << 3) | 1), b]); };

function frame(index, file, fn, offset) {
    return message(4, number(1, 0x1000 * (index + 1)), number(2, 0x7f00000000 + 0x1000 * index), number(3, 0x7ffff000), string(4, fn), number(5, offset), string(6, file), string(8, 'abc123'));
}
function thread(id, name, frames) {
    return message(2, number(1, id), string(2, name), ...frames, message(5, string(1, 'memory near sp'), number(2, 0x7ffff000)));
}
function tombstone({ crashingThread = 7, extraThreads = true } = {}) {
    return Buffer.concat([
        string(1, 'arm64'),
        string(2, 'samsung/a16/a16:16/REL/1:user/release-keys'),
        number(5, 1234),
        number(6, crashingThread),
        string(9, 'node'),
        message(10, number(1, 11), string(2, 'SIGSEGV'), number(3, 1), string(4, 'SEGV_MAPERR'), number(8, 1), number(9, 0x7f12345678n)),
        string(14, ''),
        message(15, string(1, 'null pointer dereference')),
        message(16, number(1, crashingThread), thread(crashingThread, 'neconyan-node', [
            frame(0, '/data/app/lib/arm64/libnode.so', 'v8::internal::Runtime_StackGuard', 184),
            frame(1, '/data/app/lib/arm64/libnode.so', '', 0),
            frame(2, '/data/app/lib/arm64/libneconyan-node.so', 'RunNode(void*)', 92),
        ])),
        ...(extraThreads ? [message(16, number(1, 9), thread(9, 'binder:1234_1', [frame(0, '/apex/com.android.runtime/lib64/bionic/libc.so', '__ioctl', 12)]))] : []),
        message(17, fixed64(1, 0x7f00000000), fixed64(2, 0x7f10000000), number(4, 1), string(7, '/data/app/lib/arm64/libnode.so')),
        message(18, string(1, 'main'), message(2, string(1, '10-08 18:31:15.999'), number(2, 1234), number(3, 7), number(4, 6), string(5, 'libc'), string(6, 'Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x7f12345678 in tid 7 (neconyan-node)\n'))),
        string(20, '42s'),
        number(22, 16384),
    ]);
}

function describe(t, input) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'android-tombstone-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const classes = path.join(work, 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(work, 'Describe.java'), `package io.github.platberlitz.neconyan;
public final class Describe {
    public static void main(String[] args) throws Exception {
        try (java.io.InputStream in = new java.io.FileInputStream(args[0])) { System.out.print(Tombstone.describe(in)); }
    }
}
`);
    const file = path.join(work, 'tombstone.pb');
    fs.writeFileSync(file, input);
    execFileSync('javac', ['-d', classes, source, path.join(work, 'Describe.java')]);
    return execFileSync('java', ['-cp', classes, 'io.github.platberlitz.neconyan.Describe', file], { encoding: 'utf8' });
}

test('a crash record is reduced to the signal, the crashing thread and the last log lines', { skip: !hasJava && 'javac is not installed' }, t => {
    const text = describe(t, tombstone());
    const lines = text.split('\n');
    assert.equal(lines[0], 'Signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault address 0x7f12345678');
    assert.equal(lines[1], 'Cause: null pointer dereference');
    assert.equal(lines[2], 'Process uptime: 42s');
    assert.equal(lines[3], 'Crashing thread: 7 (neconyan-node)');
    assert.equal(lines[4], '#00 pc 0000000000001000 /data/app/lib/arm64/libnode.so (v8::internal::Runtime_StackGuard+184) (BuildId: abc123)');
    assert.equal(lines[5], '#01 pc 0000000000002000 /data/app/lib/arm64/libnode.so (BuildId: abc123)');
    assert.equal(lines[6], '#02 pc 0000000000003000 /data/app/lib/arm64/libneconyan-node.so (RunNode(void*)+92) (BuildId: abc123)');
    assert.equal(lines[7], 'Last log lines:');
    assert.match(lines[8], /^ {2}10-08 18:31:15\.999 libc: Fatal signal 11 \(SIGSEGV\)/);
    assert.doesNotMatch(text, /binder|__ioctl/, 'other threads stay out of the summary');
    assert.doesNotMatch(text, /Abort message/, 'an empty abort message is not shown');
});

test('a damaged or empty crash record produces a note instead of an error', { skip: !hasJava && 'javac is not installed' }, t => {
    const truncated = tombstone().subarray(0, 40);
    const text = describe(t, truncated);
    assert.match(text, /Crash record ended early or was damaged/);
    assert.match(describe(t, Buffer.alloc(0)), /held no recognised details/);
    assert.match(describe(t, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])), /damaged/);
});

test('the crashing thread is found even when another thread is listed first', { skip: !hasJava && 'javac is not installed' }, t => {
    const other = message(16, number(1, 2), thread(2, 'Binder:1234_2', [frame(0, '/apex/libc.so', 'syscall', 8)]));
    const crashing = message(16, number(1, 5), thread(5, 'neconyan-node', [frame(0, '/data/app/lib/arm64/libnode.so', 'crashy', 1)]));
    const text = describe(t, Buffer.concat([number(6, 5), message(10, number(1, 6), string(2, 'SIGABRT'), number(3, -6), string(4, 'SI_TKILL')), string(14, 'Check failed: heap'), other, crashing]));
    assert.match(text, /^Signal 6 \(SIGABRT\), code -6 \(SI_TKILL\)\nAbort message: Check failed: heap\nCrashing thread: 5 \(neconyan-node\)\n#00 pc 0000000000001000 \/data\/app\/lib\/arm64\/libnode.so \(crashy\+1\)/);
    assert.doesNotMatch(text, /syscall/);
});
