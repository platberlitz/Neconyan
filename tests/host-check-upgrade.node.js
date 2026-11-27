import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

import { addMissingConfigValues } from '../src/config-init.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-host-check-upgrade-')));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
function configFile(text) {
    const file = path.join(base, `config-${++counter}.yaml`);
    if (text !== undefined) fs.writeFileSync(file, text);
    return file;
}
const readConfig = file => yaml.parse(fs.readFileSync(file, 'utf8'));
const quiet = t => {
    const lines = [];
    t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
    t.mock.method(console, 'log', () => {});
    return lines;
};

// The section exactly as the 1.5.7 template shipped it.
const OLD_SECTION = 'hostWhitelist:\n  # Enable or disable host whitelisting\n  enabled: false\n  scan: true\n  hosts: []\n';

test('H1 a config saved with the old default has host checking switched on once, with its hosts kept', t => {
    const lines = quiet(t);
    const file = configFile(OLD_SECTION.replace('hosts: []', 'hosts:\n    - st.example.test'));
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    assert.deepEqual(config.hostWhitelist.hosts, ['st.example.test']);
    assert.ok(lines.some(line => line.includes('Host checking is now on.')), lines.join('\n'));
    assert.ok(lines.some(line => line.includes(file)), 'the log names the config file');
});

test('H2 after the switch, turning it off again sticks', t => {
    quiet(t);
    const file = configFile(OLD_SECTION);
    addMissingConfigValues(file);
    const config = readConfig(file);
    config.hostWhitelist.enabled = false;
    fs.writeFileSync(file, yaml.stringify(config));
    const lines = quiet(t);
    addMissingConfigValues(file);
    assert.equal(readConfig(file).hostWhitelist.enabled, false);
    assert.ok(!lines.some(line => line.includes('Host checking is now on.')));
});

test('H3 a new install gets the template, which already carries the marker', t => {
    quiet(t);
    const file = configFile();
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    const template = yaml.parse(fs.readFileSync(path.join(root, 'default', 'config.yaml'), 'utf8'));
    assert.equal(template.hostWhitelist.upgraded, true);
    assert.equal(template.hostWhitelist.enabled, true);
});

test('H4 a config that already had checking on just gains the marker', t => {
    const lines = quiet(t);
    const file = configFile('hostWhitelist:\n  enabled: true\n  scan: true\n  hosts: []\n');
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    assert.ok(!lines.some(line => line.includes('Host checking is now on.')));
});

test('H5 a config with no host section gets the default, which is on', t => {
    quiet(t);
    const file = configFile('port: 8000\n');
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
});

test('H6 a custom browser launch hostname is added to the list, so the server does not block the page it opens', t => {
    const lines = quiet(t);
    const file = configFile(`browserLaunch:\n  hostname: St.Example.test\n${OLD_SECTION}`);
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.deepEqual(config.hostWhitelist.hosts, ['st.example.test']);
    assert.ok(lines.some(line => line.includes('st.example.test')));

    for (const [hostname, hosts] of [['auto', []], ['localhost', []], ['127.0.0.1', []], ['[::1]', []], ['nas.local', ['nas.local']]]) {
        const other = configFile(`browserLaunch:\n  hostname: '${hostname}'\n${OLD_SECTION.replace('hosts: []', 'hosts: []')}`);
        addMissingConfigValues(other);
        assert.deepEqual(readConfig(other).hostWhitelist.hosts, hosts, hostname);
    }

    const listed = configFile(`browserLaunch:\n  hostname: st.example.test\n${OLD_SECTION.replace('hosts: []', 'hosts:\n    - ST.example.test')}`);
    addMissingConfigValues(listed);
    assert.deepEqual(readConfig(listed).hostWhitelist.hosts, ['ST.example.test']);
});

test('H7 when the environment sets hostWhitelist.enabled, the file value is left alone', t => {
    quiet(t);
    const previous = process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
    process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED = 'false';
    t.after(() => {
        if (previous === undefined) delete process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
        else process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED = previous;
    });
    const file = configFile(OLD_SECTION);
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, false);
    assert.equal(config.hostWhitelist.upgraded, true);
});

