import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncScript = path.join(repoRoot, 'scripts', 'sync-quick-image-gen.sh');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'sync-quick-image-gen.yml');
const nodeBinDir = path.dirname(process.execPath);
const testEnv = {
    ...process.env,
    PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}`,
};

function makeFixture(t, version) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-qig-sync-meta-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const sourceDir = path.join(tempDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.js'), '');
    fs.writeFileSync(path.join(sourceDir, 'style.css'), '');
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ version }, null, 2));

    return {
        tempDir,
        sourceDir,
        metadataFile: path.join(tempDir, 'metadata.env'),
        markerFile: path.join(tempDir, 'executed'),
        githubOutputFile: path.join(tempDir, 'github-output.txt'),
    };
}

function sourceMetadataInBash(metadataFile) {
    const DumpScript = [
        'set -euo pipefail',
        '. "$1"',
        'node -e "process.stdout.write(JSON.stringify({',
        '  QIG_VERSION: process.env.QIG_VERSION,',
        '  QIG_COMMIT: process.env.QIG_COMMIT,',
        '  QIG_SHORT_COMMIT: process.env.QIG_SHORT_COMMIT,',
        '  QIG_REF: process.env.QIG_REF,',
        '  QIG_REPO: process.env.QIG_REPO,',
        '}))"',
    ].join('\n');

    const raw = execFileSync('bash', ['-c', 'set -euo pipefail; . "$1"; export QIG_VERSION QIG_COMMIT QIG_SHORT_COMMIT QIG_REF QIG_REPO; ' + DumpScript.split('\n').slice(2).join(' '), 'bash', metadataFile], {
        cwd: repoRoot,
        env: testEnv,
        encoding: 'utf8',
        stdio: 'pipe',
    });
    return JSON.parse(raw);
}

test('sync-quick-image-gen metadata preserves legitimate unquoted values for regex and shell consumers', t => {
    const { sourceDir, metadataFile, githubOutputFile } = makeFixture(t, '3.5.0');

    execFileSync('bash', [
        syncScript,
        '--source', sourceDir,
        '--base', 'local-source',
        '--check',
        '--ref', 'main',
        '--repo', 'https://github.com/platberlitz/sillytavern-image-gen.git',
        '--metadata-file', metadataFile,
    ], {
        cwd: repoRoot,
        env: testEnv,
        encoding: 'utf8',
        stdio: 'pipe',
    });

    const metadata = fs.readFileSync(metadataFile, 'utf8');
    assert.equal(metadata.match(/^QIG_VERSION=(.*)$/m)?.[1], '3.5.0');
    assert.equal(metadata.match(/^QIG_SHORT_COMMIT=(.*)$/m)?.[1], 'local-source');

    const sourced = sourceMetadataInBash(metadataFile);
    assert.deepEqual(sourced, {
        QIG_VERSION: '3.5.0',
        QIG_COMMIT: 'local-source',
        QIG_SHORT_COMMIT: 'local-source',
        QIG_REF: 'main',
        QIG_REPO: 'https://github.com/platberlitz/sillytavern-image-gen.git',
    });

    const workflowYaml = fs.readFileSync(workflowPath, 'utf8');
    const stepMatch = workflowYaml.match(/\. "\$metadata_file"[\s\S]*?>> "\$GITHUB_OUTPUT"/);
    assert.ok(stepMatch, 'workflow must source $metadata_file and write $GITHUB_OUTPUT');
    execFileSync('bash', ['-c', `set -euo pipefail\n${stepMatch[0]}`], {
        cwd: repoRoot,
        env: {
            ...testEnv,
            metadata_file: metadataFile,
            GITHUB_OUTPUT: githubOutputFile,
        },
        encoding: 'utf8',
        stdio: 'pipe',
    });
    assert.equal(
        fs.readFileSync(githubOutputFile, 'utf8'),
        [
            'version=3.5.0',
            'commit=local-source',
            'short_commit=local-source',
            'ref=main',
            'repo=https://github.com/platberlitz/sillytavern-image-gen.git',
            '',
        ].join('\n'),
    );
});

test('sync-quick-image-gen escapes malicious version, ref and repo strings as literals without shell execution', t => {
    const markerPath = path.join(os.tmpdir(), `neconyan-qig-probe-${process.pid}-${Date.now()}`);
    t.after(() => fs.rmSync(markerPath, { force: true }));

    const maliciousVersion = [
        `1.0.0 $(printf vulnerable > "${markerPath}")`,
        `'single' "double" \`printf backtick > "${markerPath}"\``,
        'commit=injected',
    ].join('\n');
    const maliciousRef = `refs/heads/space 'quote' "dq" $(printf ref > "${markerPath}")\nrepo=injected`;
    const maliciousRepo = `https://example.invalid/repo.git; printf repo > "${markerPath}"\nshort_commit=injected`;

    const { sourceDir, metadataFile } = makeFixture(t, maliciousVersion);

    execFileSync('bash', [
        syncScript,
        '--source', sourceDir,
        '--base', 'local-source',
        '--check',
        '--ref', maliciousRef,
        '--repo', maliciousRepo,
        '--metadata-file', metadataFile,
    ], {
        cwd: repoRoot,
        env: testEnv,
        encoding: 'utf8',
        stdio: 'pipe',
    });

    assert.equal(fs.existsSync(markerPath), false, 'sync script must not execute command substitutions while writing metadata');

    const rawLines = fs.readFileSync(metadataFile, 'utf8').trimEnd().split('\n');
    assert.equal(rawLines.length, 5, 'escaped shell assignments must remain one physical line per variable');

    const sourced = sourceMetadataInBash(metadataFile);
    assert.equal(fs.existsSync(markerPath), false, 'sourcing metadata file must not execute command substitutions');
    assert.deepEqual(sourced, {
        QIG_VERSION: maliciousVersion,
        QIG_COMMIT: 'local-source',
        QIG_SHORT_COMMIT: 'local-source',
        QIG_REF: maliciousRef,
        QIG_REPO: maliciousRepo,
    });
});

test('sync-quick-image-gen workflow rejects multiline metadata before writing GITHUB_OUTPUT', t => {
    const workflowYaml = fs.readFileSync(workflowPath, 'utf8');
    const stepMatch = workflowYaml.match(/\. "\$metadata_file"[\s\S]*?>> "\$GITHUB_OUTPUT"/);
    assert.ok(stepMatch, 'workflow must source $metadata_file and write $GITHUB_OUTPUT');
    const workflowMetadataStep = `set -euo pipefail\n${stepMatch[0]}`;

    const { sourceDir, metadataFile, githubOutputFile } = makeFixture(t, '1.0.0\ncommit=injected');

    execFileSync('bash', [
        syncScript,
        '--source', sourceDir,
        '--base', 'local-source',
        '--check',
        '--metadata-file', metadataFile,
    ], {
        cwd: repoRoot,
        env: testEnv,
        encoding: 'utf8',
        stdio: 'pipe',
    });

    assert.throws(() => {
        execFileSync('bash', ['-c', workflowMetadataStep], {
            cwd: repoRoot,
            env: {
                ...testEnv,
                metadata_file: metadataFile,
                GITHUB_OUTPUT: githubOutputFile,
            },
            encoding: 'utf8',
            stdio: 'pipe',
        });
    }, /Sync metadata values must be non-empty single lines\./);
    assert.equal(fs.existsSync(githubOutputFile), false);
});
