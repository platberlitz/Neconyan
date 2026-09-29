import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRoleplayDirectory, inspectRoleplayFile, roleplayHash, roleplayLease } from '../roleplay-store.js';
import { commitRoleplayLifecycleLocked, commitSingleChatWriteLocked } from '../roleplay-lifecycle.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { fsyncDirectorySync } from '../util.js';
import { BINARY_FILE_LIMIT, openOperationBinary } from './binary-files.js';
import { readImportInput } from './import-inputs.js';
import { assertImportTarget, importChatRecords, importDamage, importInputLimit, importSkipReason } from './import-publication.js';
import { operationError, withOperation } from './store.js';

// Large account imports record their progress once per batch instead of once per file.
const BATCH_FILES = 128;
const BATCH_BYTES = 32 * 1024 * 1024;
const BATCH_MS = 1000;
const PUBLISH_EFFECT = 'import-publish';

const evidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;
const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const same = (left, right) => roleplayHash(left) === roleplayHash(right);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = () => operationError('An import destination changed. The newer file was kept.');

/** Read one planned input: straight from the retained ZIP when it came from one, otherwise from its retained copy. */
export async function readPlannedInput(context, archive, file, index) {
    const limit = importInputLimit(file);
    try {
        return archive && file.zip ? await archive.read(file.zip, limit) : readImportInput(context, index, limit);
    } catch (error) {
        throw error.status === 413 ? importDamage(error, `The file is larger than the ${limit / 1024 / 1024} MiB limit for this kind of file.`) : error;
    }
}

export function importBatches(items, size = () => 0, files = BATCH_FILES) {
    const batches = [];
    let current = [], bytes = 0;
    for (const item of items) {
        const next = size(item);
        if (current.length && (current.length >= files || bytes + next > BATCH_BYTES)) { batches.push(current); current = []; bytes = 0; }
        current.push(item); bytes += next;
    }
    if (current.length) batches.push(current);
    return batches;
}

/**
 * Stage a batch of ordinary files next to their destinations, saving the record twice per batch.
 * Returns the files skipped because their own bytes are damaged; the rest of the batch still stages.
 */
