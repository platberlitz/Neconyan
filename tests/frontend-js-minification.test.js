import vm from 'node:vm';

import { describe, expect, test } from '@jest/globals';

import { optimizeAsset } from '../scripts/build-frontend-assets.js';

async function optimize(relativePath, source) {
    const warnings = [];
    const output = await optimizeAsset(
        `/virtual/${relativePath}`,
        relativePath,
        '.js',
        warnings,
        Buffer.from(source),
    );

    return { code: output.toString('utf8'), warnings };
}

describe('frontend JavaScript asset minification', () => {
    test('minifies a module with top-level await instead of skipping it', async () => {
        const { code, warnings } = await optimize(
            'scripts/extensions/third-party/sillytavern-character-colors/src/st-api.js',
            'const loaded = await Promise.resolve(\'ready\');\nexport { loaded };\n',
        );

        expect(warnings).toEqual([]);
        expect(code).toContain('await');

        const module = new vm.SourceTextModule(code);
        await module.link(() => {
            throw new Error('The fixture must not import anything.');
        });
        await module.evaluate();
        expect(module.namespace.loaded).toBe('ready');
    });

    test('keeps top-level globals from classic early boot scripts', async () => {
        const { code, warnings } = await optimize(
            'scripts/crash-diagnostics.js',
            'var neconyanBuildGlobal = 41;\nfunction readNeconyanBuildGlobal() { return neconyanBuildGlobal + 1; }\n',
        );

        expect(warnings).toEqual([]);

        const context = {};
        vm.runInNewContext(code, context);
        expect(context.neconyanBuildGlobal).toBe(41);
        expect(context.readNeconyanBuildGlobal()).toBe(42);
    });
});
