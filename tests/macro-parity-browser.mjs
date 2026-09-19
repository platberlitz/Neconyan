// Run against disposable app data: node tests/macro-parity-browser.mjs
import assert from 'node:assert/strict';
import { chromium } from './node_modules/playwright/index.mjs';
import { modern, legacy } from './fixtures/macro-baseline.js';

const browser = await chromium.launch();
try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
        const page = await browser.newPage({ viewport, hasTouch: viewport.width === 393, serviceWorkers: 'block' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const base = process.env.NECONYAN_TEST_BASE_URL || 'http://127.0.0.1:4931';
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
        await page.goto(base);
        await page.waitForFunction(() => globalThis.SillyTavern?.getContext().macros.registry.hasMacro('char'), null, { timeout: 90000 });
        const result = await page.evaluate(async ({ modern, legacy }) => {
            const { power_user } = await import('/scripts/power-user.js');
            const { evaluateMacros } = await import('/scripts/macros.js');
            const { withReadOnlyVariables } = await import('/scripts/variable-read-only.js');
            const library = await import('/lib.js');
            const vendor = await import('/scripts/macros/engine/macro-vendor.js');
            const ctx = SillyTavern.getContext();
            ctx.chatMetadata.chat_id_hash = 12345;
            power_user.experimental_macro_engine = true;
            const options = { name1Override: 'User', name2Override: 'Char', replaceCharacterCard: false };
            const outputs = modern.map(([input]) => ctx.substituteParams(input, options));
            const env = ctx.macros.envBuilder.buildFromRawEnv({ content: '{{input}}', ...options });
            const capture = withReadOnlyVariables(() => ctx.substituteParams('{{incvar::probe}}{{getvar::probe}}', options));
            power_user.experimental_macro_engine = false;
            const old = legacy.map(([input]) => evaluateMacros(input, { user: 'User', char: 'Char', group: 'Char', obj: { x: 1 }, 'a.b': 'literal' }));
            const routed = ctx.substituteParams('{{char}}/{{user}}', options);
            return { outputs, old, routed, capture, variables: !!env.extra.variables, vendorIdentity: vendor.moment === library.moment && vendor.chevrotain === library.chevrotain };
        }, { modern, legacy });
        assert.deepEqual(result.outputs, modern.map(([, value]) => value));
        assert.deepEqual(result.old, legacy.map(([, value]) => value));
        assert.equal(result.routed, 'Char/User');
        assert.equal(result.capture, '3');
        assert.equal(result.variables, true);
        assert.equal(result.vendorIdentity, true);
        assert.deepEqual(errors, []);
        console.log(`Browser parity passed at ${viewport.width}x${viewport.height}`);
        await page.close();
    }
} finally { await browser.close(); }
