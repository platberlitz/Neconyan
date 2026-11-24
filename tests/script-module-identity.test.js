import { describe, expect, test } from '@jest/globals';
import { clearPublicModuleImportMapCache, readRewrittenFrontendHtml } from '../src/frontend-assets.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function collectJsFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            collectJsFiles(fullPath, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(fullPath);
        }
    }

    return out;
}

describe('frontend module identity', () => {
    // Browsers key ES module identity by full URL, query string included. The
    // source page stays bare, and the server stamps both the tag and the import
    // map with the same label, so '../script.js' imports reach that same URL.
    test('script.js loads under its bare URL so module identity matches bare imports', () => {
        expect(indexHtml).toContain('<link rel="modulepreload" href="script.js">');
        expect(indexHtml).toContain('<script type="module" src="script.js" data-neconyan-core-script></script>');
        expect(indexHtml).not.toMatch(/(?:src|href)="script\.js\?/);
    });

    test('the served page stamps tags and the import map with the same labels', () => {
        clearPublicModuleImportMapCache();
        const served = readRewrittenFrontendHtml(path.join(repoRoot, 'public', 'index.html'), { enabled: true });
        const map = JSON.parse(served.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

        for (const match of served.matchAll(/<script type="module" src="([^"]+)"/g)) {
            const url = match[1];
            expect(map[url.split('?')[0]]).toBe(url);
        }
        const scriptTag = [...served.matchAll(/<script type="module" src="([^"]+)" data-neconyan-core-script>/g)]
            .map(match => match[1])
            .find(url => url.startsWith('/script.js?'));
        expect(map['/script.js']).toBe(scriptTag);
        clearPublicModuleImportMapCache();
    });


    test('a plain install stamps public modules and styles without a build', () => {
        clearPublicModuleImportMapCache();
        const served = readRewrittenFrontendHtml(path.join(repoRoot, 'public', 'index.html'), { enabled: false });
        const map = JSON.parse(served.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
        const scriptTag = [...served.matchAll(/<script type="module" src="([^"]+)" data-neconyan-core-script>/g)]
            .map(match => match[1])
            .find(url => url.startsWith('/script.js?'));
        const styleTag = served.match(/<link[^>]*href="([^"]*neconyan\.css[^"]*)"/)?.[1] ?? '';

        expect(scriptTag).toBe(map['/script.js']);
        expect(styleTag).toMatch(/^\/css\/neconyan\.css\?v=/);
        expect(served).not.toContain('/frontend-assets/');
        clearPublicModuleImportMapCache();
    });

    test('the home route rewrites the page on every install', () => {
        const serverSource = readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
        expect(serverSource).toContain('readRewrittenFrontendHtml(undefined, { enabled: shouldServeFrontendAssets() })');
        expect(serverSource).not.toContain('response.sendFile(\'index.html\'');
    });

    test('cache-busted module tags are never bare-imported elsewhere', () => {
        const versionedModuleSrcs = [...indexHtml.matchAll(/<script type="module" src="([^"]+)\?[^"]*">/g)]
            .map(match => match[1]);
        const jsFiles = collectJsFiles(path.join(repoRoot, 'public'));

        for (const src of versionedModuleSrcs) {
            const basename = path.posix.basename(src).replace(/\./g, '\\.');
            const importPattern = new RegExp(`(?:from\\s*|import\\s*\\(\\s*)['"][^'"]*${basename}['"]`);
            const offenders = jsFiles.filter(file => importPattern.test(readFileSync(file, 'utf8')));

            expect(offenders).toEqual([]);
        }
    });
});
