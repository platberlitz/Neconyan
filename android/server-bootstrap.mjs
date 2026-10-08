import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { serverEvents, EVENT_NAMES } from './src/server-events.js';
import { verifyAndroidStorage } from './file-stats.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const [privatePath, port, password, mode = 'normal'] = process.argv.slice(2);
if (!privatePath || !/^\d+$/.test(port) || !/^[a-f0-9]{64}$/.test(password) || !['normal', 'safe'].includes(mode)) throw new Error('Invalid private Android launch configuration.');
// Android's /data/user/0 alias must be resolved before strict storage checks.
const statePath = fs.realpathSync(privatePath);
let started = false;
// After startup the launcher watches the process itself; the server ignores some harmless
// stream errors, and a note written for those would make the launcher restart a healthy server.
if (process.platform === 'android') process.on('uncaughtExceptionMonitor', error => {
    if (started) return;
    try {
        writeFileAtomicSync(path.join(process.env.TMPDIR, 'startup-status.txt'), `Could not start Neconyan: ${error.message}. Saved data has been kept.`, { mode: 0o600 });
    } catch { /* The original error still reaches the private server log. */ }
});
if (process.platform === 'android') {
    const { creationTimes } = verifyAndroidStorage(statePath, process._linkedBinding('neconyan_fs'));
    if (!creationTimes) console.info('Android storage does not record file creation times; file identity uses device and inode numbers.');
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
if (mode === 'safe') process.env.NECONYAN_SAFE_START = '1';
process.argv = [process.argv[0], path.join(root, 'server.js'), '--configPath', configPath];
const readyPath = path.join(statePath, 'android-ready.json');
serverEvents.once(EVENT_NAMES.SERVER_STARTED, () => {
    started = true;
    writeFileAtomicSync(readyPath, JSON.stringify({ pid: process.pid, port: Number(port), safe: mode === 'safe' }), { mode: 0o600 });
});
process.once('exit', () => fs.rmSync(readyPath, { force: true }));
await import('./server.js');
