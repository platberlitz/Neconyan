import { describe, expect, jest, test } from '@jest/globals';

import { redirectLegacyFrontendAsset, setPublicAssetHeaders } from '../src/middleware/frontend-assets.js';

function getHeadersFor(requestPath) {
    const headers = new Map();

    setPublicAssetHeaders({
        setHeader: (name, value) => headers.set(name, value),
    }, requestPath);

    return headers;
}

function getCacheControlFor(requestPath) {
    return getHeadersFor(requestPath).get('Cache-Control');
}

describe('frontend asset fallback headers', () => {
    test('redirects known native aliases without hijacking similarly named personal extensions', () => {
        for (const [source, target] of [
            ['third-party/Neconyan-MacroEnhanced/index.js', 'third-party/MacroEnhanced/index.js'],
            ['third-party/BunnyPresetTools/content.js', 'third-party/Neconyan-Preset-Tools/content.js'],
            ['third-party/Neconyan-Debugger/src/ui.js', 'neconyan-debugger/src/ui.js'],
        ]) {
            const redirect = jest.fn();
            const next = jest.fn();
            const pathname = `/scripts/extensions/${source}`;
            redirectLegacyFrontendAsset({ method: 'GET', path: pathname, url: `${pathname}?v=old` }, { redirect }, next);
            expect(redirect).toHaveBeenCalledWith(307, `/scripts/extensions/${target}?v=old`);
            expect(next).not.toHaveBeenCalled();
        }
        for (const pathname of [
            '/scripts/extensions/third-party/Neconyan-CustomTool/index.js',
            '/scripts/extensions/third-party/BunnyPresetToolsCustom/content.js',
            '/scripts/neconyan-personal.js',
            '/css/neconyan-personal.css',
            '/scripts/neconyan-tabs.js',
            '/scripts/neconyan-conversation/index.js',
        ]) {
            const redirect = jest.fn();
            const next = jest.fn();
            redirectLegacyFrontendAsset({ method: 'GET', path: pathname, url: pathname }, { redirect }, next);
            expect(redirect).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledTimes(1);
        }
    });

    test('keeps html, json, and maps revalidating', () => {
        expect(getCacheControlFor('/index.html')).toBe('no-cache');
        expect(getCacheControlFor('/login.html')).toBe('no-cache');
        expect(getCacheControlFor('/manifest.json')).toBe('no-cache');
        expect(getCacheControlFor('/script.js.map')).toBe('no-cache');
    });

    test('revalidates public JavaScript modules for every browser', () => {
        expect(getCacheControlFor('/script.js')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/chat-render-lifecycle/render-window.js')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/bootstrap.mjs')).toBe('no-cache');
    });

    test('revalidates unversioned stylesheets alongside their scripts', () => {
        expect(getCacheControlFor('/style.css')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/extensions/in-chat-agents/style.css')).toBe('no-cache');
    });

    test('keeps static non-code fallback assets short-lived', () => {
        expect(getCacheControlFor('/img/logo.png')).toBe('public, max-age=3600');
    });

});
