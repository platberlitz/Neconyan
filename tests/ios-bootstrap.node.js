import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
test('iOS launch isolates the listener and retains private settings across launches', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ios-bootstrap-'));
    try {
        const state = path.join(directory, 'private');
        fs.mkdirSync(state);
        fs.mkdirSync(path.join(directory, 'src'));
        fs.mkdirSync(path.join(directory, 'default'));
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
        fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
        fs.copyFileSync(path.join(root, 'ios/server-bootstrap.mjs'), path.join(directory, 'server-bootstrap.mjs'));
        fs.copyFileSync(path.join(root, 'default/config.yaml'), path.join(directory, 'default/config.yaml'));
        fs.copyFileSync(path.join(root, 'src/android-wake.js'), path.join(directory, 'src/android-wake.js'));
        fs.writeFileSync(path.join(directory, 'src/server-events.js'), 'import { EventEmitter } from \'node:events\'; export const serverEvents = new EventEmitter(); export const EVENT_NAMES = {SERVER_STARTED:\'started\'};');
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
        assert.equal(config.dataRoot, path.join(state, 'data'));
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

test('iOS WKUIDelegate JavaScript dialogs require a local main frame and complete once when presentation is unavailable', () => {
    const controller = fs.readFileSync(path.join(root, 'ios/App/BrowserController.swift'), 'utf8');
    const dialogs = controller.slice(controller.indexOf('private func presentJavaScriptDialog'));
    assert.match(dialogs, /var completed = false[\s\S]*?guard !completed else \{ return \}[\s\S]*?completed = true[\s\S]*?completionHandler\(value\)/);
    assert.match(dialogs, /guard frame\.isMainFrame, let source = frame\.request\.url, isLocal\(source\),[\s\S]*?!web\.isHidden, pickReply == nil, presentedViewController == nil,[\s\S]*?!isBeingPresented, !isBeingDismissed, viewIfLoaded\?\.window != nil else \{[\s\S]*?complete\(defaultValue\)[\s\S]*?return[\s\S]*?\}/);
    assert.match(dialogs, /present\(alert, animated: true\)\s+if presentedViewController !== alert \{ complete\(defaultValue\) \}/);
    assert.match(dialogs, /runJavaScriptAlertPanelWithMessage[\s\S]*?presentJavaScriptDialog\(message, from: frame, defaultValue: \(\), completionHandler: \{ _ in completionHandler\(\) \}\)/);
    assert.match(dialogs, /runJavaScriptConfirmPanelWithMessage[\s\S]*?presentJavaScriptDialog\(message, from: frame, defaultValue: false, completionHandler: completionHandler\)/);
    assert.match(dialogs, /runJavaScriptTextInputPanelWithPrompt[\s\S]*?presentJavaScriptDialog\(prompt, from: frame, defaultValue: nil, completionHandler: completionHandler\)/);
    assert.deepEqual(dialogs.match(/\bcompletionHandler\([^)]*\)/g), ['completionHandler(value)', 'completionHandler()']);
});
