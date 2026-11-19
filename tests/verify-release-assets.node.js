import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('release asset verifier rejects mismatched builds and downloads', () => {
    execFileSync('python3', ['-B', fileURLToPath(new URL('./verify-release-assets.py', import.meta.url))], { stdio: 'inherit' });
});
