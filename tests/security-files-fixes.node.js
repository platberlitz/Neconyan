import { fixture, png } from './roleplay-transactions-fixture.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import express from 'express';
import '../src/fetch-patch.js';
const { PUBLIC_DIRECTORIES } = await import('../src/constants.js');
const { router: usersRouter } = await import('../src/users.js');
const { router: extensionsRouter } = await import('../src/endpoints/extensions.js');
const { router: serverAdminRouter } = await import('../src/endpoints/server-admin.js');
const { router: backgroundsRouter } = await import('../src/endpoints/backgrounds.js');
const { router: charactersRouter, diskCache: characterDiskCache } = await import('../src/endpoints/characters.js');
characterDiskCache.dispose();
const { router: filesRouter } = await import('../src/endpoints/files.js');
const { readMetadataIndex, writeMetadataIndex } = await import('../src/endpoints/image-metadata.js');
const { getFileNameValidationFunction } = await import('../src/middleware/validateFileName.js');

function invokeExpressRouter(router, method, url, reqOverrides = {}) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            Object.assign(req, reqOverrides);
            next();
        });
        app.use(router);
        const server = app.listen(0, '127.0.0.1', async () => {
            try {
                const { port } = server.address();
                const response = await fetch(`http://127.0.0.1:${port}${url}`, {
                    method,
                    headers: reqOverrides.body ? { 'Content-Type': 'application/json' } : {},
                    body: reqOverrides.body ? JSON.stringify(reqOverrides.body) : undefined,
                });
                const text = await response.text();
                let json;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: response.status, text, json, headers: response.headers });
            } catch (err) {
                reject(err);
            } finally {
                server.closeAllConnections();
                server.close();
            }
        });
    });
}

