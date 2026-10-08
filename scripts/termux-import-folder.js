import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const folderName = /^neconyan-import-[a-zA-Z0-9_-]+$/;
const recordName = /^[a-f0-9]{64}\.json$/;
const pinName = '.neconyan-import-folder';

export function checkRecoveryPort(port = 5534) {
    return new Promise((resolve, reject) => {
        const probe = createServer(socket => socket.destroy());
        probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
            ? `A server is already using port ${port}. Stop it before running the recovery launcher.`
            : `Could not check recovery port ${port}: ${error.message}`)));
        probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
    });
}

function directoryEntries(directory) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Recovery path is not a normal directory: ${directory}`);
    return fs.readdirSync(directory, { withFileTypes: true });
}

function readFile(filename, limit) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error(`Recovery file needs inspection: ${filename}`);
        return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
}

/** Locate evidence only; the server validates it before resuming any work. */
export function listRecoveryFolders(home = os.homedir()) {
    return directoryEntries(home).filter(entry => folderName.test(entry.name)).map(entry => {
        const directory = path.join(home, entry.name);
        directoryEntries(directory);
        const imports = [];
        const protectedRoot = path.join(directory, '_roleplay');
        for (const account of directoryEntries(protectedRoot).filter(item => /^[a-f0-9]{64}$/.test(item.name))) {
            const accountRoot = path.join(protectedRoot, account.name);
            directoryEntries(accountRoot);
            const records = path.join(accountRoot, 'operations');
            for (const file of directoryEntries(records).filter(item => recordName.test(item.name))) {
                const filename = path.join(records, file.name);
                let record;
                try { record = JSON.parse(readFile(filename, 64 * 1024 * 1024)); } catch {
                    throw new Error(`Could not inspect saved work: ${filename}. Nothing was changed.`);
                }
                if (!record || typeof record !== 'object' || Array.isArray(record)) {
                    throw new Error(`Saved work metadata needs inspection: ${filename}. Nothing was changed.`);
                }
                if (record.kind !== 'account-import') continue;
                if (record.version !== 1 || typeof record.key !== 'string' || !record.key || record.key.length > 200
                    || !['preparing', 'accepted', 'completed', 'refused'].includes(record.state)
                    || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
                    throw new Error(`Saved import metadata needs inspection: ${filename}. Nothing was changed.`);
                }
                imports.push({ key: record.key, state: record.state, createdAt: record.createdAt });
            }
        }
        return { directory, imports };
    });
}

function validateFolder(home, directory) {
    if (path.dirname(directory) !== home || !folderName.test(path.basename(directory)) || !fs.existsSync(directory)) {
        throw new Error(`The saved recovery folder is missing or invalid: ${directory}. Nothing was created.`);
    }
    directoryEntries(directory);
    return directory;
}

/** Save one choice outside the installation, so reinstalling or restarting cannot replace it. */
export function selectRecoveryFolder(home = os.homedir(), { key, create = false } = {}) {
    home = path.resolve(home);
    const pin = path.join(home, pinName);
    let saved;
    try { saved = readFile(pin, 4096).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved !== undefined) {
        validateFolder(home, saved);
        if (key && !listRecoveryFolders(home).find(item => item.directory === saved)?.imports.some(item => item.key === key)) {
            throw new Error('The saved folder does not contain that import key. The existing selection was kept.');
        }
        return saved;
    }
    const folders = listRecoveryFolders(home);
    const matches = folders.filter(item => item.imports.some(record => !key || record.key === key));
    let selected;
    if (matches.length === 1) selected = matches[0].directory;
    else if (!key && folders.length === 1) selected = folders[0].directory;
    else if (!key && !folders.length && create) {
        selected = path.join(home, 'neconyan-import-recovery');
        fs.mkdirSync(selected, { mode: 0o700 });
    } else {
        throw new Error(`Could not identify one recovery folder. No data was changed.\n${JSON.stringify(folders, null, 2)}\nIf several folders have imports, use --key with the browser's pending import key.`);
    }
    validateFolder(home, selected);
    let fd;
    try {
        fd = fs.openSync(pin, 'wx', 0o600);
        fs.writeFileSync(fd, selected + '\n');
        fs.fsyncSync(fd);
    } catch (error) {
        if (error.code === 'EEXIST') return selectRecoveryFolder(home, { key });
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return selected;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        if (args.length && !(args.length === 1 && args[0] === '--new') && !(args.length === 2 && args[0] === '--key' && args[1])) {
            throw new Error('Usage: node termux-import-folder.js [--new | --key IMPORT_KEY]');
        }
        await checkRecoveryPort();
        console.log(selectRecoveryFolder(os.homedir(), { create: args[0] === '--new', key: args[0] === '--key' ? args[1] : undefined }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
