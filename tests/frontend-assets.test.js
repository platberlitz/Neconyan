import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    FRONTEND_ASSET_PREFIX,
    HASHED_FRONTEND_ASSET_RE,
    buildPublicModuleImportMap,
    clearFrontendManifestCache,
    clearPublicModuleImportMapCache,
    getFrontendManifestPath,
    readRewrittenFrontendHtml,
    rewriteFrontendHtml,
    validateBundledFrontend,
} from '../src/frontend-assets.js';
import { redirectLegacyFrontendAsset } from '../src/middleware/frontend-assets.js';

describe('frontend asset manifest rewriting', () => {
    const manifestPath = getFrontendManifestPath();
    const manifestDirectory = path.dirname(manifestPath);
    let previousManifest = null;

    beforeEach(() => {
        previousManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
        fs.mkdirSync(manifestDirectory, { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify({
            assets: {
                'style.css': { output: 'style-abc123.css' },
                'css/neconyan-mobile-shell.css': { output: 'css/neconyan-mobile-shell-def456.css' },
                'webfonts/FredokaOne/stylesheet.css': { output: 'webfonts/FredokaOne/stylesheet-789abc.css' },
                'webfonts/FredokaOne/FredokaOne-Regular.ttf': { output: 'webfonts/FredokaOne/FredokaOne-Regular-789abc.ttf' },
                'webfonts/Nunito/stylesheet.css': { output: 'webfonts/Nunito/stylesheet-789abc.css' },
                'webfonts/Nunito/Nunito[wght].woff2': { output: 'webfonts/Nunito/Nunito[wght]-789abc.woff2' },
                'webfonts/Figtree/Figtree-Regular.woff2': { output: 'webfonts/Figtree/Figtree-Regular-789abc.woff2' },
                'webfonts/Figtree/stylesheet.css': { output: 'webfonts/Figtree/stylesheet-789abc.css' },
                'script.js': { output: 'script-deadbeef.js' },
                'scripts/performance-loader.js': { output: 'scripts/performance-loader-deadbeef.js' },
                'scripts/neconyan-tabs.js': { output: 'scripts/neconyan-tabs-deadbeef.js' },
            },
        }), 'utf8');
        clearFrontendManifestCache();
    });

    afterEach(() => {
        if (previousManifest === null) {
            fs.rmSync(manifestPath, { force: true });
        } else {
            fs.writeFileSync(manifestPath, previousManifest, 'utf8');
        }
        clearFrontendManifestCache();
    });

    test('leaves HTML unchanged when the frontend build is disabled', () => {
        const html = '<link href="style.css"><script type="module" src="script.js"></script>';
        expect(rewriteFrontendHtml(html, { enabled: false })).toBe(html);
    });

    test('rewrites built styles and fonts without moving boot modules', () => {
        const html = [
            '<link href="style.css?v=old">',
            '<link href="css/neconyan-mobile-shell.css?v=old">',
            '<link href="webfonts/FredokaOne/stylesheet.css?v=old">',
            '<link rel="preload" as="font" href="webfonts/FredokaOne/FredokaOne-Regular.ttf?v=old">',
            '<link href="webfonts/Nunito/stylesheet.css?v=old">',
            '<link href="webfonts/Nunito/Nunito[wght].woff2?v=old">',
            '<link href="webfonts/Figtree/Figtree-Regular.woff2?v=old">',
            '<link href="webfonts/Figtree/stylesheet.css?v=old">',
            '<script type="module" src="scripts/performance-loader.js"></script>',
            '<script type="module" src="script.js?v=old"></script>',
            '<script type="module" src="scripts/neconyan-tabs.js?v=old"></script>',
        ].join('');

        const rewritten = rewriteFrontendHtml(html, { enabled: true });

        expect(rewritten).toContain('href="/frontend-assets/style-abc123.css"');
        expect(rewritten).toContain('href="/frontend-assets/css/neconyan-mobile-shell-def456.css"');
        expect(rewritten).toContain('href="/frontend-assets/webfonts/FredokaOne/stylesheet-789abc.css"');
        expect(rewritten).toContain('href="webfonts/FredokaOne/FredokaOne-Regular.ttf?v=old"');
        expect(rewritten).toContain('href="/frontend-assets/webfonts/Nunito/stylesheet-789abc.css"');
        expect(rewritten).toContain('href="webfonts/Nunito/Nunito[wght].woff2?v=old"');
        expect(rewritten).toContain('href="/frontend-assets/webfonts/Figtree/Figtree-Regular-789abc.woff2"');
        expect(rewritten).toContain('href="/frontend-assets/webfonts/Figtree/stylesheet-789abc.css"');
        expect(rewritten).toContain('src="scripts/performance-loader.js"');
        expect(rewritten).toContain('src="script.js?v=old"');
        expect(rewritten).toContain('src="scripts/neconyan-tabs.js?v=old"');
        expect(rewritten).not.toContain('/frontend-assets/script-deadbeef.js');
        expect(rewritten).not.toContain('/frontend-assets/scripts/performance-loader-deadbeef.js');
        expect(rewritten).not.toContain('/frontend-assets/scripts/neconyan-tabs-deadbeef.js');
    });

    test('reuses the rewritten home page until the file changes', () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-index-'));
        const indexPath = path.join(work, 'index.html');
        try {
            fs.writeFileSync(indexPath, '<link href="style.css?v=1">', 'utf8');
            const first = readRewrittenFrontendHtml(indexPath, { enabled: true });
            expect(first).toContain('href="/frontend-assets/style-abc123.css"');
            expect(readRewrittenFrontendHtml(indexPath, { enabled: true })).toBe(first);
            fs.writeFileSync(indexPath, '<link href="style.css?v=2"><p>second</p>', 'utf8');
            const changed = readRewrittenFrontendHtml(indexPath, { enabled: true });
            expect(changed).toContain('<p>second</p>');
            expect(changed).not.toBe(first);
        } finally {
            fs.rmSync(work, { force: true, recursive: true });
        }
    });

    test('stamps every module through one import map so its identity stays single', () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-modules-'));
        try {
            fs.mkdirSync(path.join(work, 'scripts'));
            fs.writeFileSync(path.join(work, 'lib.js'), 'export const lib = 1;');
            fs.writeFileSync(path.join(work, 'script.js'), 'export const app = 1;');
            fs.writeFileSync(path.join(work, 'scripts', 'tabs.js'), "import '../script.js';");
            const map = buildPublicModuleImportMap(work);
            const html = [
                '<script type="importmap">{ "imports": { "#macro-vendor": "./lib.js" } }</script>',
                '<link rel="modulepreload" href="script.js">',
                '<script type="module" src="script.js"></script>',
                '<script type="module" src="scripts/tabs.js"></script>',
            ].join('');
            const rewritten = rewriteFrontendHtml(html, { enabled: true, importMap: map });
            const served = JSON.parse(rewritten.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
            expect(map['/script.js']).toMatch(/^\/script\.js\?v=/);
            expect(rewritten).toContain(`href="${map['/script.js']}"`);
            expect(rewritten).toContain(`src="${map['/script.js']}"`);
            expect(rewritten).toContain(`src="${map['/scripts/tabs.js']}"`);
            expect(served.imports['/script.js']).toBe(map['/script.js']);
            expect(served.imports['#macro-vendor']).toBe(map['/lib.js']);
        } finally {
            fs.rmSync(work, { force: true, recursive: true });
            clearPublicModuleImportMapCache();
        }
    });

    test('keeps the immutable asset prefix stable for production serving', () => {
        expect(FRONTEND_ASSET_PREFIX).toBe('/frontend-assets/');
    });

    test('redirects legacy extension paths without dropping query strings', () => {
        const redirects = [];
        const next = () => redirects.push('next');
        const legacyPath = '/scripts/extensions/third-party/BunnyPresetTools/index.js';
        redirectLegacyFrontendAsset({ method: 'GET', path: legacyPath, url: `${legacyPath}?v=old` }, {
            redirect: (status, target) => redirects.push([status, target]),
        }, next);
        expect(redirects).toEqual([[307, '/scripts/extensions/third-party/Neconyan-Preset-Tools/index.js?v=old']]);

        redirectLegacyFrontendAsset({ method: 'POST', path: legacyPath, url: legacyPath }, {}, next);
        expect(redirects.at(-1)).toBe('next');
    });

    // The 'loads the main app module through a versioned URL' test was removed:
    // it pinned the regression that double-evaluated script.js (module identity
    // splits when the tag URL carries ?v= but bare '../script.js' imports do not).
    // tests/script-module-identity.test.js owns the corrected invariant.
    test('only treats fingerprinted frontend asset names as immutable', () => {
        expect(HASHED_FRONTEND_ASSET_RE.test('script-0123456789ab.js')).toBe(true);
        expect(HASHED_FRONTEND_ASSET_RE.test('scripts/extensions-abcdef123456.js')).toBe(true);
        expect(HASHED_FRONTEND_ASSET_RE.test('script.js')).toBe(false);
        expect(HASHED_FRONTEND_ASSET_RE.test('scripts/extensions.js')).toBe(false);
    });
});