test('FN-HIGH-1: symlinked files inside extensions are blocked in static serving, manifest discovery, and git install/update/switch, while linked extension roots and dangling links are handled safely', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-fn-high-1-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const outsideSecret = path.join(root, 'outside-secret.json');
    fs.writeFileSync(outsideSecret, JSON.stringify({ display_name: 'LeakedSecret', version: '9.9.9', secret: 'top-secret' }));

    const userExtDir = path.join(root, 'user-extensions');
    const globalExtDir = path.join(root, 'global-extensions');
    const coreExtDir = path.join(root, 'core-extensions');
    fs.mkdirSync(userExtDir, { recursive: true });
    fs.mkdirSync(globalExtDir, { recursive: true });
    fs.mkdirSync(coreExtDir, { recursive: true });

    const originalPublic = { ...PUBLIC_DIRECTORIES };
    PUBLIC_DIRECTORIES.extensions = coreExtDir;
    PUBLIC_DIRECTORIES.globalExtensions = globalExtDir;
    t.after(() => Object.assign(PUBLIC_DIRECTORIES, originalPublic));

    // 1. User extension containing an internal symlink to an outside file
    const evilExt = path.join(userExtDir, 'EvilExt');
    fs.mkdirSync(evilExt, { recursive: true });
    fs.symlinkSync(outsideSecret, path.join(evilExt, 'manifest.json'));
    fs.symlinkSync(outsideSecret, path.join(evilExt, 'leak.json'));

    // 2. Administrator/developer deliberately symlinked whole extension root to an external repo checkout
    const externalCheckout = path.join(root, 'external-linked-repo');
    fs.mkdirSync(path.join(externalCheckout, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(externalCheckout, 'manifest.json'), JSON.stringify({ display_name: 'LinkedRepoExt', version: '1.2.3' }));
    fs.writeFileSync(path.join(externalCheckout, 'index.js'), 'export const linked = true;');
    fs.symlinkSync(outsideSecret, path.join(externalCheckout, 'sub/escape.json'));
    fs.symlinkSync(externalCheckout, path.join(userExtDir, 'LinkedRepoExt'));

    // 3. A dangling symlink in user extensions directory (must not 500 /discover!)
    fs.symlinkSync(path.join(root, 'non-existent-checkout'), path.join(userExtDir, 'DanglingExt'));

    const userContext = {
        profile: { handle: 'alice', admin: false },
        directories: {
            extensions: userExtDir,
            backgrounds: path.join(root, 'backgrounds'),
            characters: path.join(root, 'characters'),
            avatars: path.join(root, 'avatars'),
            assets: path.join(root, 'assets'),
            userImages: path.join(root, 'userImages'),
            files: path.join(root, 'files'),
        },
    };
    for (const dir of Object.values(userContext.directories)) fs.mkdirSync(dir, { recursive: true });

    // Discover with manifests=1:
    // - DanglingExt must not cause 500
    // - LinkedRepoExt must be discovered and its real manifest loaded
    // - EvilExt's symlinked manifest.json must NOT be read/returned
    const discoverRes = await invokeExpressRouter(extensionsRouter, 'GET', '/discover?manifests=1', { user: userContext });
    assert.equal(discoverRes.status, 200, `Expected 200 from /discover, got ${discoverRes.status}: ${discoverRes.text}`);
    const linkedEntry = discoverRes.json.find(e => e.name === 'third-party/LinkedRepoExt');
    assert.ok(linkedEntry, 'LinkedRepoExt should be discovered');
    assert.equal(linkedEntry.manifest?.display_name, 'LinkedRepoExt');
    const evilEntry = discoverRes.json.find(e => e.name === 'third-party/EvilExt');
    assert.equal(evilEntry?.manifest, undefined, 'Symlinked manifest.json inside EvilExt must not be read');

    // Static serving of extensions via usersRouter:
    // - Legitimate file inside LinkedRepoExt works (and has no sandbox CSP that breaks extension JS, or has nosniff)
    const legitExtJs = await invokeExpressRouter(usersRouter, 'GET', '/scripts/extensions/third-party/LinkedRepoExt/index.js', { user: userContext });
    assert.equal(legitExtJs.status, 200);
    assert.equal(legitExtJs.text, 'export const linked = true;');

    // - Symlink inside EvilExt pointing outside is rejected (403/404)
    const evilLeakRes = await invokeExpressRouter(usersRouter, 'GET', '/scripts/extensions/third-party/EvilExt/leak.json', { user: userContext });
    assert.ok([403, 404].includes(evilLeakRes.status), `Expected 403/404 for EvilExt/leak.json, got ${evilLeakRes.status}`);
    assert.equal(evilLeakRes.text.includes('top-secret'), false);

    // - Symlink inside LinkedRepoExt pointing outside LinkedRepoExt's realpath is rejected
    const linkedEscapeRes = await invokeExpressRouter(usersRouter, 'GET', '/scripts/extensions/third-party/LinkedRepoExt/sub/escape.json', { user: userContext });
    assert.ok([403, 404].includes(linkedEscapeRes.status), `Expected 403/404 for LinkedRepoExt/sub/escape.json, got ${linkedEscapeRes.status}`);
    assert.equal(linkedEscapeRes.text.includes('top-secret'), false);

    // Static serving of user media route with symlink pointing outside is rejected
    fs.symlinkSync(outsideSecret, path.join(userContext.directories.files, 'linked-secret.json'));
    const fileSymlinkRes = await invokeExpressRouter(usersRouter, 'GET', '/user/files/linked-secret.json', { user: userContext });
    assert.ok([403, 404].includes(fileSymlinkRes.status), `Expected 403/404 for symlinked user file, got ${fileSymlinkRes.status}`);
});

