import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const gitClient = await import('../src/git/client.js');
const { PUBLIC_DIRECTORIES } = await import('../src/constants.js');
const { router: extensionsRouter } = await import('../src/endpoints/extensions.js');

const NOT_MANAGED = 'This extension is not managed with Git.';
const EXISTING_METADATA = 'The extension has existing Git metadata that could not be opened.';

function git(cwd, ...args) {
    return execFileSync('git', args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
        stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
}

/**
 * Creates a work tree with the given files, commits it and publishes it as a bare repository.
 * @param {string} root
 * @param {string} name
 * @param {(dir: string) => void} populate
 */
function publishRepo(root, name, populate) {
    const work = path.join(root, 'work', name);
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    populate(work);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'initial');
    git(path.join(root, 'served'), 'clone', '-q', '--bare', work, `${name}.git`);
    return work;
}

/**
 * Serves bare repositories from `projectRoot` over smart HTTP with `git http-backend`.
 * Paths below /redirect/ answer with a redirect to the same path without the prefix.
 * @param {string} projectRoot
 */
async function startGitHttpServer(projectRoot) {
    /** @type {{ host: string | undefined, path: string }[]} */
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://placeholder');
        requests.push({ host: req.headers.host, path: url.pathname });

        if (url.pathname.startsWith('/redirect/')) {
            res.writeHead(302, { Location: `${url.pathname.slice('/redirect'.length)}${url.search}` });
            res.end();
            return;
        }

        const child = spawn('git', ['http-backend'], {
            env: {
                PATH: process.env.PATH,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: req.method,
                CONTENT_TYPE: req.headers['content-type'] ?? '',
                REMOTE_ADDR: '127.0.0.1',
                ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
                ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
                ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
            },
        });
        req.pipe(child.stdin);

        let pending = Buffer.alloc(0);
        let headersSent = false;
        child.stdout.on('data', chunk => {
            if (headersSent) {
                res.write(chunk);
                return;
            }
            pending = Buffer.concat([pending, chunk]);
            const end = pending.indexOf('\r\n\r\n');
            if (end === -1) {
                return;
            }
            let status = 200;
            const headers = {};
            for (const line of pending.subarray(0, end).toString().split('\r\n')) {
                const separator = line.indexOf(':');
                const key = line.slice(0, separator).trim();
                const value = line.slice(separator + 1).trim();
                if (key.toLowerCase() === 'status') {
                    status = Number.parseInt(value, 10);
                } else {
                    headers[key] = value;
                }
            }
            res.writeHead(status, headers);
            headersSent = true;
            res.write(pending.subarray(end + 4));
        });
        child.stdout.on('end', () => {
            if (!headersSent) {
                res.writeHead(500);
            }
            res.end();
        });
        child.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end();
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
        port,
        requests,
        url: name => `http://127.0.0.1:${port}/${name}.git`,
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}

/**
 * Calls an extensions route through a real Express app with the given user.
 * @param {string} route
 * @param {object} user
 * @param {object} body
 * @returns {Promise<{ status: number, text: string, json: any }>}
 */
function callExtensions(route, user, body) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = user;
            next();
        });
        app.use(extensionsRouter);
        const server = app.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            const payload = JSON.stringify(body);
            const request = http.request({
                host: '127.0.0.1',
                port,
                path: route,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    server.close();
                    const text = Buffer.concat(chunks).toString();
                    let json;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = undefined;
                    }
                    resolve({ status: response.statusCode ?? 0, text, json });
                });
            });
            request.on('error', error => {
                server.close();
                reject(error);
            });
            request.end(payload);
        });
    });
}

