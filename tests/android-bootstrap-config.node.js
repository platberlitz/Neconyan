import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ensureBootstrapConfigSections } from '../android/bootstrap-config.mjs';

const bootstrapSource = fs.readFileSync(new URL('../android/server-bootstrap.mjs', import.meta.url), 'utf8');

test('an old configuration missing newer sections gains every container without losing saved fields', () => {
    const config = { listen: false, port: 5100, whitelistMode: true };
    ensureBootstrapConfigSections(config);
    for (const section of ['browserLaunch', 'extensions', 'git', 'logging', 'performance', 'performance.frontendBuild']) {
        const [container, leaf] = section.split('.');
        const value = leaf ? config[container]?.[leaf] : config[container];
        assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${section} must be a container`);
    }
    assert.equal(config.listen, false);
    assert.equal(config.port, 5100);
    assert.equal(config.whitelistMode, true);
});

test('partially saved sections keep their fields and only gain missing leaves', () => {
    const config = { performance: { threads: 2 }, extensions: { autoUpdate: true } };
    ensureBootstrapConfigSections(config);
    assert.deepEqual(config.performance, { threads: 2, frontendBuild: {} });
    assert.deepEqual(config.extensions, { autoUpdate: true });
    assert.deepEqual(config.git, {});
});

test('null sections are treated as missing, not malformed', () => {
    const config = { performance: null, logging: null };
    ensureBootstrapConfigSections(config);
    assert.deepEqual(config.performance, { frontendBuild: {} });
    assert.deepEqual(config.logging, {});
});

test('a malformed configuration throws and leaves the saved value untouched', () => {
    for (const config of ['just text', 42, ['an', 'array'], { performance: 'fast' }, { git: [] }, { browserLaunch: 'no' }]) {
        const before = JSON.stringify(config);
        assert.throws(() => ensureBootstrapConfigSections(config), /android-config\.yaml/);
        assert.equal(JSON.stringify(config), before);
    }
});

test('the bootstrap normalises the configuration before mutating it and before writing it back', () => {
    const call = bootstrapSource.indexOf('ensureBootstrapConfigSections(config);');
    const assign = bootstrapSource.indexOf('Object.assign(config, {');
    const write = bootstrapSource.indexOf('writeFileAtomicSync(configPath, YAML.stringify(config)');
    assert.ok(call !== -1 && assign !== -1 && write !== -1);
    assert.ok(call < assign, 'missing sections must be created before any nested write');
    assert.ok(assign < write, 'the configuration is only persisted after it is complete');
    assert.match(bootstrapSource, /import \{ ensureBootstrapConfigSections \} from '\.\/bootstrap-config\.mjs';/);
});