test('FN-HIGH-4: static user routes send sandbox CSP + nosniff, backgrounds validate media extensions and sanitize metadata rename, and BYAF validates image extensions and card folder name', async t => {
    const f = fixture(t, false, 'fn-high-4');
    const dirs = f.scope.directories;
    for (const key of ['backgrounds', 'avatars', 'assets', 'userImages', 'files', 'thumbnailsBg', 'thumbnailsBgMobile']) {
        dirs[key] = path.join(dirs.root, key);
        fs.mkdirSync(dirs[key], { recursive: true });
    }
    const user = { profile: { handle: f.scope.owner, admin: true }, directories: dirs };

    // 1. Static user route serves regular file with sandbox CSP + nosniff
    fs.writeFileSync(path.join(dirs.backgrounds, 'sunset.png'), png);
    const bgRes = await invokeExpressRouter(usersRouter, 'GET', '/backgrounds/sunset.png', { user });
    assert.equal(bgRes.status, 200);
    assert.equal(bgRes.headers.get('x-content-type-options'), 'nosniff');
    assert.match(String(bgRes.headers.get('content-security-policy')), /sandbox/);

    // 2. Backgrounds upload rejects .html and .svg, accepts .png
    const tmpUploadHtml = path.join(f.root, 'upload-html.tmp');
    fs.writeFileSync(tmpUploadHtml, '<script>alert(1)</script>');
    const uploadHtmlRes = await invokeExpressRouter(backgroundsRouter, 'POST', '/upload', {
        user,
        file: { destination: f.root, filename: 'upload-html.tmp', originalname: 'xss.html' },
        body: {},
    });
    assert.equal(uploadHtmlRes.status, 400);
    assert.equal(fs.existsSync(path.join(dirs.backgrounds, 'xss.html')), false);
    assert.equal(fs.existsSync(tmpUploadHtml), false, 'Temp upload must be cleaned up on rejection');

    const tmpUploadSvg = path.join(f.root, 'upload-svg.tmp');
    fs.writeFileSync(tmpUploadSvg, '<svg onload="alert(1)"></svg>');
    const uploadSvgRes = await invokeExpressRouter(backgroundsRouter, 'POST', '/upload', {
        user,
        file: { destination: f.root, filename: 'upload-svg.tmp', originalname: 'xss.svg' },
        body: {},
    });
    assert.equal(uploadSvgRes.status, 400);
    assert.equal(fs.existsSync(path.join(dirs.backgrounds, 'xss.svg')), false);

    // 3. Backgrounds rename rejects .html/.svg and uses sanitized names for renameMetadata
    const renameHtmlRes = await invokeExpressRouter(backgroundsRouter, 'POST', '/rename', {
        user,
        body: { old_bg: 'sunset.png', new_bg: 'sunset.html' },
    });
    assert.equal(renameHtmlRes.status, 400);
    assert.equal(fs.existsSync(path.join(dirs.backgrounds, 'sunset.png')), true);
    assert.equal(fs.existsSync(path.join(dirs.backgrounds, 'sunset.html')), false);

    // Verify metadata key is updated with sanitized name even if input had path separator
    await writeMetadataIndex(dirs.root, { version: 1, images: { 'backgrounds/sunset.png': { isAnimated: false, folderIds: ['f1'] } }, folders: [] });
    const renameTraverseRes = await invokeExpressRouter(backgroundsRouter, 'POST', '/rename', {
        user,
        body: { old_bg: '/sunset.png', new_bg: '/sunrise.png' },
    });
    assert.equal(renameTraverseRes.status, 200);
    const index = await readMetadataIndex(dirs.root);
    assert.ok(index.images['backgrounds/sunrise.png'], 'Metadata index must be updated under backgrounds/sunrise.png');
    assert.equal(index.images['/sunrise.png'], undefined, 'Metadata index must never use raw unsanitized new_bg path');

    // 4. BYAF import with .html/.svg background or alternate icon extension and empty sanitized card.name
    const byafZip = path.join(f.root, 'crafted.byaf');
    const out = fs.createWriteStream(byafZip);
    const done = finished(out);
    const archive = archiver('zip');
    archive.pipe(out);
    archive.append(JSON.stringify({ characters: ['char.json'], scenarios: ['scen.json'] }), { name: 'manifest.json' });
    archive.append(JSON.stringify({
        name: '...',
        displayName: 'SafeDisplay',
        persona: 'BYAF persona',
        images: [
            { path: 'main.png', label: 'main' },
            { path: 'evil-icon.html', label: 'evil' },
        ],
    }), { name: 'char.json' });
    archive.append(JSON.stringify({
        title: 'Scenario 1',
        backgroundImage: 'bg-evil.svg',
        firstMessages: [{ text: 'Hello' }],
        messages: [],
    }), { name: 'scen.json' });
    archive.append(png, { name: 'main.png' });
    archive.append(Buffer.from('<script>alert(1)</script>'), { name: 'evil-icon.html' });
    archive.append(Buffer.from('<svg onload=alert(1)>'), { name: 'bg-evil.svg' });
    await archive.finalize();
    await done;

    const byafRes = await invokeExpressRouter(charactersRouter, 'POST', '/import', {
        user,
        file: { destination: f.root, filename: 'crafted.byaf', originalname: 'crafted.byaf' },
        body: { file_type: 'byaf', user_name: 'User' },
    });
    assert.equal(byafRes.status, 200);
    // Neither characters/ nor user/images/ may contain .html or .svg files
    const walkFiles = dir => fs.existsSync(dir)
        ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])
        : [];
    const allWritten = [...walkFiles(dirs.characters), ...walkFiles(dirs.userImages)];
    assert.equal(allWritten.some(file => file.endsWith('.html') || file.endsWith('.svg')), false, `Unexpected dangerous file written: ${allWritten.join(', ')}`);
    // Alternate icon must not be written directly into top-level characters/ root
    const topLevelNonPng = fs.readdirSync(dirs.characters, { withFileTypes: true })
        .filter(e => e.isFile() && !e.name.endsWith('.png'))
        .map(e => e.name);
    assert.deepEqual(topLevelNonPng, []);
});

