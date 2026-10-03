import { fork } from 'node:child_process';

const input = JSON.parse(process.argv[2]);
const child = fork(new URL('../src/notebooks/obsidian-client-runner.js', import.meta.url), [
    Buffer.from(JSON.stringify({ ...input, parentPid: process.pid })).toString('base64'),
], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', message => process.send?.(message));
child.once('error', () => process.exit(1));
child.once('close', () => process.exit(0));
