import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = path.join(repoRoot, 'scripts/bump-agent-template-versions.js');
const templatesRel = 'public/scripts/extensions/in-chat-agents/templates';

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function writeJson(filePath, value, spaces) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, spaces)}\n`);
}

test('version bumps keep each template file in its own indentation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-template-bump-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.copyFileSync(scriptSource, path.join(root, 'scripts/bump-agent-template-versions.js'));
        const templatesDir = path.join(root, templatesRel);
        fs.mkdirSync(templatesDir, { recursive: true });

        const twoSpace = { id: 'tpl-two', version: 1, prompt: 'Old prompt.' };
        const fourSpace = { id: 'tpl-four', version: 3, prompt: 'Old prompt.' };
        writeJson(path.join(templatesDir, 'two.json'), twoSpace, 2);
        writeJson(path.join(templatesDir, 'four.json'), fourSpace, 4);
        writeJson(path.join(templatesDir, 'index.json'), [twoSpace, fourSpace], 4);
        writeJson(path.join(templatesDir, 'groups.json'), [], 4);
        writeJson(path.join(templatesDir, 'regex-bundles.json'), {}, 2);

        git(root, 'init', '-q');
        git(root, 'add', '.');
        git(root, 'commit', '-q', '-m', 'base');

        const changed = { prompt: 'New prompt.' };
        writeJson(path.join(templatesDir, 'two.json'), { ...twoSpace, ...changed }, 2);
        writeJson(path.join(templatesDir, 'four.json'), { ...fourSpace, ...changed }, 4);
        writeJson(path.join(templatesDir, 'index.json'), [{ ...twoSpace, ...changed }, { ...fourSpace, ...changed }], 4);

        execFileSync(process.execPath, ['scripts/bump-agent-template-versions.js'], { cwd: root, stdio: 'pipe' });

        const expectedTwo = { ...twoSpace, ...changed, version: 2 };
        const expectedFour = { ...fourSpace, ...changed, version: 4 };
        assert.equal(fs.readFileSync(path.join(templatesDir, 'two.json'), 'utf8'), `${JSON.stringify(expectedTwo, null, 2)}\n`);
        assert.equal(fs.readFileSync(path.join(templatesDir, 'four.json'), 'utf8'), `${JSON.stringify(expectedFour, null, 4)}\n`);
        assert.equal(
            fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf8'),
            `${JSON.stringify([expectedTwo, expectedFour], null, 4)}\n`,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