export async function stageImportBatch(context, batch, { archive, prepared }) {
    const pending = [];
    const skipped = [];
    const closeAll = () => { for (const item of pending) if (item.fd !== null) { try { fs.closeSync(item.fd); } catch { /* already closed */ } item.fd = null; } };
    try {
        withOperation(context, ({ lease, value, save }) => {
            context.signal.throwIfAborted();
            const root = roleplayLease(lease).scope.directories.root;
            const created = new Set();
            for (const { file, index } of batch) {
                const key = `stage:${index}`;
                let effect = value.effects[key];
                if (effect?.state === 'done' && effect.skipped) { skipped.push({ index, relative: file.relative, reason: effect.skipped }); continue; }
                if (effect?.state === 'done') continue;
                assertImportTarget(lease, file.target);
                const filename = path.join(root, file.relative);
                createRoleplayDirectory(path.dirname(filename), root);
                let fd;
                if (effect) {
                    const temporary = path.join(root, effect.temporary);
                    const previous = inspectRoleplayFile(temporary, BINARY_FILE_LIMIT);
                    if (previous) {
                        if (!same(previous.physical, effect.physical)) throw operationError('The prepared import file needs recovery.');
                        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
                        if (!same(physical(fs.fstatSync(fd, { bigint: true })), effect.physical)) { fs.closeSync(fd); throw changed(); }
                    }
                }
                if (fd === undefined) {
                    const temporary = path.join(path.dirname(filename), `.application-import-${randomUUID()}.tmp`);
                    fd = fs.openSync(temporary, 'wx', 0o600);
                    effect = value.effects[key] = { state: 'prepared', temporary: path.relative(root, temporary), physical: physical(fs.fstatSync(fd, { bigint: true })) };
                    created.add(path.dirname(filename));
                }
                pending.push({ file, index, effect, fd });
                fs.ftruncateSync(fd, 0);
            }
            // A prepared but missing temporary file can be recreated after a power loss.
            // Filled files are individually flushed before their effects become done.
            for (const directory of created) fsyncDirectorySync(directory);
            if (created.size) save();
        });
        for (const item of pending) {
            context.signal.throwIfAborted();
            const override = prepared[item.index]?.bytes !== undefined ? Buffer.from(prepared[item.index].bytes, 'base64') : null;
            let source, expectedSize, expectedHash = null;
            try {
                if (override) {
                    source = Readable.from([override]); expectedSize = override.length; expectedHash = sha256(override);
                } else if (archive && item.file.zip) {
                    source = await archive.open(item.file.zip); expectedSize = item.file.zip.size;
                } else {
                    const input = openOperationBinary(context, `import:${item.index}`);
                    source = fs.createReadStream(input.filename, { fd: input.fd, autoClose: true });
                    expectedSize = input.size; expectedHash = input.rawHash;
                }
            } catch (error) {
                const reason = importSkipReason(item.file, error);
                if (!reason) throw error;
                item.skipped = reason;
                continue;
            }
            const output = fs.createWriteStream(path.basename(item.effect.temporary), { fd: item.fd, autoClose: true });
            item.fd = null;
            let size = 0;
            const hash = createHash('sha256');
            const check = new Transform({ transform(chunk, _encoding, callback) {
                size += chunk.length;
                if (size > expectedSize) return callback(operationError('The prepared import exceeded its captured size.'));
                hash.update(chunk); callback(null, chunk);
            } });
            try {
                await pipeline(source, check, output, { signal: context.signal });
            } catch (error) {
                const reason = !context.signal.aborted && importSkipReason(item.file, error);
                if (!reason) throw error;
                item.skipped = reason;
                continue;
            }
            item.rawHash = hash.digest('hex'); item.size = size;
            if (size !== expectedSize || (expectedHash && item.rawHash !== expectedHash)) throw operationError('The prepared import bytes changed.');
        }
        withOperation(context, ({ lease, value, save }) => {
            const root = roleplayLease(lease).scope.directories.root;
            for (const { file, index, effect, rawHash, size, skipped: reason } of pending) {
                if (reason) {
                    // A damaged ZIP entry leaves its partial temporary file behind; remove it and remember the reason.
                    fs.rmSync(path.join(root, effect.temporary), { force: true });
                    value.effects[`stage:${index}`] = { state: 'done', skipped: reason };
                    skipped.push({ index, relative: file.relative, reason });
                    continue;
                }
                assertImportTarget(lease, file.target);
                const staged = inspectRoleplayFile(path.join(root, effect.temporary), BINARY_FILE_LIMIT, { flush: true });
                if (!staged || !same(staged.physical, effect.physical) || staged.rawHash !== rawHash || staged.size !== size) throw changed();
                value.effects[`stage:${index}`] = { ...effect, state: 'done', staged: { relative: file.relative, before: file.target.evidence,
                    after: evidence(staged), temporary: effect.temporary, size: staged.size } };
            }
            if (pending.length) save();
        });
    } finally { closeAll(); }
    return skipped;
}

function chatInput(file, operationKey, records) {
    return { operationKey, mode: file.target.source ? 'update' : 'create', sourceKind: 'storage',
        ...(file.target.source ? { source: file.target.source } : { destination: file.target.resource.locator, expectedVacancy: file.target.vacancy }),
        records, force: true, allowShrink: true, backup: { deferBackup: true } };
}

/**
 * Publish staged files, chats and cards in plan order behind one saved cursor.
 * Every step is safe to repeat: chats and cards keep receipts, and a renamed file already matches its staged evidence.
 */
