import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Android emulator startup retries and failure diagnostics retain strict checks', () => {
    const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./android-emulator-support-test.py', import.meta.url))], {
        encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
