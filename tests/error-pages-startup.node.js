import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// This file imports none of the modules the change adds, so it can also be run on the code before it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFolder = path.join(root, 'tests', 'fixtures', 'shipped-error-pages');
const PAGES = ['forbidden-by-whitelist.html', 'host-not-allowed.html', 'https-required.html', 'invalid-csrf.html', 'url-not-found.html'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = (page, blob) => fs.readFileSync(path.join(fixtureFolder, `${page.replace(/\.html$/, '')}.${blob}.html`));

function walk(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(folder, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

test('I1 error pages ship only in default/content/errors', () => {
    assert.equal(fs.existsSync(path.join(root, 'default', 'public', 'error')), false, 'default/public/error must not exist: error pages ship only in default/content/errors');
    const folders = new Set(walk(path.join(root, 'default'))
        .filter(file => [...PAGES, 'unauthorized.html'].includes(path.basename(file)))
        .map(file => path.relative(root, path.dirname(file)).split(path.sep).join('/')));
    assert.deepEqual([...folders], ['default/content/errors']);
});

const SCRIPT_FILES = [
    'Start.bat', 'Start-Node.bat', 'Start-Bun.bat', 'Start.command', 'Start-Node.command', 'Start-Bun.command', 'start.sh', 'start-node.sh',
    'start-bun.sh', 'start-termux-node.sh', 'start-termux-bun.sh', 'Remote-Link.cmd', 'Dockerfile', 'docker/docker-entrypoint.sh',
    'android/server-bootstrap.mjs', 'scripts/build-android-payload.js', 'scripts/self-update.sh', 'scripts/Self-Update.ps1',
    ...fs.readdirSync(path.join(root, '.github', 'workflows')).filter(name => name.endsWith('.yml')).map(name => `.github/workflows/${name}`),
];
const NAMES = ['public/error', 'public\\error', 'default/public/error', '_errors', ...PAGES];
// The one comment and the one entry that keep init from copying a leftover default/public/error folder.
const INIT_EXEMPT = [
    'skip: [\'error\'],',
    '// Error pages ship in default/content/errors and are managed by src/error-pages.js. A default/public/error folder left by an older version must never be copied again.',
];

test('I2 no start-up script or init step names the error pages or public/error', () => {
    const texts = SCRIPT_FILES.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
    texts.push(['package.json (scripts)', JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts)]);
    const init = fs.readFileSync(path.join(root, 'src', 'server-init.js'), 'utf8').split('\n');
    for (const exempt of INIT_EXEMPT) {
        assert.ok(init.filter(line => line.trim() === exempt).length <= 1, `src/server-init.js may hold this line once at most: ${exempt}`);
    }
    texts.push(['src/server-init.js', init.filter(line => !INIT_EXEMPT.includes(line.trim())).join('\n')]);
    for (const [file, text] of texts) {
        for (const name of NAMES) {
            assert.equal(text.includes(name), false, `${file} names ${name}. Error pages ship only in default/content/errors and are managed by src/error-pages.js; start-up scripts must not copy or name them.`);
        }
    }
});

/** A copy of what init needs, with node_modules linked, so init runs in a folder of its own. */
function prepareInstallation(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-init-'));
    t.after(() => {
        try {
            fs.unlinkSync(path.join(folder, 'node_modules'));
        } catch {
            // Not linked (the set-up failed early).
        }
        try {
            fs.rmdirSync(path.join(folder, 'node_modules'));
        } catch {
            // Already removed.
        }
        fs.rmSync(folder, { recursive: true, force: true });
    });
    fs.cpSync(path.join(root, 'src'), path.join(folder, 'src'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(folder, 'package.json'));
    fs.mkdirSync(path.join(folder, 'default'));
    fs.copyFileSync(path.join(root, 'default', 'config.yaml'), path.join(folder, 'default', 'config.yaml'));
    fs.cpSync(path.join(root, 'default', 'public'), path.join(folder, 'default', 'public'), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(folder, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return folder;
}

function runInit(folder) {
    // Exit code 0 is required; the output is only useful when it fails.
    return execFileSync(process.execPath, [path.join(folder, 'src', 'server-init.js')], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const listing = folder => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : null);

test('I3 init on a fresh installation never creates public/error', t => {
    const folder = prepareInstallation(t);
    runInit(folder);
    runInit(folder);
    assert.equal(fs.existsSync(path.join(folder, 'public', 'css', 'user.css')), true, 'public/css/user.css is created');
    assert.equal(fs.existsSync(path.join(folder, 'config.yaml')), true);
    assert.equal(fs.existsSync(path.join(folder, 'public', 'error')), false, 'init must not create public/error');
});

test('I4 init over a leftover default/public/error and stale copies adds nothing to public/error', t => {
    const folder = prepareInstallation(t);
    const leftover = path.join(folder, 'default', 'public', 'error');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'forbidden-by-whitelist.html'), fixture('forbidden-by-whitelist.html', '70ff71852b'));
    fs.writeFileSync(path.join(leftover, 'host-not-allowed.html'), fixture('host-not-allowed.html', '19ec5e990b'));
    fs.writeFileSync(path.join(leftover, 'invalid-csrf.html'), fixture('invalid-csrf.html', 'f72eb8cf14'));
    fs.writeFileSync(path.join(leftover, 'unauthorized.html'), fs.readFileSync(path.join(root, 'default', 'content', 'errors', 'unauthorized.html')));
    fs.writeFileSync(path.join(leftover, 'url-not-found.html'), fixture('url-not-found.html', '87974145f7'));

    const publicError = path.join(folder, 'public', 'error');
    fs.mkdirSync(publicError, { recursive: true });
    const old = new Date('2020-01-01T00:00:00Z');
    const existing = {
        'forbidden-by-whitelist.html': fixture('forbidden-by-whitelist.html', '70ff71852b'),
        'url-not-found.html': Buffer.from('<h1>Our own 404</h1>\n'),
    };
    for (const [name, bytes] of Object.entries(existing)) {
        fs.writeFileSync(path.join(publicError, name), bytes);
        fs.utimesSync(path.join(publicError, name), old, old);
    }
    const read = name => ({ sha256: sha256(fs.readFileSync(path.join(publicError, name))), mtimeMs: fs.statSync(path.join(publicError, name)).mtimeMs });
    const before = Object.fromEntries(Object.keys(existing).map(name => [name, read(name)]));

    runInit(folder);
    runInit(folder);

    assert.deepEqual(listing(publicError), Object.keys(existing).sort(), 'no file from the leftover folder is copied');
    for (const name of Object.keys(existing)) assert.deepEqual(read(name), before[name], name);
    assert.equal(fs.existsSync(path.join(folder, 'public', 'css', 'user.css')), true, 'the rest of default/public is still synchronised');
});
