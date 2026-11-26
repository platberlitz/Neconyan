import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('dependencies stay on the patched isomorphic-git and proxy-agent lines', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.match(pkg.dependencies['isomorphic-git'], /^\^1\.(3[89]|[4-9]\d)\./);
    assert.match(pkg.dependencies['proxy-agent'], /^\^8\./);
    const [major, minor] = lock.packages['node_modules/isomorphic-git'].version.split('.').map(Number);
    assert.ok(major === 1 && minor >= 38, 'isomorphic-git is locked at 1.38 or later');
    assert.ok(Number(lock.packages['node_modules/proxy-agent'].version.split('.')[0]) >= 8);
    assert.match(read('bun.lock'), /"isomorphic-git": \["isomorphic-git@1\.(3[89]|[4-9]\d)\./);
});

test('Android limits cleartext traffic to loopback', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    assert.doesNotMatch(manifest, /usesCleartextTraffic/);
    assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
    const config = read('android/app/src/main/res/xml/network_security_config.xml');
    assert.match(config, /<base-config cleartextTrafficPermitted="false"/);
    assert.match(config, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/);
    assert.match(config, /<domain includeSubdomains="false">localhost<\/domain>/);
});

test('iOS allows local networking only and keeps ATS for internet hosts', () => {
    const project = read('ios/project.yml');
    assert.doesNotMatch(project, /NSAllowsArbitraryLoads:\s*true/);
    assert.match(project, /NSAllowsLocalNetworking:\s*true/);
});

test('iOS downloads need a workspace source frame, even for workspace URLs', () => {
    const swift = read('ios/App/BrowserController.swift');
    assert.match(swift, /if isLocal\(url\) \{\s*\/\/[^\n]*\n\s*decisionHandler\(download \? \(fromLocal \? \.download : \.cancel\) : \.allow\)/);
    assert.match(swift, /if isSubframe, \["https", "http"\]\.contains\(scheme\) \{\s*decisionHandler\(download \? \.cancel : \.allow\)/);
    assert.match(swift, /let allowDownload = \(responseUrl\.map \{ isLocal\(\$0\) \} \?\? false\) \|\| \(navigationResponse\.isForMainFrame && \["blob", "data"\]\.contains\(responseScheme\)\)/);
});

test('iOS bootstrap disables TLS like Android and the managed config guard covers iOS', async () => {
    const bootstrap = read('ios/server-bootstrap.mjs');
    assert.match(bootstrap, /config\.ssl = \{ \.\.\.\(config\.ssl \?\? \{\}\), enabled: false \}/);
    const admin = read('src/endpoints/server-admin.js');
    assert.match(admin, /NECONYAN_IOS_APP === '1'\) \{[^}]*some\([^\n]*validateIOSConfigEdit/);
    const { validateIOSConfigEdit } = await import('../src/android-config-policy.js');
    const managed = { dataRoot: '/data', port: 4433, basicAuthUser: { username: 'neconyan', password: 'p' } };
    validateIOSConfigEdit({ listen: false, port: 4433, ssl: { enabled: false } }, managed);
    for (const config of [{ port: 1 }, { dataRoot: '/x' }, { ssl: { enabled: true } }, { basicAuthUser: { username: 'x' } }]) {
        assert.throws(() => validateIOSConfigEdit(config, managed), /iPhone app/);
    }
});

test('Docker publishes on loopback and drops root and writable entrypoints by default', () => {
    assert.match(read('docker/docker-compose.yml'), /"127\.0\.0\.1:4433:4433"/);
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /install -o root -g root -m 755 "\.\/docker\/docker-entrypoint\.sh" \/usr\/local\/bin\/docker-entrypoint\.sh/);
    assert.match(dockerfile, /ENTRYPOINT \["tini", "--", "\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
    const entrypoint = read('docker/docker-entrypoint.sh');
    assert.match(entrypoint, /PUID="\$\{PUID:-1000\}"/);
    assert.match(entrypoint, /PGID="\$\{PGID:-1000\}"/);
    assert.match(entrypoint, /\[ ! -L "\$dir" \]/);
    assert.match(entrypoint, /chown -hR bun:bun/);
    assert.doesNotMatch(entrypoint, /Default \(Root\)/);
    assert.equal(spawnSync('sh', ['-n', path.join(root, 'docker/docker-entrypoint.sh')]).status, 0);
});

test('workflows scope the app token to this repository with minimal permissions', () => {
    const expected = {
        'pr-check-merge-conflicts.yaml': ['permission-contents: read', 'permission-issues: write', 'permission-pull-requests: write'],
        'changelog-merged-prs.yml': ['permission-contents: write', 'permission-pull-requests: read'],
        'sync-quick-image-gen.yml': ['permission-contents: write', 'permission-pull-requests: write', 'permission-issues: write'],
        'job-close-stale.yml': ['permission-issues: write', 'permission-pull-requests: write'],
    };
    for (const [file, permissions] of Object.entries(expected)) {
        const text = read(`.github/workflows/${file}`);
        const blocks = text.split('actions/create-github-app-token@').slice(1).map(part => part.split(/\n\s*- name:/)[0]);
        assert.ok(blocks.length > 0, `${file} mints a token`);
        for (const block of blocks) {
            assert.match(block, /repositories: \$\{\{ github\.event\.repository\.name \}\}/, file);
            for (const permission of permissions) assert.ok(block.includes(permission), `${file} grants ${permission}`);
        }
    }
    assert.match(read('.github/workflows/pr-check-merge-conflicts.yaml'), /group: pr-merge-conflicts-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}-/);
});

test('Quick Image Gen sync rejects dash-led refs and separates git options', () => {
    const script = read('scripts/sync-quick-image-gen.sh');
    assert.match(script, /fetch --quiet --depth=1 -- origin "\$UPSTREAM_REF"/);
    assert.match(script, /remote add -- origin "\$UPSTREAM_REPO"/);
    assert.match(read('.github/workflows/sync-quick-image-gen.yml'), /"\$ref" == -\*/);
    const result = spawnSync('bash', [path.join(root, 'scripts/sync-quick-image-gen.sh'), '--ref', '--upload-pack=touch /tmp/pwned'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not start with a dash/);
    const base = spawnSync('bash', [path.join(root, 'scripts/sync-quick-image-gen.sh'), '--base', '--upload-pack=x'], { encoding: 'utf8' });
    assert.notEqual(base.status, 0);
    assert.match(base.stderr, /must not start with a dash/);
    assert.match(script, /Refusing to check out a non-hexadecimal commit/);
});

test('Remote-Link verifies a pinned cloudflared checksum before running it', () => {
    const script = read('Remote-Link.cmd');
    assert.match(script, /setlocal/);
    assert.match(script, /pushd "%~dp0"/);
    assert.match(script, /popd/);
    assert.doesNotMatch(script, /releases\/latest/);
    assert.match(script, /CLOUDFLARED_SHA256=[0-9a-f]{64}/);
    assert.match(script, /curl -fsSL/);
    assert.ok(script.indexOf('Get-FileHash') < script.indexOf('"%~dp0cloudflared.exe" tunnel'));
    assert.match(read('Start.bat'), /pushd "%~dp0"/);
});
