import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import archiver from 'archiver';
import { getUserDirectories } from '../users.js';
import { allowKeysExposure, SECRETS_FILE } from '../endpoints/secrets.js';
import { getConfigValue } from '../util.js';
import { inspectRoleplayFile, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';
import { BINARY_FILE_LIMIT, prepareBinaryOutput, openBinaryOutput, publishBinaryOutput } from './binary-files.js';

const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });

export function captureAccountBackup(base, account, input, { sourceBase, includeSecrets = allowKeysExposure } = {}) {
    if (!getConfigValue('backups.allowFullDataBackup', true, 'boolean')) throw operationError('Full account backups are disabled in configuration.', 403);
    const source = sourceBase || (input.handle && input.handle !== base.owner
        ? { owner: input.handle, directories: getUserDirectories(input.handle) } : base);
    return withRoleplayAccount(source, source.owner === base.owner ? account : null, (_lease, stamp) => {
        const files = []; let total = 0;
        const walk = (folder, depth) => {
            if (depth > 32 || files.length > 100000) throw operationError('This backup exceeds the saved file inventory capacity.', 413);
            inspectRoleplayFile(path.join(folder, '.backup-path-check'), 1);
            for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const filename = path.join(folder, entry.name);
                const relative = path.relative(source.directories.root, filename);
                // Disposable work ledgers are not portable account data. Their permanent proof stays outside this root.
                if (!depth && entry.name === 'jobs') continue;
                if (!includeSecrets && (relative === SECRETS_FILE || /^backups\/secrets_migration_.*\.json$/.test(relative))) continue;
                if (entry.isSymbolicLink()) throw operationError('This backup contains a linked source. Its files were kept.');
                if (entry.isDirectory()) walk(filename, depth + 1);
                else if (entry.isFile()) {
                    const file = inspectRoleplayFile(filename, BINARY_FILE_LIMIT);
                    if (!file) throw operationError('A backup source disappeared during capture.');
                    total += file.size;
                    if (total > BINARY_FILE_LIMIT) throw operationError('The account backup exceeds its saved output capacity.', 413);
                    files.push({ relative, size: file.size, rawHash: file.rawHash, physical: file.physical, mtime: fs.statSync(filename).mtimeMs });
                } else throw operationError('This backup contains a source that is not a regular file.');
            }
        };
        walk(source.directories.root, 0);
        const limit = Math.ceil(total * 1.05) + files.length * 1024 + 65536;
        if (limit > BINARY_FILE_LIMIT) throw operationError('The account backup exceeds its saved output capacity.', 413);
        return { source: { owner: source.owner, directories: source.directories, account: stamp }, files, limit, includeSecrets,
            fileName: `${source.owner}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` };
    });
}

function openSource(context, plan, item) {
    withOperation(context, () => {});
    return withRoleplayAccount(plan.source, plan.source.account, () => {
        const filename = path.join(plan.source.directories.root, item.relative);
        const file = inspectRoleplayFile(filename, BINARY_FILE_LIMIT);
        if (!file || file.rawHash !== item.rawHash || roleplayHash(file.physical) !== roleplayHash(item.physical)) throw operationError('A backup source changed after acceptance. The original files were kept.');
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd, { bigint: true });
        if (stat.nlink !== 1n || roleplayHash(physical(stat)) !== roleplayHash(item.physical)) {
            fs.closeSync(fd); throw operationError('A backup source changed before it was opened.');
        }
        return fd;
    });
}

export async function runAccountBackup(context, plan, dependencies = {}) {
    const prepared = prepareBinaryOutput(context, 'account-backup', plan.limit);
    const result = { fileName: plan.fileName, type: 'application/zip', files: plan.files.length, includeSecrets: plan.includeSecrets, handle: plan.source.owner };
    if (prepared.effect.publication || prepared.effect.state === 'done') return publishBinaryOutput(context, prepared, result, dependencies);
    const fd = openBinaryOutput(context, prepared);
    const output = fs.createWriteStream(prepared.filename, { fd, autoClose: true });
    const archive = archiver('zip', { zlib: { level: 6 } });
    const done = finished(output);
    done.catch(() => {});
    let failure;
    const fail = error => { failure ||= error; archive.abort(); output.destroy(error); };
    archive.on('error', fail);
    archive.on('warning', fail);
    const abort = () => fail(context.signal.reason instanceof Error ? context.signal.reason : new DOMException('The backup was stopped.', 'AbortError'));
    context.signal.addEventListener('abort', abort, { once: true });
    archive.on('data', () => { if (archive.pointer() > plan.limit) fail(operationError('The backup exceeded its reserved output capacity.', 413)); });
    archive.pipe(output);
    try {
        context.signal.throwIfAborted();
        for (let index = 0; index < plan.files.length; index++) {
            context.signal.throwIfAborted();
            if (failure) throw failure;
            const item = plan.files[index];
            const sourceFd = openSource(context, plan, item);
            const hash = createHash('sha256'); let bytes = 0;
            const source = fs.createReadStream(null, { fd: sourceFd, autoClose: true });
            const verify = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); },
                flush(callback) { callback(bytes === item.size && hash.digest('hex') === item.rawHash ? null : operationError('A backup source changed while it was read.')); } });
            source.on('error', error => verify.destroy(error));
            try {
                await new Promise((resolve, reject) => {
                    const cleanup = () => { archive.off('entry', complete); archive.off('error', rejectEntry); output.off('error', rejectEntry); verify.off('error', rejectEntry); };
                    const complete = () => { cleanup(); resolve(); };
                    const rejectEntry = error => { cleanup(); reject(error); };
                    archive.once('entry', complete); archive.once('error', rejectEntry); output.once('error', rejectEntry); verify.once('error', rejectEntry);
                    archive.append(source.pipe(verify), { name: item.relative.replaceAll(path.sep, '/'), date: new Date(item.mtime), mode: 0o600 });
                });
            } finally {
                source.destroy(); verify.destroy();
                await finished(source, { cleanup: true }).catch(() => {});
            }
            await context.progress({ stage: 'Saving account backup', completed: index + 1, total: plan.files.length });
        }
        await archive.finalize(); await done;
        if (failure) throw failure;
        dependencies.afterBackupEncoded?.();
        return publishBinaryOutput(context, prepared, result, dependencies);
    } catch (error) {
        fail(error); await done.catch(() => {}); throw error;
    } finally { context.signal.removeEventListener('abort', abort); }
}

registerOperation('account-backup', { label: 'Save an account backup', capture: captureAccountBackup, run: runAccountBackup,
    authorize: (request, input) => {
        if (input.handle && input.handle !== request.user.profile.handle && !request.user.profile.admin) throw operationError('Only an administrator can back up another account.', 403);
    }, canRecover: value => Boolean(value.effects['binary:account-backup']?.publication) });
