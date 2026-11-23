import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Lays out the files the payload builder ships beside the iOS bootstrap. */
function bootstrapFixture(directory) {
    const state = path.join(directory, 'private');
    fs.mkdirSync(state);
    fs.mkdirSync(path.join(directory, 'src'));
    fs.mkdirSync(path.join(directory, 'default'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(path.join(root, 'ios/server-bootstrap.mjs'), path.join(directory, 'server-bootstrap.mjs'));
    fs.copyFileSync(path.join(root, 'android/bootstrap-config.mjs'), path.join(directory, 'bootstrap-config.mjs'));
    fs.copyFileSync(path.join(root, 'default/config.yaml'), path.join(directory, 'default/config.yaml'));
    fs.copyFileSync(path.join(root, 'src/android-wake.js'), path.join(directory, 'src/android-wake.js'));
    fs.copyFileSync(path.join(root, 'src/startup-note.js'), path.join(directory, 'src/startup-note.js'));
    fs.writeFileSync(path.join(directory, 'src/server-events.js'), 'import { EventEmitter } from \'node:events\'; export const serverEvents = new EventEmitter(); export const EVENT_NAMES = {SERVER_STARTED:\'started\'};');
    return state;
}

test('iOS launch isolates the listener and retains private settings across launches', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ios-bootstrap-'));
    try {
        const state = bootstrapFixture(directory);
        fs.writeFileSync(path.join(directory, 'server.js'), `
            import fs from 'node:fs'; import path from 'node:path';
            import { serverEvents, EVENT_NAMES } from './src/server-events.js';
            const state = path.dirname(process.argv[3]);
            const busyWhileStarting = fs.existsSync(path.join(state,'ios-busy'));
            serverEvents.emit(EVENT_NAMES.SERVER_STARTED);
            fs.writeFileSync(path.join(state,'observed.json'), JSON.stringify({
                ready: JSON.parse(fs.readFileSync(path.join(state,'ios-ready.json'),'utf8')),
                supervised: process.env.NECONYAN_SUPERVISED, ios: process.env.NECONYAN_IOS_APP,
                inbox: process.env.NECONYAN_LOCAL_IMPORT_DIR, busyWhileStarting,
            }));
        `);
        const launch = password => spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', password], { encoding: 'utf8' });
        let result = launch('a'.repeat(64));
        assert.equal(result.status, 0, result.stderr);
        const configPath = path.join(state, 'ios-config.yaml');
        let config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        config.browserLaunch.enabled = true;
        config.listenAddress.ipv4 = '0.0.0.0';
        config.enableServerPlugins = true;
        config.port = 9999;
        config.customPreference = 'retained';
        fs.writeFileSync(configPath, YAML.stringify(config));
        fs.mkdirSync(path.join(state, 'data'));
        fs.writeFileSync(path.join(state, 'data', 'user-chat'), 'keep me');
        result = launch('b'.repeat(64));
        assert.equal(result.status, 0, result.stderr);
        config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(config.listenAddress.ipv4, '127.0.0.1');
        assert.equal(config.protocol.ipv6, false);
        assert.equal(config.port, 28193);
        assert.equal(config.basicAuthMode, true);
        assert.equal(config.basicAuthUser.password, 'b'.repeat(64));
        assert.equal(config.enableServerPlugins, false);
        assert.equal(config.browserLaunch.enabled, false);
        assert.equal(config.customPreference, 'retained');
        assert.equal(config.dataRoot, path.join(fs.realpathSync(state), 'data'));
        assert.equal(fs.readFileSync(path.join(state, 'data', 'user-chat'), 'utf8'), 'keep me');
        const observed = JSON.parse(fs.readFileSync(path.join(state, 'observed.json'), 'utf8'));
        assert.equal(observed.ready.port, 28193);
        assert.equal(observed.supervised, '1');
        assert.equal(observed.ios, '1');
        assert.equal(observed.inbox, path.join(fs.realpathSync(state), 'import-inbox'));
        assert.equal(observed.busyWhileStarting, true);
        assert.equal(fs.existsSync(path.join(state, 'ios-ready.json')), false);
        assert.equal(fs.existsSync(path.join(state, 'ios-busy')), false);
        const previous = fs.readFileSync(configPath, 'utf8');
        assert.notEqual(launch('invalid').status, 0);
        assert.equal(fs.readFileSync(configPath, 'utf8'), previous);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an iOS server exit leaves a note the app shows on the next launch', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ios-exit-'));
    try {
        const state = bootstrapFixture(directory);
        fs.writeFileSync(path.join(directory, 'server.js'), 'throw new Error(\'Port 28193 is already in use.\');');
        let result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64)], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        const exit = JSON.parse(fs.readFileSync(path.join(state, 'ios-exit.json'), 'utf8'));
        assert.equal(exit.code, 1);
        assert.equal(exit.message, 'Port 28193 is already in use');
        assert.equal(fs.existsSync(path.join(state, 'ios-ready.json')), false);

        fs.rmSync(path.join(state, 'ios-exit.json'));
        fs.writeFileSync(path.join(directory, 'server.js'), `
            import { writeStartupNote } from './src/startup-note.js';
            writeStartupNote(new Error('The data folder is locked'));
            process.exit(1);
        `);
        result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64)], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'ios-exit.json'), 'utf8')).message, 'The data folder is locked');

        fs.rmSync(path.join(state, 'ios-exit.json'));
        fs.writeFileSync(path.join(directory, 'server.js'), '');
        result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64)], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(path.join(state, 'ios-exit.json')), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a damaged iOS settings file is set aside instead of stopping every launch', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ios-config-'));
    try {
        const state = bootstrapFixture(directory);
        fs.writeFileSync(path.join(directory, 'server.js'), '');
        fs.writeFileSync(path.join(state, 'ios-config.yaml'), 'performance: [unclosed');
        const result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64)], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /started with default settings/);
        const config = YAML.parse(fs.readFileSync(path.join(state, 'ios-config.yaml'), 'utf8'));
        assert.equal(config.port, 28193);
        assert.equal(fs.readdirSync(state).filter(name => name.startsWith('ios-config.yaml.broken-')).length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('iOS WKUIDelegate JavaScript dialogs require a local main frame, queue behind other sheets and complete once', () => {
    const controller = fs.readFileSync(path.join(root, 'ios/App/BrowserController.swift'), 'utf8');
    const dialogs = controller.slice(controller.indexOf('private func presentJavaScriptDialog'));
    assert.match(dialogs, /var completed = false[\s\S]*?guard !completed else \{ return \}[\s\S]*?completed = true[\s\S]*?completionHandler\(value\)/);
    assert.match(dialogs, /guard frame\.isMainFrame, isLocal\(frame\),[\s\S]*?viewIfLoaded\?\.window != nil else \{[\s\S]*?complete\(defaultValue\)[\s\S]*?return[\s\S]*?\}/);
    assert.match(dialogs, /configure\(alert, complete\)\s+enqueue\(alert\)/);
    assert.match(dialogs, /runJavaScriptAlertPanelWithMessage[\s\S]*?presentJavaScriptDialog\(message, in: webView, from: frame, defaultValue: \(\), completionHandler: \{ _ in completionHandler\(\) \}\)/);
    assert.match(dialogs, /runJavaScriptConfirmPanelWithMessage[\s\S]*?presentJavaScriptDialog\(message, in: webView, from: frame, defaultValue: false, completionHandler: completionHandler\)/);
    assert.match(dialogs, /runJavaScriptTextInputPanelWithPrompt[\s\S]*?presentJavaScriptDialog\(prompt, in: webView, from: frame, defaultValue: nil, completionHandler: completionHandler\)/);
    assert.deepEqual(dialogs.match(/\bcompletionHandler\([^)]*\)/g), ['completionHandler(value)', 'completionHandler()']);
    const queue = controller.slice(controller.indexOf('private func presentPending('), controller.indexOf('private func presentPendingSoon'));
    assert.match(queue, /UIAlertController/);
    assert.match(queue, /UIActivityViewController/);
});

