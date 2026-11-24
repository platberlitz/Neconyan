import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ensureBootstrapConfigSections, loadBootstrapConfig, setAsideNotice } from '../android/bootstrap-config.mjs';
import { ANDROID_CONFIG_DEFAULTS, validateAndroidListenerConfig } from '../src/android-config-policy.js';

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
        const call = source.indexOf('loadBootstrapConfig(configPath, path.join(root, \'default/config.yaml\')');
        const assign = source.indexOf(source === bootstrapSource ? 'applyAndroidConfigPolicy(config, {' : 'Object.assign(config, {');
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
        assert.equal(loaded.source, 'default');
        assert.equal(loaded.setAside, null);
        assert.equal(loaded.config.port, 8000);
        for (const damaged of ['performance: fast\n', 'just text\n', 'key: [unclosed\n']) {
            fs.writeFileSync(configPath, damaged);
            loaded = loadBootstrapConfig(configPath, defaultPath, () => 7);
            assert.equal(loaded.source, 'recovered');
            assert.equal(loaded.setAside, `${configPath}.broken-7`);
            assert.equal(fs.readFileSync(loaded.setAside, 'utf8'), damaged, 'the damaged file is kept for the user');
            assert.equal(fs.existsSync(configPath), false);
            assert.deepEqual(loaded.config.performance, { threads: 1, frontendBuild: {} });
            assert.match(setAsideNotice(loaded.setAside), /ios-config\.yaml\.broken-7/);
            fs.rmSync(loaded.setAside);
        }
        fs.writeFileSync(configPath, 'port: 9000\n');
        loaded = loadBootstrapConfig(configPath, defaultPath, () => 7);
        assert.equal(loaded.source, 'saved');
        assert.equal(loaded.setAside, null);
        assert.equal(loaded.config.port, 9000);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('Android transport recovery preserves original bytes and storage failures propagate', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-android-recovery-'));
    try {
        const configPath = path.join(directory, 'android-config.yaml');
        const defaultPath = path.join(directory, 'default.yaml');
        fs.writeFileSync(defaultPath, 'listen: false\nlistenAddress:\n  ipv4: 0.0.0.0\n');
        for (const contents of ['ssl:\n  enabled: true\n', 'listenAddress:\n  ipv4: 192.0.2.5\n', 'protocol:\n  ipv4: false\n',
            'logging:\n  enableAccessLog: invalid\n', 'listenAddress:\n  ipv6: fe80::1%eth0\n']) {
            fs.writeFileSync(configPath, contents);
            const loaded = loadBootstrapConfig(configPath, defaultPath, () => 9, validateAndroidListenerConfig);
            assert.equal(loaded.source, 'recovered');
            assert.equal(fs.readFileSync(loaded.setAside, 'utf8'), contents);
            fs.rmSync(loaded.setAside);
        }
        fs.mkdirSync(configPath);
        assert.throws(() => loadBootstrapConfig(configPath, defaultPath, () => 9, validateAndroidListenerConfig));
        assert.equal(fs.statSync(configPath).isDirectory(), true);
        assert.equal(fs.existsSync(`${configPath}.broken-9`), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// Stage the actual bootstrap at its packaged root. Only the server entry point
// and crash recording are inert here; full endpoint/restart/bind coverage uses
// the opt-in real server.
test('real Android bootstrap keeps explicit wildcard and preferences across ordinary and safe reopening', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-android-bootstrap-'));
    try {
        const state = path.join(directory, 'private');
        fs.mkdirSync(state);
        fs.mkdirSync(path.join(directory, 'src'));
        fs.mkdirSync(path.join(directory, 'default'));
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
        fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
        for (const file of ['android/server-bootstrap.mjs', 'android/bootstrap-config.mjs', 'android/file-stats.mjs']) {
            fs.copyFileSync(path.join(root, file), path.join(directory, path.basename(file)));
        }
        for (const file of ['android-config-policy.js', 'server-events.js', 'android-wake.js', 'startup-note.js']) {
            fs.copyFileSync(path.join(root, 'src', file), path.join(directory, 'src', file));
        }
        fs.writeFileSync(path.join(directory, 'src/crash-diagnostics.js'), 'export function initialiseCrashDiagnostics() {} export function installCrashHandlers() {}');
        fs.copyFileSync(path.join(root, 'default/config.yaml'), path.join(directory, 'default/config.yaml'));
        fs.writeFileSync(path.join(directory, 'server.js'), '');
        const configPath = path.join(state, 'android-config.yaml');
        const launch = mode => {
            const result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64), mode, directory], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            return YAML.parse(fs.readFileSync(configPath, 'utf8'));
        };
        const assertAndroidDefaults = config => {
            for (const [field, expected] of Object.entries(ANDROID_CONFIG_DEFAULTS)) {
                const actual = field.split('.').reduce((value, key) => value[key], config);
                assert.equal(actual, expected, field);
            }
            assert.equal(config.port, 28193);
            assert.equal(config.dataRoot, path.join(state, 'data'));
            assert.deepEqual(config.basicAuthUser, { username: 'neconyan', password: 'a'.repeat(64) });
        };
        let config = launch('normal');
        assertAndroidDefaults(config);
        assert.equal(config.listenAddress.ipv4, '127.0.0.1');
        assert.equal(config.ssl.enabled, false);
        assert.equal(config.performance.frontendBuild.enabled, true);
        config.listenAddress = { ipv4: '0.0.0.0', ipv6: '[::]' };
        config.protocol = { ipv4: 'auto', ipv6: true };
        config.logging.enableAccessLog = true;
        config.performance.frontendBuild.enabled = false;
        config.git.backend = 'auto';
        config.enableServerPlugins = true;
        config.whitelist = ['192.0.2.5'];
        config.customProviderSetting = 'preserved';
        fs.writeFileSync(configPath, YAML.stringify(config));
        for (const mode of ['normal', 'safe', 'normal']) {
            config = launch(mode);
            assert.equal(config.listenAddress.ipv4, '0.0.0.0');
            assert.equal(config.listenAddress.ipv6, '[::]');
            assert.equal(config.protocol.ipv4, 'auto');
            assert.equal(config.protocol.ipv6, true);
            assert.equal(config.logging.enableAccessLog, true);
            assert.equal(config.performance.frontendBuild.enabled, false);
            assert.equal(config.git.backend, 'auto');
            assert.equal(config.enableServerPlugins, true);
            assert.deepEqual(config.whitelist, ['192.0.2.5']);
            assert.equal(config.customProviderSetting, 'preserved');
        }
        fs.writeFileSync(configPath, 'performance: {}\ncustomProviderSetting: old-partial\n');
        config = launch('safe');
        assertAndroidDefaults(config);
        assert.equal(config.listenAddress.ipv4, '127.0.0.1');
        assert.equal(config.performance.frontendBuild.enabled, true);
        assert.equal(config.customProviderSetting, 'old-partial');
        const incompatible = 'ssl:\n  enabled: true\nlistenAddress:\n  ipv4: 0.0.0.0\n';
        fs.writeFileSync(configPath, incompatible);
        config = launch('normal');
        assertAndroidDefaults(config);
        assert.equal(config.listenAddress.ipv4, '127.0.0.1');
        assert.equal(config.ssl.enabled, false);
        const kept = fs.readdirSync(state).find(file => file.startsWith('android-config.yaml.broken-'));
        assert.equal(fs.readFileSync(path.join(state, kept), 'utf8'), incompatible);
        assert.match(fs.readFileSync(path.join(directory, 'startup-status.txt'), 'utf8'), /old file was kept/);
        assert.equal(launch('safe').listenAddress.ipv4, '127.0.0.1');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
