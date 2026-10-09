import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('./android-native-thread.node.js', import.meta.url), 'utf8');
const probe = source.slice(source.indexOf('function missingPrerequisite()'), source.indexOf('\ntest('));

function check({ library = null, missingTool = null, compilerError = false } = {}) {
    return vm.runInNewContext(`${probe}\nmissingPrerequisite()`, {
        process: { platform: 'linux' },
        fs: { existsSync: file => file === '/usr/include/node/node.h' || file === library },
        spawnSync(command, args) {
            if (args[0].startsWith('-print-file-name=')) {
                const name = args[0].split('=')[1];
                return { status: compilerError ? 1 : 0, stdout: library?.endsWith(name) ? `${library}\n` : `${name}\n` };
            }
            return { status: command === missingTool ? 1 : 0 };
        },
    });
}

test('native thread prerequisites explain a headers-only Node installation', () => {
    assert.match(check(), /linkable libnode is not installed/);
});

test('native thread prerequisites accept a library found on the compiler search path', () => {
    assert.equal(check({ library: '/custom/lib/libnode.so' }), false);
    assert.equal(check({ library: '/custom/lib/libnode.a' }), false);
});

test('native thread prerequisites reject an unsuccessful library lookup', () => {
    assert.match(check({ library: '/custom/lib/libnode.so', compilerError: true }), /linkable libnode/);
});

test('native thread prerequisites require both Java compilation and execution', () => {
    for (const missingTool of ['javac', 'java']) {
        assert.equal(check({ library: '/custom/lib/libnode.so', missingTool }), `${missingTool} is not installed`);
    }
});
