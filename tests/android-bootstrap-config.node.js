import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureBootstrapConfigSections, loadBootstrapConfig, setAsideNotice } from '../android/bootstrap-config.mjs';

const bootstrapSource = fs.readFileSync(new URL('../android/server-bootstrap.mjs', import.meta.url), 'utf8');
const iosBootstrapSource = fs.readFileSync(new URL('../ios/server-bootstrap.mjs', import.meta.url), 'utf8');

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

test('the bootstraps normalise the configuration before mutating it and before writing it back', () => {
    for (const source of [bootstrapSource, iosBootstrapSource]) {
        const call = source.indexOf('loadBootstrapConfig(configPath, path.join(root, \'default/config.yaml\'))');
        const assign = source.indexOf('Object.assign(config, {');
        const write = source.indexOf('writeFileAtomicSync(configPath, YAML.stringify(config)');
        assert.ok(call !== -1 && assign !== -1 && write !== -1);
        assert.ok(call < assign, 'missing sections must be created before any nested write');
        assert.ok(assign < write, 'the configuration is only persisted after it is complete');
        assert.match(source, /import \{ loadBootstrapConfig, setAsideNotice \} from '\.\/bootstrap-config\.mjs';/);
    }
    assert.match(fs.readFileSync(new URL('../scripts/build-ios-payload.js', import.meta.url), 'utf8'), /android\/bootstrap-config\.mjs/);
});

test('a damaged saved configuration is set aside and the launch continues from the default', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-bootstrap-config-'));
    try {
        const configPath = path.join(directory, 'ios-config.yaml');
        const defaultPath = path.join(directory, 'default.yaml');
        fs.writeFileSync(defaultPath, 'port: 8000\nperformance:\n  threads: 1\n');
        let loaded = loadBootstrapConfig(configPath, defaultPath, () => 7);
        assert.equal(loaded.setAside, null);
        assert.equal(loaded.config.port, 8000);
        for (const damaged of ['performance: fast\n', 'just text\n', 'key: [unclosed\n']) {
            fs.writeFileSync(configPath, damaged);
            loaded = loadBootstrapConfig(configPath, defaultPath, () => 7);
            assert.equal(loaded.setAside, `${configPath}.broken-7`);
            assert.equal(fs.readFileSync(loaded.setAside, 'utf8'), damaged, 'the damaged file is kept for the user');
            assert.equal(fs.existsSync(configPath), false);
            assert.deepEqual(loaded.config.performance, { threads: 1, frontendBuild: {} });
            assert.match(setAsideNotice(loaded.setAside), /ios-config\.yaml\.broken-7/);
            fs.rmSync(loaded.setAside);
        }
        fs.writeFileSync(configPath, 'port: 9000\n');
        loaded = loadBootstrapConfig(configPath, defaultPath, () => 7);
        assert.equal(loaded.setAside, null);
        assert.equal(loaded.config.port, 9000);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