test('H8 before the one-time rewrite, a copy of the file with its comments is kept beside it, once, and named in the log', t => {
    const lines = quiet(t);
    const original = `# my own notes\nport: 8000\n${OLD_SECTION}`;
    const file = configFile(original);
    fs.chmodSync(file, 0o600);
    addMissingConfigValues(file);
    const copy = `${file}.before-host-check`;
    assert.equal(fs.readFileSync(copy, 'utf8'), original);
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600, 'the copy is as private as the file');
    assert.ok(lines.some(line => line.includes(copy)), lines.join('\n'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('# my own notes'), 'the rewrite itself drops comments');

    // Later starts, and a later switch on another copy of the old file, leave the copy alone.
    fs.writeFileSync(file, original.replace('my own notes', 'edited later'));
    addMissingConfigValues(file);
    assert.equal(fs.readFileSync(copy, 'utf8'), original);

    const untouched = configFile('hostWhitelist:\n  enabled: true\n  hosts: []\n');
    addMissingConfigValues(untouched);
    assert.ok(!fs.existsSync(`${untouched}.before-host-check`), 'no copy when nothing is switched on');
});

test('H9 Docker: config.yaml is a symlink into the config volume, so the copy goes beside the real file and the link stays', t => {
    const lines = quiet(t);
    const app = path.join(base, `docker-${++counter}`);
    fs.mkdirSync(path.join(app, 'config'), { recursive: true });
    fs.writeFileSync(path.join(app, 'config', 'config.yaml'), OLD_SECTION);
    fs.symlinkSync('./config/config.yaml', path.join(app, 'config.yaml'));
    addMissingConfigValues(path.join(app, 'config.yaml'));
    assert.ok(fs.lstatSync(path.join(app, 'config.yaml')).isSymbolicLink());
    assert.equal(readConfig(path.join(app, 'config', 'config.yaml')).hostWhitelist.enabled, true);
    assert.equal(fs.readFileSync(path.join(app, 'config', 'config.yaml.before-host-check'), 'utf8'), OLD_SECTION);
    assert.ok(!fs.existsSync(path.join(app, 'config.yaml.before-host-check')));
    assert.ok(lines.some(line => line.includes(path.join(app, 'config', 'config.yaml.before-host-check'))));
    assert.ok(lines.some(line => line.includes(`hosts in ${path.join(app, 'config', 'config.yaml')} and restart`)), 'the log names the file in the volume, not the link');
});

// Saved configs as 1.5.7 wrote them, with host checking off and no marker: its template (desktop
// and Docker), and the files its Android and iPhone bootstraps wrote on first launch (only the
// data folder path is replaced).
const fixture = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', name), 'utf8');
const OLD_CONFIG = fixture('config-1.5.7.yaml');

// Stands in for server.js: keeps the config exactly as the bootstrap handed it over, then runs the
// real start-up config step the way server.js does (src/command-line.js calls initConfig).
const SERVER_STUB = `
import fs from 'node:fs';
import { initConfig } from ${JSON.stringify(path.join(root, 'src', 'config-init.js'))};
const configPath = process.argv[process.argv.indexOf('--configPath') + 1];
fs.copyFileSync(configPath, configPath + '.as-handed-to-server');
initConfig(configPath);
`;

function stageAppRoot(name, files) {
    const directory = path.join(base, `${name}-${++counter}`);
    const state = path.join(directory, 'private');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(directory, 'src'));
    fs.mkdirSync(path.join(directory, 'default'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    for (const [from, to] of files) fs.copyFileSync(path.join(root, from), path.join(directory, to));
    // The template the bootstraps fall back to carries the marker; it must not reach a saved config.
    fs.copyFileSync(path.join(root, 'default', 'config.yaml'), path.join(directory, 'default', 'config.yaml'));
    fs.writeFileSync(path.join(directory, 'server.js'), SERVER_STUB);
    return { directory, state };
}

function assertSwitchedOnByServer(configPath, result) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const handed = yaml.parse(fs.readFileSync(`${configPath}.as-handed-to-server`, 'utf8'));
    assert.equal(handed.hostWhitelist.enabled, false, 'the bootstrap hands the saved value to the server unchanged');
    assert.equal(_has(handed, 'upgraded'), false, 'the bootstrap does not merge the template marker in');
    const config = readConfig(configPath);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    assert.equal(fs.readFileSync(`${configPath}.before-host-check`, 'utf8'), fs.readFileSync(`${configPath}.as-handed-to-server`, 'utf8'));
    assert.match(result.stdout + result.stderr, /Host checking is now on\./);
}
const _has = (config, key) => Object.hasOwn(config.hostWhitelist ?? {}, key);

