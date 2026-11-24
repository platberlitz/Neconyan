import express from 'express';
import { NECONYAN_NATIVE_EXTENSIONS } from '../neconyan-native-extensions.js';

// Only release-owned directories are aliases. Other Neconyan-* add-ons may
// be personal extensions and must reach their original authenticated route.
export const LEGACY_FRONTEND_ASSET_PREFIXES = Object.freeze(NECONYAN_NATIVE_EXTENSIONS.flatMap(extension => {
    const target = `scripts/extensions/${extension.runtimeDirectory || `third-party/${extension.directory}`}/`;
    return (extension.legacyIds || []).flatMap(id => [
        `scripts/extensions/${id}/`,
        `scripts/extensions/third-party/${id}/`,
    ]).filter(source => source !== target).map(source => [source, target]);
}));

export function redirectLegacyFrontendAsset(request, response, next) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return next();
    }

    const requestPath = String(request.path ?? '').replace(/^\/+/, '');
    const alias = LEGACY_FRONTEND_ASSET_PREFIXES.find(([legacyPrefix]) => requestPath.startsWith(legacyPrefix));
    if (!alias) {
        return next();
    }
    const canonicalPath = `${alias[1]}${requestPath.slice(alias[0].length)}`;

    return response.redirect(307, `/${canonicalPath}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`);
}

import {
    FRONTEND_DIST_ROOT,
    applyFrontendAssetHeaders,
    getFrontendAssetsEnabled,
    getPublicAssetStamp,
    loadFrontendManifest,
} from '../frontend-assets.js';

export function setPublicAssetHeaders(res, requestPath, stat) {
    if (/\.(?:m?js|css)$/i.test(requestPath)) {
        // A URL stamped with the file's own label cannot go stale: the next
        // edit changes the label served in the import map. Anything else keeps
        // revalidating so a mixed frontend graph is never served.
        const stamp = getPublicAssetStamp(stat);
        if (stamp && res.req?.query?.v === stamp) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return;
        }
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    if (/\.(?:html?|json|map)$/i.test(requestPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
}

export const SERVER_ONLY_FRONTEND_SEGMENTS = Object.freeze(['.sourcemaps']);

/**
 * The build keeps source maps beside the hashed assets for Scratchpad's server-side
 * lookup. They are never served, whichever route or encoding asks for them.
 */
export function blockServerOnlyFrontendFiles(request, response, next) {
    let requestPath = String(request.path ?? '');
    try {
        requestPath = decodeURIComponent(requestPath);
    } catch {
        // A malformed path is rejected by the static handlers further on.
    }
    const segments = requestPath.toLowerCase().split(/[\\/]+/);
    if (segments.some(segment => SERVER_ONLY_FRONTEND_SEGMENTS.includes(segment.trim()))) {
        return response.sendStatus(404);
    }
    return next();
}

export function getFrontendAssetMiddleware() {
    return {
        immutableAssets: express.static(FRONTEND_DIST_ROOT, {
            fallthrough: true,
            setHeaders: applyFrontendAssetHeaders,
        }),
        publicAssets: express.static(FRONTEND_DIST_ROOT, {
            fallthrough: true,
            setHeaders: setPublicAssetHeaders,
        }),
    };
}

export function shouldServeFrontendAssets() {
    return getFrontendAssetsEnabled() && Boolean(loadFrontendManifest());
}