test('iOS version keys stay within the three numbers iOS accepts', async () => {
    const { iosVersions } = await import('../scripts/ios-version.js');
    assert.deepEqual(iosVersions('2.7.0'), { marketingVersion: '2.7.0', buildNumber: '2070000' });
    assert.deepEqual(iosVersions('2.7.0.3'), { marketingVersion: '2.7.0', buildNumber: '2070003' });
    assert.ok(Number(iosVersions('2.7.0.3').buildNumber) > Number(iosVersions('2.7.0').buildNumber));
    assert.ok(Number(iosVersions('2.7.1').buildNumber) > Number(iosVersions('2.7.0.99').buildNumber));
    assert.throws(() => iosVersions('2.7'), /Unsupported/);
    assert.throws(() => iosVersions('2.7.0-beta'), /Unsupported/);
    assert.throws(() => iosVersions('2.100.0'), /above 99/);
    const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    assert.doesNotThrow(() => iosVersions(packageVersion));
    const verify = spawnSync('python3', ['-B', '-c', `import importlib.util,sys
spec = importlib.util.spec_from_file_location('v', 'scripts/verify-ios-build.py'); v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
print(','.join(v.ios_versions(sys.argv[1])))`, '2.7.0.3'], { cwd: root, encoding: 'utf8' });
    if (verify.error?.code !== 'ENOENT') assert.equal(verify.stdout.trim(), '2.7.0,2070003', verify.stderr);
});

