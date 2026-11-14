/* global globalThis */
/* eslint playwright/expect-expect: off -- Node assertions verify the shared macro host. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMacroEnvironment, MacroRegistry } from '../src/macros/index.js';
import { captureEnhancedMacros } from '../src/macros/enhanced.js';
import { enhanced } from './fixtures/macro-enhanced-baseline.js';

const settings = { user_avatar: 'selected.png', power_user: { experimental_macro_engine: true }, extension_settings: {
    MacroEnhanced: { pronouns: { personas: { 'selected.png': 'she/her', 'other.png': 'they/them' } } },
} };
const card = { MacroEnhanced: { pronouns: 'he/him' } };
const snapshot = () => ({ macroEnhanced: captureEnhancedMacros(settings, card),
    variables: { local: { item: 'saved alias', item_value: 'saved value' }, global: {} }, extra: { chatMetadata: {} } });
const options = { strictCapabilities: true };

test('all shared packs, aliases and deferred bodies work without browser globals', () => {
    const data = snapshot(), pristine = structuredClone(data), writes = [];
    const env = createMacroEnvironment(data, {}, { onMetadataChange: write => writes.push(write) });
    for (const [input, output] of enhanced) assert.equal(env.evaluate(input, options), output, input);
    assert.equal(env.extra.variables.local.get('item'), 'saved alias');
    assert.equal(env.extra.variables.local.get('item_value'), 'saved value');
    assert.equal(env.extra.variables.local.has('item_key'), false);
    assert.equal(env.captureState().chatMetadata.MacroEnhanced.pronouns.char, 'she/her');
    assert.equal(writes.at(-1).value.pronouns.user, 'they/them');
    assert.deepEqual(data, pristine);
    assert.equal(MacroRegistry.hasMacro('obj'), false);
    assert.equal(globalThis.SillyTavern, undefined);
});

test('persona and card capture honours selection, group defaults and disabled extensions', () => {
    const selected = createMacroEnvironment({ macroEnhanced: captureEnhancedMacros(settings, card, { personaAvatar: 'other.png', group: true }) });
    assert.equal(selected.evaluate('{{obj}}/{{charobj}}', options), 'them/them');
    assert.equal(createMacroEnvironment().evaluate('{{obj}}/{{Charobj}}', options), 'them/Them');
    for (const disabledExtensions of [['MacroEnhanced'], ['third-party/MacroEnhanced']]) {
        const disabled = captureEnhancedMacros({ ...settings, extension_settings: { ...settings.extension_settings, disabledExtensions } }, card);
        assert.equal(disabled.enabled, false);
        assert.throws(() => createMacroEnvironment({ macroEnhanced: disabled }).evaluate('{{obj}}', options), { code: 'MACRO_BROWSER_ONLY' });
    }
    assert.equal(captureEnhancedMacros({ ...settings, power_user: { experimental_macro_engine: false } }, card).enabled, false);
});

test('chat overrides, forks and nested accounts keep pronouns and stored values private', () => {
    const a = createMacroEnvironment(snapshot());
    const b = createMacroEnvironment({ ...snapshot(), macroEnhanced: { enabled: true, pronouns: { user: 'he/him' } } }, {}, {
        dynamicMacros: { other: () => a.evaluate('{{freeze::same}}{{obj}}{{/freeze}}', options) },
    });
    assert.equal(b.evaluate('{{freeze::same}}{{other}}/{{obj}}{{/freeze}}', options), 'her/him');
    a.evaluate('{{setpronouns::it/its}}{{setchatvar::score::7}}', options);
    const fork = a.fork();
    assert.equal(fork.evaluate('{{obj}}/{{getchatvar::score}}{{setpronouns::he/him}}{{addchatvar::score::1}}', options), 'it/7');
    assert.equal(a.evaluate('{{obj}}/{{getchatvar::score}}', options), 'it/7');
    assert.equal(b.evaluate('{{obj}}/{{getchatvar::score::none}}', options), 'him/none');
});

test('preview writes remain local and strict read-only scans refuse every persistent writer', () => {
    const data = snapshot(), writes = [];
    data.extra.chatMetadata.MacroEnhanced = { chatVars: { score: '2' }, pronouns: { user: 'he/him' } };
    const pristine = structuredClone(data);
    const preview = createMacroEnvironment(data, {}, { readOnly: true, onMetadataChange: write => writes.push(write) });
    assert.equal(preview.evaluate('{{setpronouns::it/its}}{{addchatvar::score::3}}{{obj}}/{{getchatvar::score}}', options), 'it/5');
    assert.deepEqual(writes, []);
    assert.deepEqual(data, pristine);
    const strict = createMacroEnvironment({ ...data, writableScopes: ['local'] }, {}, { readOnly: true });
    for (const input of ['{{setchatvar::x::1}}', '{{addchatvar::score::1}}', '{{deletechatvar::score}}',
        '{{setpronouns::she/her}}', '{{setcharpronouns::he/him}}', '{{freeze::x}}value{{/freeze}}',
        '{{sticky::10::x}}value{{/sticky}}', '{{daily::x}}value{{/daily}}', '{{rollonce::x::1d1}}']) {
        assert.throws(() => strict.evaluate(input, options), { code: 'MACRO_WRITE_UNSUPPORTED' }, input);
    }
    assert.equal(strict.evaluate('{{obj}}/{{getchatvar::score}}', options), 'him/2');
});

test('JSON writers use the local host store and cannot bypass global write restrictions', () => {
    const env = createMacroEnvironment({ ...snapshot(), writableScopes: ['local'], variables: { local: { object: '{}' }, global: {} } });
    assert.equal(env.evaluate('{{jsonset::object::a::3}}{{getvar::object}}', options), '{"a":"3"}');
    assert.throws(() => env.evaluate('{{jsonset::object::a::3::global}}', options), { code: 'MACRO_WRITE_UNSUPPORTED' });
});

test('syntax rewrites are per-operation, including nested bodies and unsupported produced macros', () => {
    const data = snapshot();
    data.macroEnhanced.syntax = { compatExpressions: true, fixImportedSyntax: true };
    const env = createMacroEnvironment(data);
    assert.equal(env.evaluate('{{setchatvar::n::3}}{{if::{{@n}} > 2 && 1 < 2}}{{obj}}{{else}}no{{/if}}', options), 'her');
    assert.equal(env.evaluate('{{freeze::expr}}{{if::1 > 0}}yes{{/if}}{{/freeze}}', options), 'yes');
    assert.equal(createMacroEnvironment(snapshot()).evaluate('{{@n}}', options), '{{@n}}');
    const unsupported = createMacroEnvironment({ ...data, browserMacros: ['private'] });
    assert.throws(() => unsupported.evaluate('{{freeze::x}}{{private}}{{/freeze}}', options), { code: 'MACRO_BROWSER_ONLY' });
});
