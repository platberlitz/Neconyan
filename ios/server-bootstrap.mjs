import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { serverEvents, EVENT_NAMES } from './src/server-events.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const [privatePath, port, password] = process.argv.slice(2);
if (!privatePath || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || !/^[a-f0-9]{64}$/.test(password)) {
    throw new Error('Invalid private iOS launch configuration.');
}
const statePath = fs.realpathSync(privatePath);
const configPath = path.join(statePath, 'ios-config.yaml');
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
writeFileAtomicSync(configPath, YAML.stringify(config), { mode: 0o600 });
process.env.NECONYAN_SUPERVISED = '1';
process.env.NECONYAN_IOS_APP = '1';
process.argv = [process.argv[0], path.join(root, 'server.js'), '--configPath', configPath];
const readyPath = path.join(statePath, 'ios-ready.json');
fs.rmSync(readyPath, { force: true });
serverEvents.once(EVENT_NAMES.SERVER_STARTED, () => {
    writeFileAtomicSync(readyPath, JSON.stringify({ pid: process.pid, port: Number(port) }), { mode: 0o600 });
});
process.once('exit', () => fs.rmSync(readyPath, { force: true }));
await import('./server.js');
