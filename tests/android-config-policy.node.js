/* eslint playwright/expect-expect: off -- Node assertions exercise the Android configuration policy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ANDROID_CONFIG_DEFAULTS, applyAndroidConfigPolicy, validateAndroidConfigEdit, validateAndroidListenerConfig } from '../src/android-config-policy.js';

const managed = { dataRoot: '/private/data', port: 28193, basicAuthUser: { username: 'neconyan', password: 'private-fixture-password' } };
const nested = (field, value) => field.split('.').reverse().reduce((result, key) => ({ [key]: result }), value);
const read = (config, field) => field.split('.').reduce((value, key) => value[key], config);

test('the exact Android defaults apply to factory and recovered desktop documents', () => {
    const expected = {
        listen: true, 'listenAddress.ipv4': '127.0.0.1', 'listenAddress.ipv6': '::1',
        'protocol.ipv4': true, 'protocol.ipv6': false, 'ssl.enabled': false,
        basicAuthMode: true, perUserBasicAuth: false, enableUserAccounts: false,
        enableServerPlugins: false, enableServerPluginsAutoUpdate: false,
        'browserLaunch.enabled': false, 'extensions.autoUpdate': false, 'git.backend': 'builtin',
        'performance.frontendBuild.enabled': true, 'logging.enableAccessLog': false,
    };
    assert.deepEqual(ANDROID_CONFIG_DEFAULTS, expected);
    for (const source of ['default', 'recovered']) {
        const config = { listen: false, listenAddress: { ipv4: '0.0.0.0' }, ssl: { enabled: true }, performance: { frontendBuild: { enabled: false } }, unrelated: 'retained' };
        applyAndroidConfigPolicy(config, { source, managed });
        for (const [field, value] of Object.entries(expected)) assert.equal(read(config, field), value, `${source}: ${field}`);
        assert.equal(config.dataRoot, managed.dataRoot);
        assert.equal(config.port, managed.port);
        assert.deepEqual(config.basicAuthUser, managed.basicAuthUser);
        assert.equal(config.unrelated, 'retained');
    }
});

test('saved omissions gain Android leaves without changing supported preferences or unrelated settings', () => {
    const config = { listenAddress: { ipv4: '0.0.0.0', ipv6: '[::]' }, protocol: { ipv4: 'auto', ipv6: 'auto' },
        performance: { frontendBuild: { enabled: false }, threads: 3 }, logging: { enableAccessLog: true },
        git: { backend: 'auto' }, enableServerPlugins: true, whitelist: ['192.0.2.5'], whitelistMode: true, enableCorsProxy: true, provider: { key: 'retained' } };
    const before = structuredClone(config);
    const { repairs } = applyAndroidConfigPolicy(config, { source: 'saved', managed });
    assert.deepEqual(repairs, []);
    for (const [key, value] of Object.entries(before)) assert.deepEqual(config[key], value, key);
    assert.equal(config.ssl.enabled, false);
    assert.equal(config.extensions.autoUpdate, false);
    const partial = { listenAddress: {}, performance: {} };
    applyAndroidConfigPolicy(partial, { source: 'saved', managed });
    assert.equal(partial.listenAddress.ipv4, '127.0.0.1');
    assert.equal(partial.performance.frontendBuild.enabled, true);
    assert.equal(partial.ssl.enabled, false);
});

test('all managed and native requirements reject incompatible explicit edits without mutation or secrets', () => {
    const rejected = {
        dataRoot: '/other', port: 1234, 'basicAuthUser.username': 'other', 'basicAuthUser.password': 'changed-secret',
        listen: false, basicAuthMode: false, perUserBasicAuth: true, enableUserAccounts: true,
        'protocol.ipv4': false, 'listenAddress.ipv4': '192.0.2.5', 'ssl.enabled': true,
        'browserLaunch.enabled': true, 'extensions.autoUpdate': true, enableServerPluginsAutoUpdate: true, 'git.backend': 'system',
    };
    for (const [field, value] of Object.entries(rejected)) {
        const config = nested(field, value);
        const before = structuredClone(config);
        assert.throws(() => validateAndroidConfigEdit(config, managed), error => {
            assert.equal(error.status, 400);
            assert.ok(error.message.includes(field));
            assert.ok(!error.message.includes('changed-secret'));
            assert.ok(!error.message.includes(managed.basicAuthUser.password));
            if (field === 'enableUserAccounts') assert.match(error.message, /backup.*default account/);
            return true;
        });
        assert.deepEqual(config, before);
    }
    validateAndroidConfigEdit({}, managed);
    validateAndroidConfigEdit(structuredClone(managed), managed);
});

test('strict shapes, booleans, addresses and protocol values never coerce invalid input to wildcard', () => {
    for (const config of [null, [], 'yaml', { ssl: null }, { protocol: [] }, { basicAuthUser: false }, { performance: { frontendBuild: 'no' } },
        { listenAddress: { ipv4: 'garbage' } }, { listenAddress: { ipv4: 0 } }, { listenAddress: { ipv6: 'garbage' } },
        { listenAddress: { ipv6: '[::1' } }, { listenAddress: { ipv6: 'fe80::1%eth0' } }, { protocol: { ipv4: 'true' } }, { protocol: { ipv6: 1 } },
        { listen: 'true' }, { logging: { enableAccessLog: 'false' } }, { enableServerPlugins: 1 },
        { performance: { frontendBuild: { enabled: null } } }, { git: { backend: null } }]) {
        assert.throws(() => validateAndroidConfigEdit(config, managed));
    }
    for (const ipv6 of ['::1', '::', '[::]', '2001:db8::1', '[2001:db8::1]']) {
        for (const enabled of [true, false, 'auto']) validateAndroidConfigEdit({ listenAddress: { ipv6 }, protocol: { ipv6: enabled, ipv4: 'auto' } }, managed);
    }
    validateAndroidConfigEdit({ git: { backend: 'builtin' }, logging: { enableAccessLog: true }, enableServerPlugins: true, performance: { frontendBuild: { enabled: false } } }, managed);
    // Desktop defaults have no authority to impersonate factory provenance.
    assert.throws(() => validateAndroidConfigEdit({ listen: false, basicAuthMode: false }, managed));
});

test('boot repairs launcher requirements once, with field paths and reasons only', () => {
    const config = { port: 1, dataRoot: '/old', basicAuthMode: false, basicAuthUser: { username: 'old', password: 'old-secret' },
        enableUserAccounts: true, extensions: { autoUpdate: true }, git: { backend: 'system' } };
    validateAndroidListenerConfig(config);
    const { repairs } = applyAndroidConfigPolicy(config, { source: 'saved', managed });
    for (const field of ['port', 'dataRoot', 'basicAuthMode', 'basicAuthUser.username', 'basicAuthUser.password', 'enableUserAccounts', 'extensions.autoUpdate', 'git.backend']) {
        assert.ok(repairs.some(repair => repair.field === field), field);
    }
    assert.doesNotMatch(JSON.stringify(repairs), /old-secret|private-fixture-password|\/old/);
    assert.deepEqual(applyAndroidConfigPolicy(config, { source: 'saved', managed }).repairs, []);
});

test('the real CLI makes valid Android IPv6 URLs and rejects invalid addresses before fallback', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-android-cli-'));
    try {
        const configPath = path.join(directory, 'config.yaml');
        fs.copyFileSync(new URL('../default/config.yaml', import.meta.url), configPath);
        const script = `
            import assert from 'node:assert/strict';
            const { CommandLineParser } = await import(${JSON.stringify(new URL('../src/command-line.js', import.meta.url).href)});
            const cli = new CommandLineParser().parse(['node', 'server.js', '--configPath', process.argv[1], '--dataRoot', process.argv[2]]);
            cli.listen = true;
            cli.port = 28193;
            for (const [address, expected] of [['::1', '[::1]'], ['[::]', '[::]'], ['2001:db8::5', '[2001:db8::5]'], ['[2001:db8::5]', '[2001:db8::5]']]) {
                cli.listenAddressIPv6 = address;
                assert.equal(cli.getIPv6ListenUrl().href, 'http://' + expected + ':28193/');
            }
            for (const address of ['garbage', '[::1', 'fe80::1%eth0']) {
                cli.listenAddressIPv6 = address;
                assert.throws(() => cli.getIPv6ListenUrl(), /listenAddress.ipv6/);
            }
            cli.listenAddressIPv4 = 'invalid';
            assert.throws(() => cli.getIPv4ListenUrl(), /listenAddress.ipv4/);
            for (const address of ['127.0.0.1', '0.0.0.0']) {
                cli.listenAddressIPv4 = address;
                assert.equal(cli.getIPv4ListenUrl().href, 'http://' + address + ':28193/');
            }
            // The new rejection applies only to Android. Keep the pre-existing
            // desktop/iOS fallback unchanged for their own configuration policy.
            for (const host of ['desktop', 'ios']) {
                delete process.env.NECONYAN_ANDROID_APP;
                if (host === 'ios') process.env.NECONYAN_IOS_APP = '1';
                cli.listenAddressIPv4 = 'invalid';
                assert.equal(cli.getIPv4ListenUrl().href, 'http://0.0.0.0:28193/');
                cli.listenAddressIPv6 = 'invalid';
                assert.equal(cli.getIPv6ListenUrl().href, 'http://[::]:28193/');
            }
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, configPath, path.join(directory, 'data')], {
            encoding: 'utf8', env: { ...process.env, NECONYAN_ANDROID_APP: '1', NECONYAN_IOS_APP: '0' },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
