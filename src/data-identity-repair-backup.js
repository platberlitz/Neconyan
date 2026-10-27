import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirectorySync } from './util.js';

function fail(message) {
    return Object.assign(new Error(message), { code: 'DATA_IDENTITY_BACKUP_FAILED' });
}

function resolveRelative(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw fail('The backup inventory has an invalid path.');
    }
    const target = path.join(root, ...relative.split('/'));
    const check = path.relative(root, target);
    if (!check || check === '..' || check.startsWith('..' + path.sep) || path.isAbsolute(check)) throw fail('The backup path leaves its folder.');
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('A backup root is unsafe.');
    let parent = root;
    for (const component of relative.split('/').slice(0, -1)) {
        parent = path.join(parent, component);
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('A backup parent is unsafe.');
    }
    return target;
}

function statMatches(stat, item) {
    return stat.isFile() && stat.nlink === 1n && String(stat.dev) === item.dev && String(stat.ino) === item.ino
        && String(stat.size) === item.size && String(stat.mode) === item.mode
        && String(stat.mtimeNs) === item.mtimeNs && String(stat.ctimeNs) === item.ctimeNs;
}

function hashFile(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw fail('A backup file is unsafe.');
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
        const after = fs.fstatSync(fd, { bigint: true });
        const current = fs.lstatSync(filename, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n
            || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== after.dev || current.ino !== after.ino
            || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw fail('A backup changed during verification.');
        return { hash: hash.digest('hex'), size: String(after.size) };
    } finally { fs.closeSync(fd); }
}

function copyFile(source, destination, item) {
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let targetFd;
    try {
        const before = fs.fstatSync(sourceFd, { bigint: true });
        const sourcePath = fs.lstatSync(source, { bigint: true });
        if (!statMatches(before, item) || !statMatches(sourcePath, item) || sourcePath.isSymbolicLink()) throw fail(`A source file changed: ${item.relative}`);
        targetFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let count;
        while ((count = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, count));
            let written = 0;
            while (written < count) {
                const amount = fs.writeSync(targetFd, buffer, written, count - written);
                if (!amount) throw fail(`A backup could not be written: ${item.relative}`);
                written += amount;
            }
        }
        fs.fsyncSync(targetFd);
        const after = fs.fstatSync(sourceFd, { bigint: true });
        const afterPath = fs.lstatSync(source, { bigint: true });
        if (!statMatches(after, item) || !statMatches(afterPath, item) || afterPath.isSymbolicLink()
            || hash.digest('hex') !== item.hash) throw fail(`A source file changed during backup: ${item.relative}`);
    } finally {
        if (targetFd !== undefined) fs.closeSync(targetFd);
        fs.closeSync(sourceFd);
    }
    const verified = hashFile(destination);
    if (verified.hash !== item.hash || verified.size !== item.size) throw fail(`A backup did not verify: ${item.relative}`);
    fsyncDirectorySync(path.dirname(destination));
}

/** Back up an already reviewed inventory without following links or replacing existing files. */
export function createIdentityRepairBackup(root, backupParent, operationId, inventory) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) throw fail('Invalid repair operation.');
    const destination = path.join(backupParent, `neconyan-identity-${operationId}`);
    fs.mkdirSync(destination, { mode: 0o700 });
    fsyncDirectorySync(backupParent);
    const filesRoot = path.join(destination, 'files');
    fs.mkdirSync(filesRoot, { mode: 0o700 });
    fsyncDirectorySync(destination);
    for (const directory of inventory.directories) {
        if (!directory.relative) continue;
        const target = resolveRelative(filesRoot, directory.relative);
        fs.mkdirSync(target, { mode: 0o700 });
        fsyncDirectorySync(path.dirname(target));
    }
    for (const item of inventory.files) copyFile(resolveRelative(root, item.relative), resolveRelative(filesRoot, item.relative), item);
    const manifest = { version: 1, operationId, files: inventory.files.map(({ relative, size, hash }) => ({ relative, size, hash })),
        directories: inventory.directories.map(({ relative }) => relative), excluded: inventory.excluded };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const filename = path.join(destination, 'neconyan-backup-manifest.json');
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectorySync(destination);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hashFile(filename).hash !== hash) throw fail('The backup manifest did not verify.');
    return { destination, manifestHash: hash };
}

/** Re-verify the independent backup before a transaction is resumed or completed. */
export function verifyIdentityRepairBackup(destination, expectedHash) {
    const directory = fs.lstatSync(destination);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw fail('The backup folder is unsafe.');
    const manifestPath = path.join(destination, 'neconyan-backup-manifest.json');
    const fd = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let bytes;
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw fail('The backup manifest is unsafe.');
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        const current = fs.lstatSync(manifestPath, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.isSymbolicLink()
            || current.dev !== after.dev || current.ino !== after.ino || crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
            throw fail('The backup manifest changed.');
        }
    } finally { fs.closeSync(fd); }
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.directories) || !Array.isArray(value.excluded)) throw fail('The backup manifest is invalid.');
    const filesRoot = path.join(destination, 'files');
    const foundFiles = [];
    const foundDirectories = [];
    function walk(directory, relative) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('A backup directory is unsafe.');
        foundDirectories.push(relative);
        for (const name of fs.readdirSync(directory).sort()) {
            const next = relative ? `${relative}/${name}` : name;
            const filename = path.join(directory, name);
            const item = fs.lstatSync(filename);
            if (item.isSymbolicLink()) throw fail('A backup contains a symbolic link.');
            if (item.isDirectory()) walk(filename, next);
            else if (item.isFile()) foundFiles.push(next);
            else throw fail('A backup contains a special file.');
        }
    }
    walk(filesRoot, '');
    const expectedFiles = value.files.map(item => item.relative).sort();
    const expectedDirectories = [...value.directories].sort();
    if (new Set(expectedFiles).size !== expectedFiles.length || new Set(expectedDirectories).size !== expectedDirectories.length
        || JSON.stringify(foundFiles.sort()) !== JSON.stringify(expectedFiles)
        || JSON.stringify(foundDirectories.sort()) !== JSON.stringify(expectedDirectories)) throw fail('The backup files or directories changed.');
    for (const item of value.files) {
        if (!/^[a-f0-9]{64}$/.test(item.hash) || !/^\d+$/.test(item.size)) throw fail('A backup manifest entry is invalid.');
        const actual = hashFile(resolveRelative(filesRoot, item.relative));
        if (actual.hash !== item.hash || actual.size !== item.size) throw fail(`A backup file changed: ${item.relative}`);
    }
    return value;
}
