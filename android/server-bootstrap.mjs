import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { serverEvents, EVENT_NAMES } from './src/server-events.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const [privatePath, port, password] = process.argv.slice(2);
if (!privatePath || !/^\d+$/.test(port) || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid private Android launch configuration.');
// Android's /data/user/0 alias must be resolved before strict storage checks.
const statePath = fs.realpathSync(privatePath);
if (process.platform === 'android') process.on('uncaughtExceptionMonitor', error => {
    try {
        writeFileAtomicSync(path.join(process.env.TMPDIR, 'startup-status.txt'), `Could not start Neconyan: ${error.message}. Saved data has been kept.`, { mode: 0o600 });
    } catch { /* The original error still reaches the private server log. */ }
});
if (process.platform === 'android') {
    const native = process._linkedBinding('neconyan_fs');
    const probe = fs.mkdtempSync(path.join(statePath, '.android-storage-check-'));
    try {
        const before = path.join(probe, 'before');
        const after = path.join(probe, 'after');
        fs.writeFileSync(before, 'storage-check');
        const identity = native.physical(before, false);
        if (!identity || identity.birthtimeNs === '0') throw new Error('This Android filesystem does not expose the creation times required for safe chat storage.');
        const original = fs.statSync(before, { bigint: true });
        fs.renameSync(before, after);
        const renamed = fs.statSync(after, { bigint: true });
        if (String(original.birthtimeNs) !== identity.birthtimeNs || original.birthtimeNs !== renamed.birthtimeNs || original.ino !== renamed.ino) {
            throw new Error('Android file identity verification failed. Saved data has been left untouched.');
        }
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
const configPath = path.join(statePath, 'android-config.yaml');
const config = YAML.parse(fs.readFileSync(fs.existsSync(configPath) ? configPath : path.join(root, 'default/config.yaml'), 'utf8'));
Object.assign(config, {
    dataRoot: path.join(statePath, 'data'), port: Number(port), listen: true,
    listenAddress: { ipv4: '127.0.0.1', ipv6: '::1' }, protocol: { ipv4: true, ipv6: false },
    basicAuthMode: true, basicAuthUser: { username: 'neconyan', password },
    perUserBasicAuth: false, enableUserAccounts: false,
    enableServerPlugins: false, enableServerPluginsAutoUpdate: false,
});
config.browserLaunch.enabled = false;
config.extensions.autoUpdate = false;
config.git.backend = 'builtin';
config.performance.frontendBuild.enabled = true;
config.logging.enableAccessLog = false;
fs.mkdirSync(statePath, { recursive: true });
writeFileAtomicSync(configPath, YAML.stringify(config), { mode: 0o600 });
process.env.NECONYAN_SUPERVISED = '1';
process.argv = [process.argv[0], path.join(root, 'server.js'), '--configPath', configPath];
const readyPath = path.join(statePath, 'android-ready.json');
serverEvents.once(EVENT_NAMES.SERVER_STARTED, () => {
    writeFileAtomicSync(readyPath, JSON.stringify({ pid: process.pid, port: Number(port) }), { mode: 0o600 });
});
process.once('exit', () => fs.rmSync(readyPath, { force: true }));
await import('./server.js');
