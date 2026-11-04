import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeSource = path.join(root, 'android/app/src/main/cpp/native.cpp');

function jdkIncludeDirectories() {
    const home = process.env.JDK_HOME || process.env.JAVA_HOME;
    const candidates = [];
    if (home) candidates.push(path.join(home, 'include'));
    const javac = spawnSync('sh', ['-c', 'command -v javac && readlink -f "$(command -v javac)"'], { encoding: 'utf8' });
    if (javac.status === 0) {
        const javaHome = path.dirname(path.dirname(javac.stdout.trim().split('\n').at(-1)));
        candidates.push(path.join(javaHome, 'include'));
    }
    for (const include of candidates) {
        if (fs.existsSync(path.join(include, 'jni.h'))) {
            // jni.h includes jni_md.h, which lives in the per-platform directory.
            const platform = fs.existsSync(path.join(include, 'linux', 'jni_md.h')) ? path.join(include, 'linux') : null;
            return platform ? [include, platform] : [include];
        }
    }
    return null;
}

function nodeHeaderDirectory() {
    // Official Node distributions ship their headers next to the binary.
    const include = path.join(path.dirname(path.dirname(process.execPath)), 'include', 'node');
    return fs.existsSync(path.join(include, 'node.h')) ? include : null;
}

test('the native launcher compiles against the real Node and JNI headers', t => {
    if (spawnSync('g++', ['--version']).error) return t.skip('g++ is not installed');
    if (spawnSync('sh', ['-c', 'command -v javac']).error) return t.skip('a JDK is not installed');
    const includes = jdkIncludeDirectories();
    const nodeInclude = nodeHeaderDirectory();
    if (!includes || !nodeInclude) return t.skip('Node or JNI headers are not available on this runner');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-native-'));
    try {
        const compile = spawnSync('g++', ['-std=c++20', '-c', '-I', nodeInclude, ...includes.flatMap(dir => ['-I', dir]), nativeSource, '-o', path.join(directory, 'native.o')], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the native launcher never dereferences an unchecked JNI string or closes stdout before the log opens', () => {
    // Comments describe the old freopen behaviour, so match code only.
    const source = fs.readFileSync(nativeSource, 'utf8').replace(/\/\/[^\n]*/g, '');
    // freopen closes stdout before it knows the new file opened; a failure there
    // leaves Node writing to a closed descriptor or one reused by another file.
    assert.doesNotMatch(source, /freopen|fileno\(stdout\)/);
    assert.match(source, /if \(int log = open\(\(std::string\(cache\) \+ "\/server\.log"\)/);
    assert.match(source, /dup2\(log, STDOUT_FILENO\) < 0 \|\| dup2\(log, STDERR_FILENO\) < 0/);
    assert.match(source, /if \(log != STDOUT_FILENO && log != STDERR_FILENO\) close\(log\);/);
    assert.match(source, /logNote = "Could not open the server log/);
    assert.match(source, /if \(!launch\.note\.empty\(\)\) fputs\(launch\.note\.c_str\(\), report\);/);
    // Every GetStringUTFChars result is checked before use; a failure throws for the JVM.
    const checked = source.match(/GetStringUTFChars\((?:cachePath|item), nullptr\)/g) || [];
    assert.equal(checked.length, 2);
    assert.match(source, /if \(cache == nullptr\) \{[\s\S]*?ThrowOrReturn\(env, "Cannot read the local server cache path\."\);[\s\S]*?return 1;/);
    assert.match(source, /if \(value == nullptr\) \{[\s\S]*?ThrowOrReturn\(env, "Cannot read the local server launch arguments\."\);[\s\S]*?return 1;/);
    // No blanket swallowing: an exception of our own is only queued when none is pending.
    assert.match(source, /if \(!env->ExceptionCheck\(\)\) env->ThrowNew/);
});
