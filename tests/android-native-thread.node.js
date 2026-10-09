import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
function missingPrerequisite() {
    if (process.platform !== 'linux') return 'requires Linux';
    if (!fs.existsSync('/usr/include/node/node.h')) return 'Node development headers are not installed';
    if (spawnSync('g++', ['--version']).status !== 0) return 'g++ is not installed';
    // Headers can be installed without the linkable library. Ask the same compiler
    // used below so its library search paths (including LIBRARY_PATH) are honoured.
    const hasNodeLibrary = ['libnode.so', 'libnode.a'].some(library => {
        const result = spawnSync('g++', [`-print-file-name=${library}`], { encoding: 'utf8' });
        const file = result.stdout?.trim();
        return result.status === 0 && file !== library && Boolean(file) && fs.existsSync(file);
    });
    if (!hasNodeLibrary) return 'linkable libnode is not installed (install the Node development library)';
    if (spawnSync('javac', ['-version']).status !== 0) return 'javac is not installed';
    if (spawnSync('java', ['-version']).status !== 0) return 'java is not installed';
    return false;
}

test('Android JNI starts Node with its own stack even from a small Java thread', { skip: missingPrerequisite(), timeout: 90000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-native-thread-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const javaPath = spawnSync('sh', ['-c', 'command -v javac'], { encoding: 'utf8' }).stdout.trim();
    const javaHome = path.dirname(path.dirname(fs.realpathSync(javaPath)));
    const run = (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, `${command}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
    };
    const library = path.join(directory, 'libneconyan-node.so');
    run('g++', ['-std=c++20', '-shared', '-fPIC', '-pthread', '-I/usr/include/node',
        `-I${javaHome}/include`, `-I${javaHome}/include/linux`,
        path.join(root, 'android/app/src/main/cpp/native.cpp'), '-lnode', '-o', library]);
    const harness = path.join(directory, 'ServerService.java');
    fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
public class ServerService {
    private static native int startNode(String[] args, String cache);
    public static void main(String[] args) throws Exception {
        System.load(args[0]);
        Thread thread = new Thread(null, () -> {
            int result = startNode(new String[]{"node", args[1]}, args[2]);
            if (result != 0) throw new AssertionError("Node exit " + result);
        }, "small-java-thread", 256 * 1024);
        thread.setUncaughtExceptionHandler((t, error) -> { error.printStackTrace(); System.exit(1); });
        thread.start();
        thread.join();
    }
}`);
    run('javac', ['-d', directory, harness]);
    const script = path.join(directory, 'probe.cjs');
    fs.writeFileSync(script, `
const assert = require('node:assert/strict');
const tokenizer = require(${JSON.stringify(path.join(root, 'node_modules/tiktoken'))}).encoding_for_model('gpt-3.5-turbo');
assert.ok(tokenizer.encode('An old story, still continuing. '.repeat(10000)).length > 50000);
tokenizer.free();
assert.throws(() => { function recurse() { return recurse() + 1; } recurse(); }, RangeError);
console.log('STACK_GUARD_OK');
`);
    run('java', ['-cp', directory, 'io.github.platberlitz.neconyan.ServerService', library, script, directory]);
    assert.match(fs.readFileSync(path.join(directory, 'server.log'), 'utf8'), /STACK_GUARD_OK/);
    assert.match(fs.readFileSync(path.join(directory, 'native-startup.txt'), 'utf8'), /Stack: 8192 KiB/);
});
