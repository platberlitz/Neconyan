import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertStructuredPrefillRuntime,
    assertSupportedBun,
    bunVersionSupportsStructuredPrefill,
    compareVersions,
    MINIMUM_BUN_VERSION,
    unsupportedBunMessage,
} from '../src/runtime-support.js';

test('the minimum is the stable 1.4.0 release', () => {
    assert.equal(MINIMUM_BUN_VERSION, '1.4.0');
    assert.equal(compareVersions('1.3.14', '1.4.0'), -1);
    assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
    assert.equal(compareVersions('1.4.0+build.7', '1.4.0'), 0);
    assert.equal(compareVersions('1.10.0', '1.4.0'), 1);
    assert.equal(compareVersions('1.5.0-canary.1', '1.4.0'), 1);
});

test('a prerelease of the minimum does not count as stable 1.4.0', () => {
    assert.equal(compareVersions('1.4.0-canary.1', '1.4.0'), -1);
    assert.equal(compareVersions('1.4.0-rc.1', '1.4.0'), -1);
    assert.equal(compareVersions('1.4.0-canary.1+build.7', '1.4.0'), -1);
    assert.equal(bunVersionSupportsStructuredPrefill('1.4.0-canary.1'), false);
    assert.equal(bunVersionSupportsStructuredPrefill('1.4.0-rc.1'), false);
    assert.equal(bunVersionSupportsStructuredPrefill('1.4.0'), true);
    assert.equal(bunVersionSupportsStructuredPrefill('1.4.0+build.7'), true);
    assert.equal(bunVersionSupportsStructuredPrefill('1.5.0-canary.1'), true);
    assert.equal(bunVersionSupportsStructuredPrefill(undefined), true);
});

test('prerelease identifiers follow semver ordering', () => {
    assert.equal(compareVersions('1.4.0-alpha', '1.4.0-alpha.1'), -1);
    assert.equal(compareVersions('1.4.0-alpha.1', '1.4.0-alpha.2'), -1);
    assert.equal(compareVersions('1.4.0-alpha.2', '1.4.0-alpha.10'), -1);
    assert.equal(compareVersions('1.4.0-1', '1.4.0-alpha'), -1);
    assert.equal(compareVersions('1.4.0-0.1', '1.4.0-0.2'), -1);
});

test('malformed and non-finite version parts are rejected', () => {
    for (const value of ['', 'broken', '1.4', '1.4.0.1', '01.4.0', '1.04.0', '1.4.00',
        '1.4.0-', '1.4.0+', '1.4.0-canary..1', '1.4.0+build..7', '1.4.0-01',
        'Infinity.4.0', 'NaN.4.0',
        '999999999999999999999999.0.0', '1.4.999999999999999999999']) {
        assert.equal(compareVersions(value, '1.4.0'), null, value);
    }
});

test('the runtime guards reject the minimum prerelease with actionable copy', () => {
    assert.throws(() => assertStructuredPrefillRuntime('1.4.0-canary.1'), {
        code: 'STRUCTURED_PREFILL_UNSUPPORTED_RUNTIME',
    });
    assert.throws(() => assertSupportedBun('1.4.0-canary.1'), {
        code: 'UNSUPPORTED_BUN_RUNTIME',
    });
    assert.doesNotThrow(() => assertStructuredPrefillRuntime('1.4.0'));
    assert.doesNotThrow(() => assertStructuredPrefillRuntime('1.4.0+build.7'));
    assert.doesNotThrow(() => assertSupportedBun('1.4.0'));
    assert.doesNotThrow(() => assertSupportedBun('1.5.0-canary.1'));
    assert.match(unsupportedBunMessage('1.4.0-canary.1'), /Node 24 or Bun 1\.4\.0 or later/);
});