export async function publishImportBatches(context, plan, { archive, onProgress, afterImportPublication, skipped = new Set() } = {}) {
    let next = withOperation(context, ({ value, save }) => {
        if (!value.effects[PUBLISH_EFFECT]) { value.effects[PUBLISH_EFFECT] = { state: 'prepared', next: 0 }; save(); }
        return value.effects[PUBLISH_EFFECT].state === 'done' ? plan.files.length : value.effects[PUBLISH_EFFECT].next;
    });
    let limit = 16;
    while (next < plan.files.length) {
        context.signal.throwIfAborted();
        const batch = [];
        let bytes = 0;
        for (let index = next; index < plan.files.length && batch.length < limit; index++) {
            const file = plan.files[index];
            const size = file.target.resource ? file.size : 0;
            if (batch.length && bytes + size > BATCH_BYTES) break;
            batch.push({ file, index }); bytes += size;
        }
        for (const item of batch) if (item.file.target.resource && !skipped.has(item.index)) item.bytes = await readPlannedInput(context, archive, item.file, item.index);
        const started = Date.now();
        const reached = withOperation(context, ({ lease, value, save }) => {
            context.signal.throwIfAborted();
            const { scope, state } = roleplayLease(lease);
            const root = scope.directories.root;
            const effect = value.effects[PUBLISH_EFFECT];
            if (effect.next !== next) throw operationError('The import publication cursor changed.');
            const directories = new Set();
            const flush = () => { for (const directory of directories) fsyncDirectorySync(directory); directories.clear(); };
            for (const { file, index, bytes: input } of batch) {
                if (index > next && Date.now() - started > BATCH_MS) break;
                if (skipped.has(index)) { effect.next = index + 1; continue; }
                const operationKey = `application:${context.job.id}:import:${index}`;
                const resource = file.target.resource;
                if (resource?.kind === 'chat') {
                    const receipt = roleplayHash([state.accountId, 'chat-write', operationKey]);
                    if (!state.submissions[receipt] && state.pending?.operationKeyHash !== receipt) assertImportTarget(lease, file.target);
                    commitSingleChatWriteLocked(lease, chatInput(file, operationKey, importChatRecords(input)), roleplayNativeHost);
                } else if (resource) {
                    const receipt = roleplayHash([state.accountId, 'lifecycle', operationKey]);
                    const settled = Boolean(state.submissions[receipt]) || state.pending?.operationKeyHash === receipt;
                    if (!settled) assertImportTarget(lease, file.target);
                    commitRoleplayLifecycleLocked(lease, { operationKey, action: 'application-import',
                        intent: { relative: file.relative, inputHash: sha256(input), target: file.target },
                        steps: [{ op: file.target.evidence ? 'update' : 'create', ...resource, bytes: settled ? Buffer.alloc(0) : input }] });
                } else {
                    // Saved settings become visible only after every earlier file is durable.
                    if (file.relative === 'settings.json') flush();
                    const staged = value.effects[`stage:${index}`]?.staged;
                    if (!staged) throw operationError('The prepared import publication is missing.');
                    const filename = path.join(root, file.relative);
                    const current = inspectRoleplayFile(filename, BINARY_FILE_LIMIT, { allowMissingParent: true });
                    if (!same(evidence(current), staged.after)) {
                        assertImportTarget(lease, file.target);
                        const temporary = path.join(root, staged.temporary);
                        const retained = inspectRoleplayFile(temporary, BINARY_FILE_LIMIT);
                        if (!retained || !same(evidence(retained), staged.after) || retained.size !== staged.size) throw operationError('The prepared import publication is missing.');
                        fs.renameSync(temporary, filename);
                        if (!same(physical(fs.lstatSync(filename, { bigint: true })), staged.after.physical)) throw operationError('The imported file publication needs recovery.');
                    }
                    // Also flush a replayed rename which may have stopped before the earlier directory flush.
                    directories.add(path.dirname(filename));
                }
                afterImportPublication?.({ relative: file.relative, index });
                effect.next = index + 1;
            }
            flush();
            if (effect.next === plan.files.length) effect.state = 'done';
            value.importAttempts = 1;
            save();
            return effect.next;
        });
        // Keep each locked batch near one second so the phone stays responsive.
        limit = reached - next < batch.length ? Math.max(1, reached - next) : Math.min(BATCH_FILES, limit * 2);
        next = reached;
        await onProgress?.(next, plan.files.length);
    }
    withOperation(context, ({ value, save }) => {
        if (value.effects[PUBLISH_EFFECT].state !== 'done') { value.effects[PUBLISH_EFFECT].state = 'done'; save(); }
    });
}