test('FN-MEDIUM-2: extension install/switch and server-admin switch-branch reject flag injection and unverified remote branches', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-fn-medium-2-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const userExtDir = path.join(root, 'user-ext');
    const globalExtDir = path.join(root, 'global-ext');
    fs.mkdirSync(userExtDir, { recursive: true });
    fs.mkdirSync(globalExtDir, { recursive: true });

    const originalPublic = { ...PUBLIC_DIRECTORIES };
    PUBLIC_DIRECTORIES.globalExtensions = globalExtDir;
    t.after(() => Object.assign(PUBLIC_DIRECTORIES, originalPublic));

    // Create a real local git repo inside userExtDir/TestExt
    const extRepo = path.join(userExtDir, 'TestExt');
    fs.mkdirSync(extRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: extRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: extRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: extRepo });
    fs.writeFileSync(path.join(extRepo, 'manifest.json'), JSON.stringify({ display_name: 'TestExt', version: '1.0.0' }));
    execFileSync('git', ['add', '.'], { cwd: extRepo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: extRepo });

    const user = { profile: { handle: 'alice', admin: true }, directories: { extensions: userExtDir } };

    // 1. /api/extensions/install with non-string or flag-like branch is rejected with 400
    for (const badBranch of ['-u', '--upload-pack=touch', 'origin/-flag', ['array'], { obj: 1 }]) {
        const res = await invokeExpressRouter(extensionsRouter, 'POST', '/install', {
            user,
            body: { url: 'http://127.0.0.1:9/repo.git', branch: badBranch },
        });
        assert.equal(res.status, 400, `Expected 400 for install branch=${JSON.stringify(badBranch)}, got ${res.status}`);
    }

    // 1b. /api/extensions/install blocks private/loopback URLs for non-admin users via validateOutboundTarget
    const nonAdminUser = { profile: { handle: 'bob', admin: false }, directories: { extensions: userExtDir } };
    for (const privateUrl of ['http://127.0.0.1:9/repo.git', 'http://localhost:9/repo.git', 'http://[::ffff:127.0.0.1]:9/repo.git']) {
        const res = await invokeExpressRouter(extensionsRouter, 'POST', '/install', {
            user: nonAdminUser,
            body: { url: privateUrl },
        });
        assert.equal(res.status, 403, `Expected 403 for non-admin private URL ${privateUrl}, got ${res.status}`);
    }

    // 2. /api/extensions/switch with origin/--... or unverified remote branch or non-string branch is rejected with 400/404
    for (const badBranch of ['origin/--orphan', 'origin/-B', '--detach', ['main']]) {
        const res = await invokeExpressRouter(extensionsRouter, 'POST', '/switch', {
            user,
            body: { extensionName: 'TestExt', branch: badBranch },
        });
        assert.equal(res.status, 400, `Expected 400 for switch branch=${JSON.stringify(badBranch)}, got ${res.status}`);
    }
    const missingRemoteRes = await invokeExpressRouter(extensionsRouter, 'POST', '/switch', {
        user,
        body: { extensionName: 'TestExt', branch: 'origin/nonexistent-branch' },
    });
    assert.equal(missingRemoteRes.status, 404);

    // 2b. /api/extensions/switch rejects switching to a branch whose working tree contains a symlink,
    // restores attached symbolic branch (or detached HEAD state), and cleans up newly created remote-tracking branches.
    const upstreamRepo = path.join(root, 'upstream-repo');
    fs.mkdirSync(upstreamRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: upstreamRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: upstreamRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: upstreamRepo });
    fs.writeFileSync(path.join(upstreamRepo, 'manifest.json'), JSON.stringify({ display_name: 'TestExt', version: '1.0.0' }));
    fs.writeFileSync(path.join(upstreamRepo, 'index.js'), 'export const v = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: upstreamRepo });
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: upstreamRepo });
    const safeMainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRepo }).toString().trim();

    execFileSync('git', ['checkout', '-b', 'remote-evil'], { cwd: upstreamRepo });
    fs.symlinkSync(path.join(upstreamRepo, 'manifest.json'), path.join(upstreamRepo, 'remote-linked.json'));
    execFileSync('git', ['add', 'remote-linked.json'], { cwd: upstreamRepo });
    execFileSync('git', ['commit', '-m', 'remote evil symlink'], { cwd: upstreamRepo });
    execFileSync('git', ['checkout', 'main'], { cwd: upstreamRepo });

    execFileSync('git', ['remote', 'add', 'origin', upstreamRepo], { cwd: extRepo });
    execFileSync('git', ['fetch', 'origin'], { cwd: extRepo });
    execFileSync('git', ['reset', '--hard', 'origin/main'], { cwd: extRepo });
    execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: extRepo });

    execFileSync('git', ['checkout', '-b', 'symlink-branch'], { cwd: extRepo });
    fs.symlinkSync(path.join(extRepo, 'manifest.json'), path.join(extRepo, 'linked.json'));
    execFileSync('git', ['add', 'linked.json'], { cwd: extRepo });
    execFileSync('git', ['commit', '-m', 'add symlink'], { cwd: extRepo });
    execFileSync('git', ['checkout', 'main'], { cwd: extRepo });

    // Local branch switch rejection keeps 'main' attached and removes the symlink
    const symlinkSwitchRes = await invokeExpressRouter(extensionsRouter, 'POST', '/switch', {
        user,
        body: { extensionName: 'TestExt', branch: 'symlink-branch' },
    });
    assert.equal(symlinkSwitchRes.status, 500);
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: extRepo }).toString().trim(), 'main');
    assert.equal(fs.lstatSync(path.join(extRepo, 'linked.json'), { throwIfNoEntry: false }), undefined);

    // Remote origin/* branch switch rejection deletes the newly created local branch and keeps 'main' attached
    const remoteSwitchRes = await invokeExpressRouter(extensionsRouter, 'POST', '/switch', {
        user,
        body: { extensionName: 'TestExt', branch: 'origin/remote-evil' },
    });
    assert.equal(remoteSwitchRes.status, 500);
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: extRepo }).toString().trim(), 'main');
    assert.equal(fs.lstatSync(path.join(extRepo, 'remote-linked.json'), { throwIfNoEntry: false }), undefined);
    const localBranchesAfter = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: extRepo }).toString().trim().split(/\s+/);
    assert.equal(localBranchesAfter.includes('remote-evil'), false, 'Newly created unsafe local branch must be deleted on rollback');

    // Detached HEAD state before a rejected switch stays detached at the exact commit
    execFileSync('git', ['checkout', '--detach', safeMainSha], { cwd: extRepo });
    const detachedSwitchRes = await invokeExpressRouter(extensionsRouter, 'POST', '/switch', {
        user,
        body: { extensionName: 'TestExt', branch: 'symlink-branch' },
    });
    assert.equal(detachedSwitchRes.status, 500);
    assert.throws(() => execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: extRepo }));
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extRepo }).toString().trim(), safeMainSha);
    assert.equal(fs.lstatSync(path.join(extRepo, 'linked.json'), { throwIfNoEntry: false }), undefined);
    execFileSync('git', ['checkout', 'main'], { cwd: extRepo });

    // 2c. /api/extensions/update rolls back unsafe pulled commit while preserving unrelated stash, tracked dirty edits, and untracked files
    // Create an older unrelated stash entry first
    fs.writeFileSync(path.join(extRepo, 'index.js'), 'export const v = "older-unrelated-stash";\n');
    execFileSync('git', ['stash', 'push', '-m', 'unrelated user stash'], { cwd: extRepo });
    const unrelatedStashSha = execFileSync('git', ['rev-parse', 'refs/stash'], { cwd: extRepo }).toString().trim();

    // Advance upstream origin/main with a commit that introduces a symlink (leaving index.js untouched so --keep works with dirty index.js)
    fs.symlinkSync(path.join(upstreamRepo, 'manifest.json'), path.join(upstreamRepo, 'pulled-symlink.json'));
    execFileSync('git', ['add', 'pulled-symlink.json'], { cwd: upstreamRepo });
    execFileSync('git', ['commit', '-m', 'upstream symlink commit'], { cwd: upstreamRepo });

    // Case A: autoStashBeforePull is false (default), repo has dirty tracked edit + untracked file
    fs.writeFileSync(path.join(extRepo, 'index.js'), 'export const v = "user-dirty-tracked";\n');
    fs.writeFileSync(path.join(extRepo, 'untracked-user-notes.txt'), 'keep my untracked notes');

    const unsafeUpdateRes = await invokeExpressRouter(extensionsRouter, 'POST', '/update', {
        user,
        body: { extensionName: 'TestExt' },
    });
    assert.equal(unsafeUpdateRes.status, 500);
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: extRepo }).toString().trim(), 'main');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extRepo }).toString().trim(), safeMainSha, 'HEAD must roll back to pre-pull commit');
    assert.equal(fs.lstatSync(path.join(extRepo, 'pulled-symlink.json'), { throwIfNoEntry: false }), undefined, 'Pulled symlink must be removed on rollback');
    assert.equal(fs.readFileSync(path.join(extRepo, 'index.js'), 'utf8'), 'export const v = "user-dirty-tracked";\n', 'Dirty tracked file must be preserved');
    assert.equal(fs.readFileSync(path.join(extRepo, 'untracked-user-notes.txt'), 'utf8'), 'keep my untracked notes', 'Untracked file must be preserved');
    assert.equal(execFileSync('git', ['rev-parse', 'refs/stash'], { cwd: extRepo }).toString().trim(), unrelatedStashSha, 'Unrelated user stash must not be popped');

    // Case B: autoStashBeforePull is enabled (via SILLYTAVERN_AUTOSTASHBEFOREPULL=true), stashes and restores only owned stash on rollback
    process.env.SILLYTAVERN_AUTOSTASHBEFOREPULL = 'true';
    try {
        const unsafeStashUpdateRes = await invokeExpressRouter(extensionsRouter, 'POST', '/update', {
            user,
            body: { extensionName: 'TestExt' },
        });
        assert.equal(unsafeStashUpdateRes.status, 500);
        assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: extRepo }).toString().trim(), 'main');
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extRepo }).toString().trim(), safeMainSha);
        assert.equal(fs.lstatSync(path.join(extRepo, 'pulled-symlink.json'), { throwIfNoEntry: false }), undefined);
        assert.equal(fs.readFileSync(path.join(extRepo, 'index.js'), 'utf8'), 'export const v = "user-dirty-tracked";\n', 'Auto-stashed tracked edit must be restored on rollback');
        assert.equal(fs.readFileSync(path.join(extRepo, 'untracked-user-notes.txt'), 'utf8'), 'keep my untracked notes');
        assert.equal(execFileSync('git', ['rev-parse', 'refs/stash'], { cwd: extRepo }).toString().trim(), unrelatedStashSha, 'Earlier unrelated stash must remain intact on top of stash stack');
    } finally {
        delete process.env.SILLYTAVERN_AUTOSTASHBEFOREPULL;
    }

    // Case C: Force reset --keep failure on rollback (via a real Git post-merge hook that dirties the pulled file
    // right before assertSafeExtensionTree runs): prove no destructive git checkout -f runs, no edits are lost,
    // HEAD remains attached to main, stashes are preserved, and any symlink remains unserved (403).
    const hooksDir = path.join(extRepo, '.git/hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const postMergeHook = path.join(hooksDir, 'post-merge');
    fs.writeFileSync(postMergeHook, '#!/usr/bin/env bash\nrm -f pulled-symlink.json\nln -s manifest.json pulled-symlink.json\nprintf "modified-link-target" > pulled-symlink.json.tmp && mv pulled-symlink.json.tmp pulled-symlink.json\nln -s manifest.json extra-symlink.json\n', { mode: 0o755 });
    process.env.SILLYTAVERN_AUTOSTASHBEFOREPULL = 'true';
    let keepRefusedRes;
    try {
        keepRefusedRes = await invokeExpressRouter(extensionsRouter, 'POST', '/update', {
            user,
            body: { extensionName: 'TestExt', global: false },
        });
    } finally {
        delete process.env.SILLYTAVERN_AUTOSTASHBEFOREPULL;
        fs.rmSync(postMergeHook, { force: true });
    }
    assert.equal(keepRefusedRes.status, 500);
    assert.match(keepRefusedRes.text, /Could not safely roll back the rejected extension update without overwriting local changes/);
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: extRepo }).toString().trim(), 'main', 'HEAD must stay attached to main (never detached by checkout -f)');
    assert.equal(fs.readFileSync(path.join(extRepo, 'pulled-symlink.json'), 'utf8'), 'modified-link-target', 'Dirty working-tree file that caused reset --keep to refuse must not be overwritten');
    assert.equal(fs.readFileSync(path.join(extRepo, 'untracked-user-notes.txt'), 'utf8'), 'keep my untracked notes', 'Untracked files must not be removed');
    const stashList = execFileSync('git', ['stash', 'list'], { cwd: extRepo }).toString().trim().split('\n');
    assert.equal(stashList.length, 2, 'Both the owned auto-stash and the older unrelated user stash must be preserved when rollback refuses');
    assert.equal(execFileSync('git', ['rev-parse', 'refs/stash@{1}'], { cwd: extRepo }).toString().trim(), unrelatedStashSha, 'Unrelated user stash must remain untouched');
    // Verify static serving still blocks the symlink in the tree with 403
    const blockedExtraLink = await invokeExpressRouter(usersRouter, 'GET', '/scripts/extensions/third-party/TestExt/extra-symlink.json', { user });
    assert.equal(blockedExtraLink.status, 403);

    // 3. /api/server-admin/switch-branch with leading dash flag is rejected with 400 before running git
    for (const badBranch of ['--detach', '-f', '-B']) {
        const res = await invokeExpressRouter(serverAdminRouter, 'POST', '/switch-branch', {
            user,
            body: { branch: badBranch },
        });
        assert.equal(res.status, 400, `Expected 400 for server-admin switch-branch=${badBranch}, got ${res.status}`);
    }
});

