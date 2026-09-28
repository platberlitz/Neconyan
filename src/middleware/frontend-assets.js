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
    loadFrontendManifest,
} from '../frontend-assets.js';

export function setPublicAssetHeaders(res, requestPath) {
    if (/\.(?:m?js|css)$/i.test(requestPath)) {
        // Neconyan: revalidate unversioned JS modules and stylesheets to avoid stale mixed
        // frontend graphs. Extension CSS pairs with always-revalidated JS, so an hour-stale
        // stylesheet leaves new UI unstyled or invisible.
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    if (/\.(?:html?|json|map)$/i.test(requestPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
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
