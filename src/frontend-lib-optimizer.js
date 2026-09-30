import webpack from 'webpack';

/** Keep a working bundle if a runtime-specific minifier produces invalid JavaScript. */
export class ValidatedMinificationPlugin {
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('ValidatedMinification', compilation => {
            const originals = new Map();
            const stage = webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE;
            compilation.hooks.processAssets.tap({ name: 'SaveUnminifiedLibrary', stage: stage - 1 }, assets => {
                for (const [name, source] of Object.entries(assets)) {
                    if (name.endsWith('.js')) originals.set(name, source);
                }
            });
            compilation.hooks.processAssets.tap({ name: 'ValidateMinifiedLibrary', stage: stage + 1 }, assets => {
                for (const [name, original] of originals) {
                    try {
                        new webpack.javascript.JavascriptParser('module').parse(String(assets[name].source()), {});
                    } catch (error) {
                        // Validate the fallback as well; never publish an unusable bundle.
                        new webpack.javascript.JavascriptParser('module').parse(String(original.source()), {});
                        compilation.updateAsset(name, original, { minimized: false });
                        compilation.warnings.push(new Error(`Using the unminified ${name}: ${error.message}`));
                    }
                }
            });
        });
    }
}