describe('Git hardening helpers', () => {
    test('every extension Git command gets the safe configuration and environment', () => {
        assert.deepEqual([...gitClient.SAFE_GIT_CONFIG], [
            'safe.bareRepository=explicit',
            'core.sshCommand=',
            'protocol.file.allow=never',
            'core.fsmonitor=false',
            'protocol.allow=never',
            'protocol.http.allow=always',
            'protocol.https.allow=always',
            'http.followRedirects=false',
        ]);
        assert.ok(gitClient.SAFE_GIT_ALLOWED_CONFIG.includes('http.curloptResolve'));

        const saved = { GIT_DIR: process.env.GIT_DIR, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, EDITOR: process.env.EDITOR };
        process.env.GIT_DIR = '/elsewhere/.git';
        process.env.GIT_SSH_COMMAND = 'touch /tmp/pwned';
        process.env.EDITOR = 'vim';
        try {
            const environment = gitClient.getSafeGitEnvironment('/srv/extensions/Example');
            assert.equal(environment.GIT_DIR, undefined);
            assert.equal(environment.GIT_SSH_COMMAND, undefined);
            assert.equal(environment.EDITOR, undefined);
            assert.equal(environment.GIT_CEILING_DIRECTORIES, path.resolve('/srv/extensions'));
            assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
            assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
            assert.equal(environment.PATH, process.env.PATH);
            assert.equal(environment.HOME, process.env.HOME);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test('pinned address entries use the validated address, brackets for IPv6 and skip proxies and IP literals', () => {
        const saved = {};
        for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        try {
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('https://example.com/a.git'), hostname: 'example.com', addresses: ['93.184.216.34'] }), 'example.com:443:93.184.216.34');
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('http://example.com:8080/a.git'), hostname: 'example.com', addresses: ['2606:2800:220:1::1'] }), 'example.com:8080:[2606:2800:220:1::1]');
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('http://example.com/a.git'), hostname: 'example.com', addresses: ['::ffff:93.184.216.34'] }), 'example.com:80:93.184.216.34');
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('http://93.184.216.34/a.git'), hostname: '93.184.216.34', addresses: ['93.184.216.34'] }), null);
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('http://example.com/a.git'), hostname: 'example.com', addresses: [] }), null);
            process.env.HTTPS_PROXY = 'http://proxy.example:3128';
            assert.equal(gitClient.getGitCurlResolveEntry({ url: new URL('https://example.com/a.git'), hostname: 'example.com', addresses: ['93.184.216.34'] }), null);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test('tree entry names that could escape or confuse a checkout are refused', () => {
        for (const segment of ['index.js', 'src', '.github', 'gitignore', 'README.md', 'con-tool.js', 'a.b']) {
            assert.equal(gitClient.isSafeGitTreeSegment(segment), true, segment);
        }
        for (const segment of ['', '.', '..', '.git', '.GIT', '.Git', 'git~1', 'GIT~1', '.git ', '.git.', '.g\u200cit', 'a/b', 'a\\b', 'c:', 'nul\0', 'con', 'CON.txt', 'nul', 'aux.js', 'com1', 'lpt9.md', 'conin$', 'trailing.', 'trailing ', 'tab\there', 'q?', 'star*', 'pipe|']) {
            assert.equal(gitClient.isSafeGitTreeSegment(segment), false, JSON.stringify(segment));
        }
    });

    test('private remotes are refused unless allowed', async () => {
        await assert.rejects(gitClient.validateGitRemote('http://127.0.0.1:9/repo.git'), error => error.status === 403);
        await assert.rejects(gitClient.validateGitRemote('file:///etc/repo.git', { allowPrivate: true }), error => error.status === 400);
        await assert.rejects(gitClient.validateGitRemote('ssh://git@example.com/repo.git', { allowPrivate: true }), error => error.status === 400);
        const target = await gitClient.validateGitRemote('http://127.0.0.1:9/repo.git', { allowPrivate: true });
        assert.deepEqual(target.addresses, ['127.0.0.1']);
    });
});

