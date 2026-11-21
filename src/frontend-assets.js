import fs from 'node:fs';
import path from 'node:path';

import { serverDirectory } from './server-directory.js';
import { getConfigValue } from './util.js';

export const FRONTEND_DIST_ROOT = path.join(serverDirectory, 'dist', 'frontend');
export const FRONTEND_MANIFEST_FILE = 'asset-manifest.json';
export const FRONTEND_ASSET_PREFIX = '/frontend-assets/';
export const HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

let manifestCache = null;

export function getFrontendManifestPath() {
    return path.join(FRONTEND_DIST_ROOT, FRONTEND_MANIFEST_FILE);
}

export function getFrontendAssetsEnabled() {
    return getConfigValue('performance.frontendBuild.enabled', false, 'boolean');
}

export function getFrontendImmutableMaxAge() {
    const value = getConfigValue('performance.frontendBuild.immutableMaxAge', 31536000, 'number');
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 31536000;
}

export function clearFrontendManifestCache() {
    manifestCache = null;
}

export function loadFrontendManifest() {
    if (manifestCache !== null) {
        return manifestCache;
    }

    const manifestPath = getFrontendManifestPath();
    if (!fs.existsSync(manifestPath)) {
        manifestCache = null;
        return null;
    }

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestCache = manifest && typeof manifest === 'object' ? manifest : null;
    } catch (error) {
        console.warn('Failed to read frontend asset manifest.', error);
        manifestCache = null;
    }

    return manifestCache;
}

/** Native packages have no runtime compiler fallback. Check both URLs for each compiled bundle. */
export function validateBundledFrontend(root = FRONTEND_DIST_ROOT, manifest = loadFrontendManifest()) {
    for (const bundle of ['lib', 'notes-editor']) {
        const alias = `${bundle}.js`;
        const entry = manifest?.assets?.[alias];
        const hashedName = typeof entry?.output === 'string' && new RegExp(`^${bundle}-[0-9a-f]{8,}\\.js$`).test(entry.output);
        if (!hashedName || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
            || [alias, entry.output].some(file => {
                const stat = fs.statSync(path.join(root, file), { throwIfNoEntry: false });
                return !stat?.isFile() || stat.size !== entry.bytes;
            })) {
            throw new Error(`The installed app is missing or has a damaged frontend bundle (${alias}). Install the app again over this copy to keep your data.`);
        }
    }
}

export function resolveFrontendAssetPath(publicPath) {
    const manifest = loadFrontendManifest();
    const assets = manifest?.assets;

    if (!assets || typeof assets !== 'object') {
        return null;
    }

    const normalizedPath = String(publicPath).replace(/^\/+/, '');
    const entry = assets[normalizedPath];

    if (!entry || typeof entry.output !== 'string') {
        return null;
    }

    return `${FRONTEND_ASSET_PREFIX}${entry.output}`;
}

export function rewriteFrontendHtml(html, { enabled = getFrontendAssetsEnabled() } = {}) {
    if (!enabled || typeof html !== 'string') {
        return html;
    }

    let rewritten = html;
    const replacements = new Map([
        ['style.css', resolveFrontendAssetPath('style.css')],
        ['css/mobile-styles.css', resolveFrontendAssetPath('css/mobile-styles.css')],
        ['css/neconyan-theme.css', resolveFrontendAssetPath('css/neconyan-theme.css')],
        ['css/neconyan-tabs.css', resolveFrontendAssetPath('css/neconyan-tabs.css')],
        ['css/neconyan-mobile-shell.css', resolveFrontendAssetPath('css/neconyan-mobile-shell.css')],
        ['css/neconyan-paper-theme.css', resolveFrontendAssetPath('css/neconyan-paper-theme.css')],
        ['css/neconyan.css', resolveFrontendAssetPath('css/neconyan.css')],
        ['css/neconyan-home.css', resolveFrontendAssetPath('css/neconyan-home.css')],
        ['css/neconyan-calico.css', resolveFrontendAssetPath('css/neconyan-calico.css')],
        // Font preloads keep the public URL used by the bundled font-face rules.
        ['webfonts/FredokaOne/stylesheet.css', resolveFrontendAssetPath('webfonts/FredokaOne/stylesheet.css')],
        ['webfonts/Nunito/stylesheet.css', resolveFrontendAssetPath('webfonts/Nunito/stylesheet.css')],
        ['webfonts/Figtree/Figtree-Regular.woff2', resolveFrontendAssetPath('webfonts/Figtree/Figtree-Regular.woff2')],
        ['webfonts/Figtree/stylesheet.css', resolveFrontendAssetPath('webfonts/Figtree/stylesheet.css')],
        ['webfonts/NotoSans/stylesheet.css', resolveFrontendAssetPath('webfonts/NotoSans/stylesheet.css')],
        ['webfonts/NotoSansMono/stylesheet.css', resolveFrontendAssetPath('webfonts/NotoSansMono/stylesheet.css')],
    ]);

    for (const [source, target] of replacements) {
        if (!target) {
            continue;
        }

        const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rewritten = rewritten.replace(new RegExp(`(["'])${escaped}(?:\\?v=[^"']*)?\\1`, 'g'), `$1${target}$1`);
    }

    return rewritten;
}

let indexHtmlCache = null;

/**
 * Rewrites the home page once per file and manifest change. The apps reload it
 * on every launch, and the rewrite runs fifteen document-wide replacements.
 */
export function readRewrittenFrontendHtml(indexPath = path.join(serverDirectory, 'public', 'index.html'), { enabled = getFrontendAssetsEnabled() } = {}) {
    const stat = fs.statSync(indexPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
        return '';
    }

    const manifest = loadFrontendManifest();
    const identity = `${stat.mtimeMs}:${stat.size}:${stat.ino}:${enabled ? 'on' : 'off'}`;
    if (indexHtmlCache?.manifest === manifest && indexHtmlCache.identity === identity) {
        return indexHtmlCache.html;
    }

    const html = rewriteFrontendHtml(fs.readFileSync(indexPath, 'utf8'), { enabled });
    indexHtmlCache = { manifest, identity, html };
    return html;
}

export function applyFrontendAssetHeaders(res, filePath) {
    const relativePath = path.relative(FRONTEND_DIST_ROOT, filePath).split(path.sep).join('/');

    if (HASHED_FRONTEND_ASSET_RE.test(relativePath)) {
        res.setHeader('Cache-Control', `public, max-age=${getFrontendImmutableMaxAge()}, immutable`);
        return;
    }

    res.setHeader('Cache-Control', 'no-cache');
}