test('native startup requires both compiled bundles at their regular and immutable URLs', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-bundles-'));
    const assets = {
        'lib.js': { output: 'lib-0123456789ab.js', bytes: 10 },
        'notes-editor.js': { output: 'notes-editor-abcdef123456.js', bytes: 10 },
    };
    try {
        for (const [alias, entry] of Object.entries(assets)) {
            fs.writeFileSync(path.join(dist, alias), '0123456789');
            fs.writeFileSync(path.join(dist, entry.output), '0123456789');
        }
        expect(() => validateBundledFrontend(dist, { assets })).not.toThrow();
        expect(() => validateBundledFrontend(dist, {})).toThrow(/damaged frontend bundle \(lib.js\)/);
        fs.unlinkSync(path.join(dist, 'notes-editor.js'));
        expect(() => validateBundledFrontend(dist, { assets })).toThrow(/damaged frontend bundle \(notes-editor.js\)/);
        fs.writeFileSync(path.join(dist, 'notes-editor.js'), '0123456789');
        fs.truncateSync(path.join(dist, assets['lib.js'].output), 4);
        expect(() => validateBundledFrontend(dist, { assets })).toThrow(/damaged frontend bundle \(lib.js\)/);
    } finally {
        fs.rmSync(dist, { recursive: true, force: true });
    }
});
