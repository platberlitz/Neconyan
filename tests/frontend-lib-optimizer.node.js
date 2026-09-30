import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import webpack from 'webpack';
import { ValidatedMinificationPlugin } from '../src/frontend-lib-optimizer.js';

test('library minification keeps valid output and recovers from invalid minifier output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neconyan-minify-'));
    try {
        const entry = path.join(root, 'entry.js');
        await fs.writeFile(entry, 'export const answer = 42;');
        for (const invalid of [false, true]) {
            const compiler = webpack({
                mode: 'production', entry, devtool: false,
                output: { path: root, filename: 'lib.js', library: { type: 'module' } },
                experiments: { outputModule: true },
                optimization: { minimize: true },
                plugins: [new ValidatedMinificationPlugin(), {
                    apply(compiler) {
                        compiler.hooks.thisCompilation.tap('BreakMinifier', compilation => {
                            compilation.hooks.processAssets.tap({ name: 'BreakMinifier',
                                stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 0.5 }, () => {
                                if (invalid) compilation.updateAsset('lib.js', new webpack.sources.RawSource('export {'));
                            });
                        });
                    },
                }],
            });
            const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
            await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
            assert.equal(stats.hasErrors(), false, stats.toString());
            assert.equal(stats.hasWarnings(), invalid);
            const output = await fs.readFile(path.join(root, 'lib.js'), 'utf8');
            const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
            assert.equal(module.answer, 42);
            assert.equal(stats.compilation.assetsInfo.get('lib.js').minimized, !invalid);
        }
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
