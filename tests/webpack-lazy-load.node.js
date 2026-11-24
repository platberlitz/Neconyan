import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPublicLibCacheInfo } from '../webpack.config.js';

test('importing webpack-serve and reusing a precompiled bundle does not load webpack', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-webpack-lazy-'));
    try {
        const previousDataRoot = global.DATA_ROOT;
        global.DATA_ROOT = tempRoot;
        let cacheInfo;
        try {
            cacheInfo = getPublicLibCacheInfo({ bundle: 'lib' });
        } finally {
            if (previousDataRoot === undefined) {
                delete global.DATA_ROOT;
            } else {
                global.DATA_ROOT = previousDataRoot;
            }
        }
        fs.mkdirSync(cacheInfo.outputDirectory, { recursive: true });
        fs.writeFileSync(cacheInfo.outputFilePath, 'export const precompiled = true;\n');

        const script = [
            'import { createRequire } from \'node:module\';',
            'const require = createRequire(import.meta.url);',
            'globalThis.DATA_ROOT = process.env.TEST_DATA_ROOT;',
            'const { default: webpackServe } = await import(\'./src/middleware/webpack-serve.js\');',
            'const webpackConfig = await import(\'./webpack.config.js\');',
            'const info = webpackConfig.getPublicLibCacheInfo({ bundle: \'lib\' });',
            'const middleware = webpackServe();',
            'await middleware.runWebpackCompiler();',
            'let servedPath = null;',
            'await new Promise((resolve, reject) => {',
            '    middleware({ method: \'GET\', path: \'/lib.js\' }, {',
            '        setHeader() {},',
            '        sendFile(fileName, options, callback) {',
            '            servedPath = `${options.root}/${fileName}`;',
            '            callback?.();',
            '            resolve();',
            '        },',
            '    }, err => (err ? reject(err) : resolve()));',
            '});',
            'const loaded = Object.keys(require.cache).some(k => k.includes(\'/node_modules/webpack/\'));',
            'console.log(JSON.stringify({ loaded, servedPath, expectedPath: info.outputFilePath, cacheVersion: info.cacheVersion }));',
        ].join('\n');

        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(),
            env: { ...process.env, TEST_DATA_ROOT: tempRoot },
            encoding: 'utf8',
        }).trim();
        const parsed = JSON.parse(output.split('\n').pop());
        assert.equal(parsed.loaded, false);
        assert.equal(parsed.servedPath, parsed.expectedPath);
        assert.equal(typeof parsed.cacheVersion, 'string');
        assert.ok(parsed.cacheVersion.length > 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
