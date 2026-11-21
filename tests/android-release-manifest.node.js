import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the APK verifier rejects mismatched versions, SDKs and CPUs even under Python optimisation', () => {
    const python = `
import importlib.util
import struct

spec = importlib.util.spec_from_file_location('apk', 'scripts/verify-android-release.py')
apk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk)

def expect_failure(call, *args):
    try:
        call(*args)
    except ValueError:
        return
    raise RuntimeError(f'{call.__name__} accepted {args!r}')

badging = """package: name='io.github.platberlitz.neconyan' versionCode='1240301' versionName='1.24.3.1'
minSdkVersion:'30'
targetSdkVersion:'36'
native-code: 'arm64-v8a'
"""
apk.verify_badging(badging, '1.24.3.1', 'arm64-v8a')
apk.verify_badging(badging.replace('minSdkVersion', 'sdkVersion'), '1.24.3.1', 'arm64-v8a')
for original, wrong in [('1240301', '1240300'), ('neconyan', 'debug'), ("'30'", "'29'"), ("'36'", "'35'"), ('arm64-v8a', 'x86_64')]:
    expect_failure(apk.verify_badging, badging.replace(original, wrong), '1.24.3.1', 'arm64-v8a')
expect_failure(apk.verify_badging, badging + "sdkVersion:'29'\\n", '1.24.3.1', 'arm64-v8a')
for version in ['1.100.1', '1.2.3.100', '01.2.3', '2100.0.1', '1.2.3.4.5', '0.0.0']:
    expect_failure(apk.version_code, version)

elf = bytearray(64 + 56)
elf[:6] = bytes.fromhex('7f454c460201')
struct.pack_into('<H', elf, 18, 183)
struct.pack_into('<Q', elf, 32, 64)
struct.pack_into('<HH', elf, 54, 56, 1)
struct.pack_into('<IIQQQQQQ', elf, 64, 1, 5, 0, 16384, 0, 0, 0, 16384)
apk.verify_elf(elf, 'libnode.so', 'arm64-v8a')
expect_failure(apk.verify_elf, elf, 'libnode.so', 'x86_64')
expect_failure(apk.verify_elf, elf[:100], 'libnode.so', 'arm64-v8a')
struct.pack_into('<Q', elf, 112, 4096)
expect_failure(apk.verify_elf, elf, 'libnode.so', 'arm64-v8a')
`;
    const result = spawnSync('python3', ['-B', '-O', '-c', python], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
});