describe('Git transport hardening against a live smart HTTP server', () => {
    let root;
    let server;

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-git-hardening-'));
        fs.mkdirSync(path.join(root, 'served'), { recursive: true });
        publishRepo(root, 'safe', dir => {
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Safe', version: '1.0.0' }));
            fs.writeFileSync(path.join(dir, 'index.js'), 'export const safe = true;\n');
            fs.mkdirSync(path.join(dir, 'lib'));
            fs.writeFileSync(path.join(dir, 'lib', 'util.js'), 'export {};\n');
        });
        publishRepo(root, 'symlink', dir => {
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Link', version: '1.0.0' }));
            fs.symlinkSync('/etc/passwd', path.join(dir, 'escape.json'));
        });
        const submoduleWork = publishRepo(root, 'submodule', dir => {
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Sub', version: '1.0.0' }));
        });
        const head = git(submoduleWork, 'rev-parse', 'HEAD');
        git(submoduleWork, 'update-index', '--add', '--cacheinfo', `160000,${head},nested`);
        git(submoduleWork, 'commit', '-q', '-m', 'add gitlink');
        fs.rmSync(path.join(root, 'served', 'submodule.git'), { recursive: true, force: true });
        git(path.join(root, 'served'), 'clone', '-q', '--bare', submoduleWork, 'submodule.git');
        server = await startGitHttpServer(path.join(root, 'served'));
    });

    after(async () => {
        await server?.close();
        if (root) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('system Git connects to the pinned address, not a fresh DNS answer', async () => {
        const destination = path.join(root, 'pinned-clone');
        // git-pin.invalid never resolves, so the clone only works through http.curloptResolve.
        const pinnedGit = gitClient.createSafeSimpleGit(root, { resolve: `git-pin.invalid:${server.port}:127.0.0.1` });
        await pinnedGit.clone(`http://git-pin.invalid:${server.port}/safe.git`, destination);
        assert.equal(fs.readFileSync(path.join(destination, 'index.js'), 'utf8'), 'export const safe = true;\n');
        assert.ok(server.requests.some(request => request.host === `git-pin.invalid:${server.port}`));

        const unpinnedGit = gitClient.createSafeSimpleGit(root);
        await assert.rejects(unpinnedGit.clone(`http://git-pin.invalid:${server.port}/safe.git`, path.join(root, 'unpinned-clone')));
    });

    test('system Git refuses redirects and local or SSH transports', async () => {
        const safeGit = gitClient.createSafeSimpleGit(root);
        const before = server.requests.length;
        await assert.rejects(safeGit.clone(`${`http://127.0.0.1:${server.port}`}/redirect/safe.git`, path.join(root, 'redirect-clone')));
        const followed = server.requests.slice(before).filter(request => !request.path.startsWith('/redirect/'));
        assert.deepEqual(followed, [], 'Git must not follow the redirect');
        assert.equal(fs.existsSync(path.join(root, 'redirect-clone', 'index.js')), false);

        await assert.rejects(safeGit.clone(path.join(root, 'served', 'safe.git'), path.join(root, 'file-clone')), /transport 'file' not allowed/);
        await assert.rejects(safeGit.clone('ssh://git@127.0.0.1:9/repo.git', path.join(root, 'ssh-clone')), /transport 'ssh' not allowed/);
    });

    test('system backend clone validates the remote first', async () => {
        const client = gitClient.createGitClient({ backend: 'system' });
        const blocked = path.join(root, 'system-blocked');
        await assert.rejects(client.clone(server.url('safe'), blocked, { depth: 1, remotePolicy: { allowPrivate: false } }), error => error.status === 403);
        assert.equal(fs.existsSync(blocked), false);

        const allowed = path.join(root, 'system-allowed');
        await client.clone(server.url('safe'), allowed, { depth: 1, remotePolicy: { allowPrivate: true } });
        assert.equal(fs.readFileSync(path.join(allowed, 'lib', 'util.js'), 'utf8'), 'export {};\n');
    });

    test('built-in backend clones through the validated HTTP client and checks out files', async () => {
        const client = gitClient.createGitClient({ backend: 'builtin' });
        const destination = path.join(root, 'builtin-safe');
        await client.clone(server.url('safe'), destination, { depth: 1, remotePolicy: { allowPrivate: true } });
        assert.equal(fs.readFileSync(path.join(destination, 'index.js'), 'utf8'), 'export const safe = true;\n');
        assert.equal(fs.readFileSync(path.join(destination, 'lib', 'util.js'), 'utf8'), 'export {};\n');

        const blocked = path.join(root, 'builtin-blocked');
        await assert.rejects(client.clone(server.url('safe'), blocked, { depth: 1, remotePolicy: { allowPrivate: false } }), error => error.status === 403);
        assert.equal(fs.existsSync(blocked), false);
    });

    test('built-in backend refuses redirects', async () => {
        const client = gitClient.createGitClient({ backend: 'builtin' });
        const destination = path.join(root, 'builtin-redirect');
        const before = server.requests.length;
        await assert.rejects(client.clone(`http://127.0.0.1:${server.port}/redirect/safe.git`, destination, { depth: 1, remotePolicy: { allowPrivate: true } }));
        const followed = server.requests.slice(before).filter(request => !request.path.startsWith('/redirect/'));
        assert.deepEqual(followed, []);
        assert.equal(fs.existsSync(destination), false);
    });

    test('built-in backend rejects symbolic links and submodules before writing any file', async () => {
        const client = gitClient.createGitClient({ backend: 'builtin' });
        const symlinkDestination = path.join(root, 'builtin-symlink');
        await assert.rejects(
            client.clone(server.url('symlink'), symlinkDestination, { depth: 1, remotePolicy: { allowPrivate: true } }),
            /symbolic link: escape\.json/,
        );
        assert.equal(fs.existsSync(symlinkDestination), false);

        const submoduleDestination = path.join(root, 'builtin-submodule');
        await assert.rejects(
            client.clone(server.url('submodule'), submoduleDestination, { depth: 1, remotePolicy: { allowPrivate: true } }),
            /submodule: nested/,
        );
        assert.equal(fs.existsSync(submoduleDestination), false);
    });
});

describe('extension routes only run Git on the extension\'s own repository', () => {
    let root;
    let server;
    let userExtensions;
    const originalGlobalExtensions = PUBLIC_DIRECTORIES.globalExtensions;
    const admin = () => ({ profile: { handle: 'admin', admin: true }, directories: { extensions: userExtensions } });
    const member = () => ({ profile: { handle: 'member', admin: false }, directories: { extensions: userExtensions } });

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-git-routes-'));
        fs.mkdirSync(path.join(root, 'served'), { recursive: true });
        publishRepo(root, 'upstream', dir => {
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Upstream', version: '1.0.0' }));
            fs.writeFileSync(path.join(dir, 'index.js'), 'export const v = 1;\n');
        });
        server = await startGitHttpServer(path.join(root, 'served'));

        // The user extensions folder lives inside a parent repository whose origin is a canary.
        const parent = path.join(root, 'parent');
        fs.mkdirSync(parent, { recursive: true });
        git(parent, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(parent, 'README.md'), 'parent\n');
        git(parent, 'add', '-A');
        git(parent, 'commit', '-q', '-m', 'parent');
        git(parent, 'remote', 'add', 'origin', `http://127.0.0.1:${server.port}/parent-canary.git`);
        userExtensions = path.join(parent, 'extensions');
        fs.mkdirSync(userExtensions, { recursive: true });
        PUBLIC_DIRECTORIES.globalExtensions = path.join(root, 'global');
        fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions, { recursive: true });

        // Plain folder: Git discovery would climb to the parent repository.
        const plain = path.join(userExtensions, 'Plain');
        fs.mkdirSync(plain);
        fs.writeFileSync(path.join(plain, 'manifest.json'), JSON.stringify({ display_name: 'Plain' }));

        // Bare repository layout directly in the folder (checkIsRepo used to accept it).
        const bare = path.join(userExtensions, 'Bare');
        fs.mkdirSync(bare);
        git(bare, 'init', '-q', '--bare');
        git(bare, 'config', 'remote.origin.url', `http://127.0.0.1:${server.port}/bare-canary.git`);

        // .git as a symbolic link to another repository.
        const linked = path.join(userExtensions, 'Linked');
        fs.mkdirSync(linked);
        fs.symlinkSync(path.join(parent, '.git'), path.join(linked, '.git'));

        // .git as a gitdir file pointing elsewhere.
        const gitFile = path.join(userExtensions, 'GitFile');
        fs.mkdirSync(gitFile);
        fs.writeFileSync(path.join(gitFile, '.git'), `gitdir: ${path.join(parent, '.git')}\n`);

        // Real repository whose origin is a local path.
        const localOrigin = path.join(userExtensions, 'LocalOrigin');
        git(userExtensions, 'clone', '-q', path.join(root, 'served', 'upstream.git'), 'LocalOrigin');
        assert.ok(fs.existsSync(path.join(localOrigin, '.git')));

        // Real repository with an HTTP origin served by the test server. Clone from disk: a
        // synchronous clone over HTTP would block the event loop that answers it.
        git(userExtensions, 'clone', '-q', path.join(root, 'served', 'upstream.git'), 'Served');
        git(path.join(userExtensions, 'Served'), 'remote', 'set-url', 'origin', server.url('upstream'));
    });

    after(async () => {
        PUBLIC_DIRECTORIES.globalExtensions = originalGlobalExtensions;
        await server?.close();
        if (root) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    function canaryRequests() {
        return server.requests.filter(request => request.path.includes('canary'));
    }

    test('folders without their own .git directory get 400 and Git never reaches a parent or bare repository', async () => {
        for (const extensionName of ['Plain', 'Bare']) {
            for (const route of ['/update', '/branches']) {
                const response = await callExtensions(route, admin(), { extensionName });
                assert.equal(response.status, 400, `${route} ${extensionName}: ${response.text}`);
                assert.equal(response.text, NOT_MANAGED);
            }
            const switched = await callExtensions('/switch', admin(), { extensionName, branch: 'main' });
            assert.equal(switched.status, 400, switched.text);
            assert.equal(switched.text, NOT_MANAGED);

            const version = await callExtensions('/version', admin(), { extensionName });
            assert.equal(version.status, 200);
            assert.deepEqual(version.json, { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        }
        assert.deepEqual(canaryRequests(), []);
        assert.equal(git(path.join(root, 'parent'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    });

    test('a .git symbolic link or gitdir file is refused as existing metadata', async () => {
        for (const extensionName of ['Linked', 'GitFile']) {
            for (const route of ['/update', '/branches', '/version']) {
                const response = await callExtensions(route, admin(), { extensionName });
                assert.equal(response.status, 400, `${route} ${extensionName}: ${response.text}`);
                assert.equal(response.text, EXISTING_METADATA);
            }
            const switched = await callExtensions('/switch', admin(), { extensionName, branch: 'main' });
            assert.equal(switched.status, 400);
        }
        assert.deepEqual(canaryRequests(), []);
    });

    test('a local-path origin is refused before any fetch', async () => {
        const update = await callExtensions('/update', admin(), { extensionName: 'LocalOrigin' });
        assert.equal(update.status, 400, update.text);
        const branches = await callExtensions('/branches', admin(), { extensionName: 'LocalOrigin' });
        assert.equal(branches.status, 400, branches.text);
    });

    test('a private HTTP origin needs an administrator; the pinned fetch then works', async () => {
        const blocked = await callExtensions('/branches', member(), { extensionName: 'Served' });
        assert.equal(blocked.status, 403, blocked.text);

        const before = server.requests.length;
        const branches = await callExtensions('/branches', admin(), { extensionName: 'Served' });
        assert.equal(branches.status, 200, branches.text);
        assert.ok(branches.json.some(branch => branch.name === 'main'));
        assert.ok(server.requests.length > before, 'The fetch reached the served repository');

        const version = await callExtensions('/version', admin(), { extensionName: 'Served' });
        assert.equal(version.status, 200, version.text);
        assert.equal(version.json.currentBranchName, 'main');
        assert.equal(version.json.isUpToDate, true);
        assert.equal(version.json.remoteUrl, server.url('upstream'));

        const update = await callExtensions('/update', admin(), { extensionName: 'Served' });
        assert.equal(update.status, 200, update.text);
        assert.equal(update.json.isUpToDate, true);
    });
});