test('H10 Android: a 1.5.7 saved config passes through the real bootstrap untouched and is switched on by the server once', () => {
    const { directory, state } = stageAppRoot('android', [
        ['android/server-bootstrap.mjs', 'server-bootstrap.mjs'],
        ['android/bootstrap-config.mjs', 'bootstrap-config.mjs'],
        ['android/file-stats.mjs', 'file-stats.mjs'],
        ['src/android-config-policy.js', 'src/android-config-policy.js'],
        ['src/server-events.js', 'src/server-events.js'],
        ['src/android-wake.js', 'src/android-wake.js'],
        ['src/startup-note.js', 'src/startup-note.js'],
    ]);
    fs.writeFileSync(path.join(directory, 'src/crash-diagnostics.js'), 'export function initialiseCrashDiagnostics() {} export function installCrashHandlers() {}');
    const configPath = path.join(state, 'android-config.yaml');
    fs.writeFileSync(configPath, fixture('android-config-1.5.7.yaml'));
    const launch = () => spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28193', 'a'.repeat(64), 'normal', directory], { encoding: 'utf8' });
    assertSwitchedOnByServer(configPath, launch());
    assert.deepEqual(fs.readdirSync(state).filter(name => name.includes('.broken-')), [], 'the saved file was used, not set aside');

    const off = readConfig(configPath);
    off.hostWhitelist.enabled = false;
    fs.writeFileSync(configPath, yaml.stringify(off));
    const again = launch();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readConfig(configPath).hostWhitelist.enabled, false, 'switching it off again sticks');
    assert.doesNotMatch(again.stdout + again.stderr, /Host checking is now on\./);
});

test('H11 iPhone: a 1.5.7 saved config passes through the real bootstrap untouched and is switched on by the server once', () => {
    const { directory, state } = stageAppRoot('ios', [
        ['ios/server-bootstrap.mjs', 'server-bootstrap.mjs'],
        ['android/bootstrap-config.mjs', 'bootstrap-config.mjs'],
        ['src/android-wake.js', 'src/android-wake.js'],
        ['src/startup-note.js', 'src/startup-note.js'],
        ['src/server-events.js', 'src/server-events.js'],
    ]);
    const configPath = path.join(state, 'ios-config.yaml');
    fs.writeFileSync(configPath, fixture('ios-config-1.5.7.yaml'));
    const result = spawnSync(process.execPath, [path.join(directory, 'server-bootstrap.mjs'), state, '28194', 'b'.repeat(64)], { encoding: 'utf8' });
    assertSwitchedOnByServer(configPath, result);
    assert.deepEqual(fs.readdirSync(state).filter(name => name.includes('.broken-')), [], 'the saved file was used, not set aside');
});

test('H12 Docker: the real entrypoint keeps an existing config in the volume and its init step switches it on once', () => {
    const app = path.join(base, `docker-entrypoint-${++counter}`);
    const shims = path.join(app, '.shims');
    fs.mkdirSync(path.join(app, 'config'), { recursive: true });
    fs.mkdirSync(path.join(app, 'default'));
    fs.mkdirSync(shims);
    fs.copyFileSync(path.join(root, 'default', 'config.yaml'), path.join(app, 'default', 'config.yaml'));
    fs.writeFileSync(path.join(app, 'config', 'config.yaml'), OLD_CONFIG);
    fs.symlinkSync('./config/config.yaml', path.join(app, 'config.yaml'));
    // bun is not needed here: 'bun run init' runs src/server-init.js, whose config step is
    // addMissingConfigValues on <app>/config.yaml, and 'bun server.js' runs initConfig on it.
    const configInit = JSON.stringify(path.join(root, 'src', 'config-init.js'));
    fs.writeFileSync(path.join(shims, 'bun'), `#!/bin/sh
case "$1 $2" in
  "run init") exec "${process.execPath}" --input-type=module -e "import { addMissingConfigValues } from ${configInit.replace(/"/g, '\\"')}; addMissingConfigValues(process.cwd() + '/config.yaml');" ;;
  "server.js --listen") exec "${process.execPath}" --input-type=module -e "import { initConfig } from ${configInit.replace(/"/g, '\\"')}; initConfig(process.cwd() + '/config.yaml');" ;;
esac
echo "unexpected bun call: $*" >&2
exit 1
`, { mode: 0o755 });
    const run = () => spawnSync('sh', [path.join(root, 'docker', 'docker-entrypoint.sh')], {
        cwd: app,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
    });
    const result = run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /copying from defaults/, 'an existing config is kept');
    assert.ok(fs.lstatSync(path.join(app, 'config.yaml')).isSymbolicLink());
    const config = readConfig(path.join(app, 'config', 'config.yaml'));
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    assert.equal(fs.readFileSync(path.join(app, 'config', 'config.yaml.before-host-check'), 'utf8'), OLD_CONFIG);
    assert.equal(result.stdout.split('Host checking is now on.').length - 1 + result.stderr.split('Host checking is now on.').length - 1, 1, 'init switches it, the server start that follows does not repeat it');
});