test('FN-LOW-1: /api/files/delete and /verify reject sibling prefix escapes, and validateFileName rejects non-strings, dot segments, and path traversal', async t => {
    const f = fixture(t, false, 'fn-low-1');
    const dirs = f.scope.directories;
    dirs.files = path.join(dirs.root, 'user/files');
    fs.mkdirSync(dirs.files, { recursive: true });

    const siblingDir = path.join(dirs.root, 'user/files-sibling');
    fs.mkdirSync(siblingDir, { recursive: true });
    const siblingFile = path.join(siblingDir, 'secret.txt');
    fs.writeFileSync(siblingFile, 'do not delete or verify');

    const user = { profile: { handle: f.scope.owner, admin: false }, directories: dirs };

    // 1. /api/files/delete must reject user/files-sibling/secret.txt with 400
    const delRes = await invokeExpressRouter(filesRouter, 'POST', '/delete', {
        user,
        body: { path: 'user/files-sibling/secret.txt' },
    });
    assert.equal(delRes.status, 400);
    assert.equal(fs.existsSync(siblingFile), true);

    // 2. /api/files/verify must ignore user/files-sibling/secret.txt
    const verRes = await invokeExpressRouter(filesRouter, 'POST', '/verify', {
        user,
        body: { urls: ['user/files-sibling/secret.txt'] },
    });
    assert.equal(verRes.status, 200);
    assert.equal(verRes.json['user/files-sibling/secret.txt'], undefined);

    // 3. validateFileName middleware rejects { toString: null }, ['array'], '.', '..', and 'a/b'
    const validator = getFileNameValidationFunction('file_name');
    for (const badValue of [{ toString: null }, ['array'], '.', '..', 'a/b', 'a\\b', 'bad\0name']) {
        let status = 200;
        let nextCalled = false;
        validator(
            { body: { file_name: badValue }, user, originalUrl: '/test' },
            { sendStatus(code) { status = code; return this; } },
            () => { nextCalled = true; },
        );
        assert.equal(status, 400, `Expected 400 for validateFileName(${JSON.stringify(badValue)})`);
        assert.equal(nextCalled, false);
    }
});
