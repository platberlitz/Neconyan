// This trusted supervisor owns the folder lock for exactly one prepared client.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
let release;
let client;
let stopping = false;
let watchdog;
const send = message => { if (process.connected) process.send(message); };
function folderMatches() {
    try {
        const stat = fs.lstatSync(input.folder);
        return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === input.physical.dev && stat.ino === input.physical.ino && fs.realpathSync(input.folder) === input.folder;
    } catch { return false; }
}
function finish() {
    clearInterval(watchdog);
    try { release?.(); } catch { /* A replaced lock is not ours to remove. */ }
    process.exit(0);
}
function stop() {
    if (stopping) return;
    stopping = true;
    if (!client || client.exitCode !== null || client.signalCode !== null) return finish();
    client.kill('SIGTERM');
    const timer = setTimeout(() => { client?.kill('SIGKILL'); }, 3000);
    timer.unref();
}
process.on('message', message => { if (message?.type === 'stop') stop(); });
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
    if (!folderMatches()) throw new Error('The approved folder changed.');
    release = lockfile.lockSync(input.folder, { realpath: false, retries: 0, stale: 10000, update: 2000 });
    const environment = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    watchdog = setInterval(() => {
        let parentPresent = true;
        try { process.kill(input.parentPid, 0); } catch { parentPresent = false; }
        if (!parentPresent || !folderMatches()) stop();
    }, 250);
    const configured = await new Promise(resolve => {
        const check = spawn(input.executable, ['sync-status', '--path', input.folder, '--json'], { cwd: input.folder, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        client = check;
        let size = 0;
        const drain = bytes => { size += bytes.length; if (size > 65536) stop(); };
        check.stdout.on('data', drain);
        check.stderr.on('data', drain);
        const timer = setTimeout(stop, 15000);
        check.once('error', () => { clearTimeout(timer); resolve(false); });
        check.once('close', code => { clearTimeout(timer); resolve(code === 0 && size <= 65536 && !stopping); });
    });
    if (!configured || stopping || !folderMatches()) {
        send({ type: 'failed', code: 'OBSIDIAN_NOT_PREPARED' });
        finish();
    }
    client = spawn(input.executable, ['sync', '--path', input.folder, '--continuous'], { cwd: input.folder, env: environment, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    client.once('spawn', () => send({ type: 'ready', clientPid: client.pid }));
    client.once('error', () => { send({ type: 'failed', code: 'OBSIDIAN_CLIENT_FAILED' }); finish(); });
    client.once('close', code => { send({ type: 'stopped', code }); finish(); });
} catch (error) {
    send({ type: 'failed', code: error.code === 'ELOCKED' ? 'OBSIDIAN_FOLDER_BUSY' : 'OBSIDIAN_CLIENT_FAILED' });
    finish();
}
