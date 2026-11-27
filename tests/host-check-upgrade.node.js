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

function withHostCheckVariable(t, value) {
    const previous = process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
    const restore = () => {
        if (previous === undefined) delete process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
        else process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED = previous;
    };
    if (value === undefined) delete process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
    else process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED = value;
    t.after(restore);
}

const fileState = file => ({ text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });

// A complete old config: today's template with host checking off and no marker, so nothing else
// is missing and any rewrite would come from the host check alone.
const FULL_OLD_CONFIG = (() => {
    const config = yaml.parse(fs.readFileSync(path.join(root, 'default', 'config.yaml'), 'utf8'));
    config.hostWhitelist.enabled = false;
    delete config.hostWhitelist.upgraded;
    return yaml.stringify(config);
})();

for (const value of ['false', 'true']) {
    test(`H7 while SILLYTAVERN_HOSTWHITELIST_ENABLED=${value} decides, an old config is left alone, marker and all, without rewriting it each start`, t => {
        withHostCheckVariable(t, value);
        const lines = quiet(t);

        const full = configFile(FULL_OLD_CONFIG);
        const before = fileState(full);
        addMissingConfigValues(full);
        addMissingConfigValues(full);
        assert.deepEqual(fileState(full), before, 'two starts leave the file as it was');
        assert.ok(!fs.existsSync(`${full}.before-host-check`));

        // A partial old file still gains its other missing values once, but never the marker.
        const partial = configFile(OLD_SECTION);
        addMissingConfigValues(partial);
        const config = readConfig(partial);
        assert.equal(config.hostWhitelist.enabled, false);
        assert.equal(Object.hasOwn(config.hostWhitelist, 'upgraded'), false);
        const settled = fileState(partial);
        addMissingConfigValues(partial);
        assert.deepEqual(fileState(partial), settled, 'the second start does not rewrite it');
        assert.ok(!lines.some(line => line.includes('Host checking is now on.')), lines.join('\n'));
    });
}

