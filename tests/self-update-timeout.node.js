import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../scripts/self-update.sh', import.meta.url);

test('self-update bounds a fetch that stops making progress', () => {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /command -v timeout/);
    assert.match(source, /GIT_HTTP_LOW_SPEED_LIMIT=1000/);
    assert.match(source, /GIT_HTTP_LOW_SPEED_TIME=8/);
    assert.match(source, /timeout 15 git fetch --quiet/);
    assert.match(source, /fetch_upstream "\$upstream_remote"/);
    const syntax = spawnSync('bash', ['-n', script.pathname], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});
