import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { serverEvents, EVENT_NAMES } from './src/server-events.js';
import { beginServerWork, configureServerWakeMarker } from './src/android-wake.js';
import { loadBootstrapConfig, setAsideNotice } from './bootstrap-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const [privatePath, port, password] = process.argv.slice(2);
if (!privatePath || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || !/^[a-f0-9]{64}$/.test(password)) {
    throw new Error('Invalid private iOS launch configuration.');
}
const statePath = fs.realpathSync(privatePath);
// Node runs inside the app process, so any exit closes the whole app. The app reads this
// file on the next launch to explain what happened instead of silently starting again.
const exitPath = path.join(statePath, 'ios-exit.json');
const notePath = path.join(statePath, 'ios-startup-note.txt');
fs.rmSync(notePath, { force: true });
process.env.NECONYAN_STARTUP_NOTE_FILE = notePath;
let lastFailure = '';
const describe = error => String(error?.message ?? error).trim().replace(/\.$/, '').slice(0, 400);
process.on('uncaughtExceptionMonitor', error => { lastFailure = describe(error); });
process.once('exit', code => {
    if (code === 0) return;
    let message = lastFailure;
    if (!message) {
        try {
            message = describe(fs.readFileSync(notePath, 'utf8').replace(/^Could not start Neconyan:\s*/, '').replace(/\s*Saved data has been kept\.$/, ''));
        } catch { /* No note: the code alone still explains that the server stopped. */ }
    }
    try {
        writeFileAtomicSync(exitPath, JSON.stringify({ code, message, at: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* The private server log still has the failure. */ }
});
const configPath = path.join(statePath, 'ios-config.yaml');
// An old saved file gains the sections written below; a damaged one is set aside so it
// cannot stop every launch.
const { config, setAside, reason } = loadBootstrapConfig(configPath, path.join(root, 'default/config.yaml'));
if (setAside) console.warn(`${setAsideNotice(setAside)} Reason: ${reason}`);
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
writeFileAtomicSync(configPath, YAML.stringify(config), { mode: 0o600 });
process.env.NECONYAN_SUPERVISED = '1';
process.env.NECONYAN_IOS_APP = '1';
process.env.NECONYAN_NATIVE_NOTIFICATION_FILE = path.join(statePath, 'native-notifications.json');
// The app moves ZIPs picked in its own file picker here, so big imports skip the browser upload.
process.env.NECONYAN_LOCAL_IMPORT_DIR = path.join(statePath, 'import-inbox');
process.argv = [process.argv[0], path.join(root, 'server.js'), '--configPath', configPath];
const readyPath = path.join(statePath, 'ios-ready.json');
fs.rmSync(readyPath, { force: true });
// The app keeps running in the background only while this marker exists; starting up counts as work.
configureServerWakeMarker(path.join(statePath, 'ios-busy'));
const endStartup = beginServerWork();
serverEvents.once(EVENT_NAMES.SERVER_STARTED, () => {
    endStartup();
    writeFileAtomicSync(readyPath, JSON.stringify({ pid: process.pid, port: Number(port) }), { mode: 0o600 });
});
process.once('exit', () => {
    fs.rmSync(readyPath, { force: true });
    configureServerWakeMarker(null);
});
await import('./server.js');