test('H13 once the variable is gone, the waiting one-time switch runs as on any old config', t => {
    withHostCheckVariable(t, 'false');
    quiet(t);
    const file = configFile(FULL_OLD_CONFIG);
    addMissingConfigValues(file);
    assert.equal(readConfig(file).hostWhitelist.enabled, false);

    delete process.env.SILLYTAVERN_HOSTWHITELIST_ENABLED;
    const lines = quiet(t);
    addMissingConfigValues(file);
    const config = readConfig(file);
    assert.equal(config.hostWhitelist.enabled, true);
    assert.equal(config.hostWhitelist.upgraded, true);
    assert.equal(fs.readFileSync(`${file}.before-host-check`, 'utf8'), FULL_OLD_CONFIG);
    assert.ok(lines.some(line => line.includes('Host checking is now on.')), lines.join('\n'));
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

test('H14 a read-only config.yaml is reported as not updated, with no claim that host checking is on', t => {
    const lines = quiet(t);
    const file = configFile(OLD_CONFIG);
    fs.chmodSync(file, 0o444);
    t.after(() => fs.chmodSync(file, 0o600));
    for (let start = 0; start < 2; start++) {
        addMissingConfigValues(file);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), OLD_CONFIG, 'the file is unchanged');
    assert.ok(!lines.some(line => line.includes('Host checking is now on.')), lines.join('\n'));
    assert.equal(lines.filter(line => line.includes(`Could not update ${file}, so host checking stays off:`)).length, 2, lines.join('\n'));
    assert.ok(!lines.some(line => line.includes('Could not add missing config values')), 'the plain message replaces the generic one');
    const copy = `${file}.before-host-check`;
    assert.ok(!fs.existsSync(copy), 'nothing was switched, so no copy is left beside the file');

    fs.writeFileSync(copy, 'an older copy\n');
    addMissingConfigValues(file);
    assert.equal(fs.readFileSync(copy, 'utf8'), 'an older copy\n', 'a copy that was already there is left alone');
    fs.rmSync(copy);

    fs.chmodSync(file, 0o600);
    addMissingConfigValues(file);
    assert.equal(readConfig(file).hostWhitelist.enabled, true, 'once the file can be written, the switch is made');
    assert.equal(fs.readFileSync(copy, 'utf8'), OLD_CONFIG);
});

test('H15 when the copy is made but its permissions cannot be copied, the copy is still named, not denied', t => {
    const lines = quiet(t);
    t.mock.method(fs, 'chmodSync', () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const file = configFile(OLD_SECTION);
    addMissingConfigValues(file);
    const copy = `${file}.before-host-check`;
    assert.equal(fs.readFileSync(copy, 'utf8'), OLD_SECTION);
    assert.ok(lines.some(line => line.includes(`Kept a copy of config.yaml in ${copy}, but could not give it the same permissions`)), lines.join('\n'));
    assert.ok(lines.some(line => line.startsWith('A copy of the file as it was before this change') && line.includes(copy)), lines.join('\n'));
    assert.ok(!lines.some(line => line.includes('Could not keep a copy')), lines.join('\n'));
    assert.equal(readConfig(file).hostWhitelist.enabled, true);
});

test('H16 when no copy can be kept, the switch still happens and no copy is claimed', t => {
    const lines = quiet(t);
    const directory = path.join(base, `locked-${++counter}`);
    fs.mkdirSync(directory);
    const file = path.join(directory, 'config.yaml');
    fs.writeFileSync(file, OLD_SECTION);
    fs.chmodSync(directory, 0o555);
    t.after(() => fs.chmodSync(directory, 0o755));
    addMissingConfigValues(file);
    assert.equal(fs.existsSync(`${file}.before-host-check`), false);
    assert.ok(lines.some(line => line.includes('Could not keep a copy of config.yaml before switching host checking on:')), lines.join('\n'));
    assert.ok(!lines.some(line => line.startsWith('A copy of the file')), lines.join('\n'));
    assert.equal(readConfig(file).hostWhitelist.enabled, true);
    assert.ok(lines.some(line => line.includes('Host checking is now on.')));
});

test('H17 the log says how to put the copy back without the switch happening again, and that advice holds', t => {
    const lines = quiet(t);
    const file = configFile(OLD_SECTION);
    addMissingConfigValues(file);
    const copy = `${file}.before-host-check`;
    assert.ok(lines.includes('To keep host checking off instead, set hostWhitelist.enabled back to false there. The file now records this switch, so it is not made again.'), lines.join('\n'));
    assert.ok(lines.includes('That copy does not record the switch: if you put it back in place of the file and want host checking to stay off, add upgraded: true under hostWhitelist in it, or set hostWhitelist.enabled to false in the current file instead.'), lines.join('\n'));
    assert.ok(!lines.some(line => line.includes('will not be repeated')));

    // Put back as it is, the copy is switched on again; with the line added, it stays off.
    fs.copyFileSync(copy, file);
    const again = quiet(t);
    addMissingConfigValues(file);
    assert.equal(readConfig(file).hostWhitelist.enabled, true);
    assert.ok(again.some(line => line.includes('Host checking is now on.')));

    fs.writeFileSync(file, fs.readFileSync(copy, 'utf8').replace('  hosts: []\n', '  hosts: []\n  upgraded: true\n'));
    const kept = quiet(t);
    addMissingConfigValues(file);
    assert.equal(readConfig(file).hostWhitelist.enabled, false);
    assert.ok(!kept.some(line => line.includes('Host checking is now on.')));
});

test('H18 the copy in the app folder stays out of git, so updates still see a clean copy, and out of Docker images', () => {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', 'config.yaml.before-host-check'], { cwd: root });
    assert.equal(ignored.status, 0, 'git ignores config.yaml.before-host-check in the app folder');
    const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
    assert.ok(dockerignore.includes('/config.yaml.before-host-check'), '.dockerignore leaves the copy out of the image');
    const tmpIgnored = spawnSync('git', ['check-ignore', '--no-index', '-q', '.config.yaml.4242.tmp'], { cwd: root });
    assert.equal(tmpIgnored.status, 0, 'git ignores a temporary file a crash left mid-write');
    assert.ok(dockerignore.includes('/.config.yaml.*.tmp'), '.dockerignore leaves that temporary file out of the image');
});

const noSpace = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
const leftoverTmp = directory => fs.readdirSync(directory).filter(name => name.endsWith('.tmp'));

test('H19 the switch replaces config.yaml whole or not at all, and a cut-short write keeps the only intact copy', async t => {
    const realWrite = fs.writeFileSync;

    await t.test('a full disk while writing the new file leaves config.yaml untouched, with nothing left behind', t => {
        const lines = quiet(t);
        const app = path.join(base, `full-${++counter}`);
        fs.mkdirSync(path.join(app, 'config'), { recursive: true });
        const real = path.join(app, 'config', 'config.yaml');
        fs.writeFileSync(real, OLD_CONFIG);
        fs.symlinkSync('./config/config.yaml', path.join(app, 'config.yaml'));
        const before = fileState(real);
        t.mock.method(fs, 'writeFileSync', (file, data, options) => {
            if (String(file).endsWith('.tmp')) {
                realWrite(file, String(data).slice(0, 4096), options);
                throw noSpace();
            }
            return realWrite(file, data, options);
        });
        addMissingConfigValues(path.join(app, 'config.yaml'));
        assert.deepEqual(fileState(real), before, 'config.yaml is not touched');
        assert.ok(fs.lstatSync(path.join(app, 'config.yaml')).isSymbolicLink());
        assert.deepEqual(leftoverTmp(path.join(app, 'config')), [], 'the temporary file is cleaned up');
        assert.equal(fs.existsSync(`${real}.before-host-check`), false, 'the file is intact, so the copy made for it goes');
        assert.ok(lines.some(line => line.includes(`Could not update ${real}, so host checking stays off:`) && line.includes('ENOSPC')), lines.join('\n'));
        assert.ok(!lines.some(line => line.includes('Host checking is now on.') || line.includes('partially')), lines.join('\n'));
    });

    await t.test('where it has to write in place and that is cut short, the copy stays and the log does not claim checking is off', t => {
        const lines = quiet(t);
        const file = configFile(OLD_CONFIG);
        const copy = `${file}.before-host-check`;
        // A single-file bind mount cannot be renamed over.
        t.mock.method(fs, 'renameSync', () => {
            throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
        });
        t.mock.method(fs, 'writeFileSync', (target, data, options) => {
            if (target === file) {
                realWrite(target, String(data).slice(0, -1), options);
                throw noSpace();
            }
            return realWrite(target, data, options);
        });
        addMissingConfigValues(file);
        assert.notEqual(fs.readFileSync(file, 'utf8'), OLD_CONFIG, 'the in-place write got partway');
        assert.equal(readConfig(file).hostWhitelist.enabled, true, 'which is why claiming checking stayed off would be wrong');
        assert.equal(fs.readFileSync(copy, 'utf8'), OLD_CONFIG, 'the only intact copy is kept');
        assert.deepEqual(leftoverTmp(path.dirname(file)), []);
        assert.ok(lines.some(line => line.includes(`Could not finish writing ${file}, so it may only have been partially written:`) && line.includes('ENOSPC')), lines.join('\n'));
        assert.ok(lines.some(line => line.includes(`The file as it was before, comments included, is kept in ${copy}.`)), lines.join('\n'));
        assert.ok(!lines.some(line => line.includes('stays off') || line.includes('Host checking is now on.')), lines.join('\n'));
    });

    await t.test('where it cannot rename, a whole write in place still makes the switch', t => {
        const lines = quiet(t);
        const file = configFile(OLD_SECTION);
        t.mock.method(fs, 'renameSync', () => {
            throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
        });
        addMissingConfigValues(file);
        assert.equal(readConfig(file).hostWhitelist.enabled, true);
        assert.equal(fs.readFileSync(`${file}.before-host-check`, 'utf8'), OLD_SECTION);
        assert.deepEqual(leftoverTmp(path.dirname(file)), []);
        assert.ok(lines.some(line => line.includes('Host checking is now on.')), lines.join('\n'));
    });

    await t.test('the new file replaces the old one by rename and keeps its permissions', t => {
        quiet(t);
        const file = configFile(OLD_SECTION);
        fs.chmodSync(file, 0o640);
        const inode = fs.statSync(file).ino;
        addMissingConfigValues(file);
        assert.equal(readConfig(file).hostWhitelist.enabled, true);
        assert.notEqual(fs.statSync(file).ino, inode, 'a new file was renamed into place');
        assert.equal(fs.statSync(file).mode & 0o777, 0o640);
        assert.deepEqual(leftoverTmp(path.dirname(file)), []);
    });
});