test('the iOS app icon is an opaque 1024 pixel PNG', () => {
    const icon = fs.readFileSync(path.join(root, 'ios/AppIcon-1024.png'));
    assert.equal(icon.subarray(12, 16).toString('latin1'), 'IHDR');
    assert.equal(icon.readUInt32BE(16), 1024);
    assert.equal(icon.readUInt32BE(20), 1024);
    assert.equal(icon[25], 2, 'colour type 2 is RGB with no alpha channel');
    const builder = fs.readFileSync(path.join(root, 'scripts/build-ios-payload.js'), 'utf8');
    assert.match(builder, /ios\/AppIcon-1024\.png/);
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ios-build.yml'), 'utf8');
    assert.doesNotMatch(workflow, /sips -z/);
});

test('iOS native version is generated from package.json rather than hardcoded in project.yml', () => {
    const project = YAML.parse(fs.readFileSync(path.join(root, 'ios/project.yml'), 'utf8'));
    assert.equal(project.settings?.base?.MARKETING_VERSION, undefined);
    assert.equal(project.settings?.base?.CURRENT_PROJECT_VERSION, undefined);
    assert.deepEqual(project.configFiles, {
        Debug: 'generated/version.xcconfig',
        Release: 'generated/version.xcconfig',
    });
    assert.equal(project.targets?.Neconyan?.info?.properties?.CFBundleShortVersionString, '$(MARKETING_VERSION)');
    assert.equal(project.targets?.Neconyan?.info?.properties?.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
    const payloadBuilder = fs.readFileSync(path.join(root, 'scripts/build-ios-payload.js'), 'utf8');
    assert.match(payloadBuilder, /ios\/generated\/version\.xcconfig/);
    assert.match(payloadBuilder, /iosVersions\(provenance\.version\)/);
    assert.match(payloadBuilder, /MARKETING_VERSION = \$\{marketingVersion\}/);
    assert.match(payloadBuilder, /CURRENT_PROJECT_VERSION = \$\{buildNumber\}/);
    const verifier = fs.readFileSync(path.join(root, 'scripts/verify-ios-build.py'), 'utf8');
    assert.match(verifier, /marketing_version, build_number = ios_versions\(provenance\['version'\]\)/);
    assert.match(verifier, /info\['CFBundleShortVersionString'\] == marketing_version/);
    assert.match(verifier, /info\['CFBundleVersion'\] == build_number/);
});

test('the iOS lease policy is tied to the bootstrap, the Swift data path and the server start', () => {
    const bootstrap = fs.readFileSync(path.join(root, 'ios/server-bootstrap.mjs'), 'utf8');
    assert.match(bootstrap, /enableCompileCache\(compileCachePath\)/);
    assert.ok(bootstrap.includes('path.join(statePath, \'node-cache\')'));
    const marker = bootstrap.indexOf('process.env.NECONYAN_IOS_APP = \'1\'');
    assert.ok(marker > 0);
    assert.ok(marker < bootstrap.indexOf('await import(\'./server.js\')'));
    assert.ok(bootstrap.includes('dataRoot: path.join(statePath, \'data\')'));
    assert.ok(bootstrap.includes('fs.realpathSync(privatePath)'));
    const swift = fs.readFileSync(path.join(root, 'ios/App/LocalServer.swift'), 'utf8');
    assert.ok(swift.includes('.applicationSupportDirectory'));
    assert.ok(swift.includes('appendingPathComponent("Neconyan", isDirectory: true)'));
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(server.includes('let iosAppServer = false;'));
    assert.ok(server.indexOf('let iosAppServer = false;') < server.indexOf('try {'));
    assert.ok(server.includes('iosAppServer = isIosAppServer({ dataRoot: globalThis.DATA_ROOT });'));
    assert.ok(server.includes('acquireDataRootOwner(globalThis.DATA_ROOT, \'server\', { androidAppServer: isAndroidAppServer(), iosAppServer })'));
    assert.ok(server.includes('process.env.NECONYAN_ANDROID_APP !== \'1\' && !iosAppServer'));
});
