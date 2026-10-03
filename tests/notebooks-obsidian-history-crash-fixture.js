import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const { roleplayAccountBase, roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { recordObsidianFileLocked } = await import('../src/notebooks/obsidian-history.js');
const { directories, notebookId, file, phase } = JSON.parse(process.argv[2]);
const base = roleplayAccountBase(directories);
withRoleplayAccount(base, roleplayAccountStamp(base), lease => recordObsidianFileLocked(lease, notebookId,
    { ...file, bytes: Buffer.from(file.bytes, 'base64') }, { fault: current => { if (current === phase) process.kill(process.pid, 'SIGKILL'); } }));
throw new Error('The requested file-history crash point was not reached.');
