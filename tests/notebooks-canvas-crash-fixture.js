import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const { roleplayAccountBase, roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');
const canvas = await import('../src/notebooks/canvas-store.js');
const { directories, input, phase, kind } = JSON.parse(process.argv[2]);
const base = roleplayAccountBase(directories);
const stamp = roleplayAccountStamp(base);
const options = { fault: current => { if (current === phase) process.kill(process.pid, 'SIGKILL'); } };
withRoleplayAccount(base, stamp, lease => kind === 'update'
    ? canvas.updateCanvasLocked(lease, input, options) : canvas.createCanvasLocked(lease, input, options));
throw new Error('The requested canvas crash point was not reached.');
