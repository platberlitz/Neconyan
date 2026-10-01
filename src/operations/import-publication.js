import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseChatJsonl } from '../chat-recovery.js';
import { ROLEPLAY_METADATA_KEY, captureRoleplayStorageSourceLocked, readRoleplayEntityLocked, roleplayEntityContent } from '../generation/roleplay-source.js';
import { assertUntrackedRoleplayFiles, createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile,
    roleplayFileLocator, roleplayHash, roleplayLease, roleplayPathKey, saveRoleplayAccount } from '../roleplay-store.js';
import { commitRoleplayLifecycleLocked, commitSingleChatWriteLocked } from '../roleplay-lifecycle.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { prepareSettingsSave, getSettingsVersion } from '../settings-version.js';
import { migrateLegacySettingsNames } from '../legacy-name-migration.js';
import { ENTITY_DATE_ADDED_FILE, mergeImportedEntityDateAdded } from '../entity-date-added.js';
import { ENTITY_LAST_CHAT_FILE, mergeImportedEntityLastChat } from '../entity-last-chat.js';
import { fsyncDirectorySync } from '../util.js';
import { BINARY_FILE_LIMIT, openOperationBinary } from './binary-files.js';
import { readImportInput } from './import-inputs.js';
import { operationError, withOperation } from './store.js';
import { readImportPersonas } from './import-personas.js';
import { isNativeLorebook } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { validateWorldInfoHistory } from '../world-info-history.js';

const STRUCTURED_LIMIT = 32 * 1024 * 1024;
const evidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;
const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const same = (left, right) => roleplayHash(left) === roleplayHash(right);
const changed = relative => operationError(`An import destination changed${relative ? `: '${relative}'` : ''}. The newer file was kept. Reload the page and retry the import.`);

export function captureImportTarget(lease, relative) {
    const { scope, state } = roleplayLease(lease);
    const filename = path.join(scope.directories.root, relative);
    const current = inspectRoleplayFile(filename, BINARY_FILE_LIMIT, { allowMissingParent: true });
    const resource = roleplayFileLocator(scope, filename);
    const target = { relative, evidence: evidence(current), resource };
    if (!resource) {
        assertUntrackedRoleplayFiles(lease, [filename]);
    } else if (current) {
        if (resource.kind === 'chat') {
            const captured = captureRoleplayStorageSourceLocked(lease, resource.locator);
            target.source = captured.source;
            if (captured.changed) saveRoleplayAccount(lease);
        } else {
            const entity = readRoleplayEntityLocked(lease, resource.kind,
                resource.kind === 'character' ? resource.locator.avatar : resource.locator.groupId, { storage: true });
            if (entity.changed) saveRoleplayAccount(lease);
        }
    } else {
        const slot = state.paths[roleplayPathKey(state, resource.kind, resource.locator)];
        if (slot?.instanceId) throw changed(relative);
        target.vacancy = slot?.generation ?? 0;
    }
    return target;
}

export function assertImportTarget(lease, target) {
    // Persona-only imports merge into the latest settings while holding the account lock.
    if (target.personaSettings) return;
    const { scope } = roleplayLease(lease);
    const filename = path.join(scope.directories.root, target.relative);
    if (!same(evidence(inspectRoleplayFile(filename, BINARY_FILE_LIMIT, { allowMissingParent: true })), target.evidence)) throw changed(target.relative);
    if (!target.resource) assertUntrackedRoleplayFiles(lease, [filename]);
    else if (!same(captureImportTarget(lease, target.relative), target)) throw changed(target.relative);
}

/** Marks a failure that affects only one backup file, so the import can skip that file and continue. */
export const importDamage = (error, reason) => Object.assign(error, { importDamage: reason });

/** Explains why one backup file is skipped, or returns null when the whole import must stop instead. */
export function importSkipReason(file, error) {
    return typeof error?.importDamage === 'string' ? `Cannot read '${file.relative}': ${error.importDamage}` : null;
}

function object(bytes, label, current = false) {
    try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
        return value;
    } catch {
        throw importDamage(operationError(`The imported ${label} is not valid JSON.`, 400), current
            ? 'The copy already in this account is not valid JSON, so the backup copy could not be merged into it.'
            : 'The file is not valid JSON.');
    }
}

const MERGED_FILES = ['settings.json', 'secrets.json', ENTITY_DATE_ADDED_FILE, ENTITY_LAST_CHAT_FILE];
const CHAT_IMPORT_LIMIT = 64 * 1024 * 1024;
const isLorebookFile = relative => /^worlds\/[^/]+\.json$/.test(relative);
const isLorebookHistoryFile = relative => /^worlds\/\.history\/[^/]+\.json$/.test(relative);

/** Files whose bytes are read and checked before any destination is published. */
export const importNeedsCheck = file => Boolean(file.target.resource) || MERGED_FILES.includes(file.relative)
    || isLorebookFile(file.relative) || isLorebookHistoryFile(file.relative);
export const importInputLimit = file => file.target.resource?.kind === 'chat' ? CHAT_IMPORT_LIMIT : STRUCTURED_LIMIT;

/** Chat records are derived again from the same retained bytes, so they never need to be stored in the record. */
const CHAT_DAMAGE = {
    'invalid-utf8': () => 'The chat file is not valid UTF-8 text.',
    'invalid-json': line => `Line ${line} of the chat file is not valid JSON.`,
    'non-object': line => `Line ${line} of the chat file is not a chat message.`,
    empty: () => 'The chat file is empty.',
    'missing-chat-metadata': () => 'The first line of the chat file is not a chat header.',
};

export function importChatRecords(bytes) {
    const parsed = parseChatJsonl(bytes);
    if (parsed.status !== 'ok') {
        throw importDamage(operationError('An imported chat needs recovery.', 400), CHAT_DAMAGE[parsed.reason]?.(parsed.line) ?? 'The chat file needs recovery.');
    }
    const records = parsed.records;
    delete records[0].chat_metadata[ROLEPLAY_METADATA_KEY];
    return records;
}

/** Validate every structured input before any destination is published. */
export function prepareImportValue(context, file, index, input) {
    const resource = file.target.resource;
    const read = () => input ?? readImportInput(context, index, STRUCTURED_LIMIT);
    if (file.personaSettings) { readImportPersonas(read()); return { personas: true }; }
    if (resource) {
        const bytes = read();
        if (resource.kind === 'chat') {
            const records = importChatRecords(bytes);
            return input ? { chat: true } : { records: structuredClone(records) };
        }
        try {
            roleplayEntityContent(resource.kind, resource.kind === 'character' ? resource.locator.avatar : resource.locator.groupId, bytes, { storage: true });
        } catch (error) {
            throw error.code === 'ROLEPLAY_SOURCE_DAMAGED' ? importDamage(error, error.reason) : error;
        }
        return { entity: true };
    }
    if (isLorebookFile(file.relative) || isLorebookHistoryFile(file.relative)) {
        const data = object(read(), file.relative);
        const history = isLorebookHistoryFile(file.relative);
        if (!(history ? validateWorldInfoHistory(data) : isNativeLorebook(data))) {
            const reason = history ? 'The lorebook history is not valid.' : 'The file is not a valid lorebook.';
            throw importDamage(operationError(reason, 400), reason);
        }
        // Backup imports retain the original names and bytes, including unknown metadata and history.
        return null;
    }
    if (!MERGED_FILES.includes(file.relative)) return null;
    const incoming = object(read(), file.relative);
    return withOperation(context, ({ lease }) => {
        assertImportTarget(lease, file.target);
        const { scope } = roleplayLease(lease);
        const current = readRoleplayFile(path.join(scope.directories.root, file.relative), STRUCTURED_LIMIT, { allowMissingParent: true });
        const existing = current ? object(current.bytes, `current ${file.relative}`, true) : {};
        let result = incoming;
        if (file.relative === 'settings.json') {
            // Settings exported before the rename arrive with the old key names.
            migrateLegacySettingsNames(incoming);
            const prepared = prepareSettingsSave({ ...incoming, _version: getSettingsVersion(existing) }, existing, { restoreSnapshot: true });
            if (!prepared.ok) throw operationError('The imported settings conflict with protected saved work. No account files were replaced.');
            result = prepared.settings;
        }
        if (file.relative === ENTITY_DATE_ADDED_FILE) result = mergeImportedEntityDateAdded(current ? existing : null, incoming);
        if (file.relative === ENTITY_LAST_CHAT_FILE) result = mergeImportedEntityLastChat(current ? existing : null, incoming);
        return { bytes: Buffer.from(JSON.stringify(result, null, 4)).toString('base64') };
    });
}

/** Stage an ordinary file, including large binary uploads, before recording permission to replace it. */
export async function stageImportFile(context, file, index, preparedValue) {
    const key = `stage:${index}`;
    let stage = withOperation(context, ({ lease, value, save }) => {
        if (value.effects[key]?.state === 'done') return value.effects[key];
        assertImportTarget(lease, file.target);
        const { scope } = roleplayLease(lease);
        const root = scope.directories.root;
        const filename = path.join(root, file.relative);
        createRoleplayDirectory(path.dirname(filename), root);
        if (!value.effects[key]) {
            const temporary = path.join(path.dirname(filename), `.application-import-${randomUUID()}.tmp`);
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fsyncDirectorySync(path.dirname(filename));
            value.effects[key] = { state: 'prepared', temporary: path.relative(root, temporary), physical: physical(fs.statSync(temporary, { bigint: true })) };
            save();
        }
        return value.effects[key];
    });
    if (stage.state === 'done') return stage.staged;
    const overridden = preparedValue?.bytes !== undefined ? Buffer.from(preparedValue.bytes, 'base64') : null;
    const input = overridden ? null : openOperationBinary(context, `import:${index}`);
    const expectedSize = overridden?.length ?? input.size;
    const expectedHash = overridden ? createHash('sha256').update(overridden).digest('hex') : input.rawHash;
    let source, output;
    try {
        const opened = withOperation(context, ({ lease }) => {
            assertImportTarget(lease, file.target);
            const root = roleplayLease(lease).scope.directories.root;
            const temporary = path.join(root, stage.temporary);
            const previous = inspectRoleplayFile(temporary, BINARY_FILE_LIMIT);
            if (!previous || !same(previous.physical, stage.physical)) throw operationError('The prepared import file needs recovery.');
            const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
            if (!same(physical(fs.fstatSync(fd, { bigint: true })), stage.physical)) { fs.closeSync(fd); throw changed(); }
            fs.ftruncateSync(fd, 0);
            return { temporary, fd };
        });
        source = overridden ? Readable.from(overridden) : fs.createReadStream(input.filename, { fd: input.fd, autoClose: true });
        output = fs.createWriteStream(opened.temporary, { fd: opened.fd, autoClose: true });
        let size = 0;
        const hash = createHash('sha256');
        const check = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > expectedSize) return callback(operationError('The prepared import exceeded its captured size.'));
            hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(source, check, output, { signal: context.signal });
        if (size !== expectedSize || hash.digest('hex') !== expectedHash) throw operationError('The prepared import bytes changed.');
        stage = withOperation(context, ({ lease, value, save }) => {
            assertImportTarget(lease, file.target);
            const root = roleplayLease(lease).scope.directories.root;
            const staged = inspectRoleplayFile(path.join(root, stage.temporary), BINARY_FILE_LIMIT, { flush: true });
            if (!staged || !same(staged.physical, stage.physical) || staged.rawHash !== expectedHash || staged.size !== expectedSize) throw changed();
            value.effects[key] = { ...stage, state: 'done', staged: { relative: file.relative, before: file.target.evidence,
                after: evidence(staged), temporary: stage.temporary, size: staged.size } };
            save();
            return value.effects[key];
        });
        return stage.staged;
    } catch (error) {
        if (source) source.destroy(); else if (input) fs.closeSync(input.fd);
        output?.destroy(); throw error;
    }
}

export function publishImportFile(context, file, index, prepared, { afterImportPublication } = {}) {
    let entityBytes;
    if (file.target.resource && file.target.resource.kind !== 'chat') {
        const needsBytes = withOperation(context, ({ lease, value }) => {
            const effect = value.effects[`publish:${index}`];
            if (effect?.state === 'done') return false;
            const { state } = roleplayLease(lease);
            const key = roleplayHash([state.accountId, 'lifecycle', effect?.operationKey ?? `application:${context.job.id}:import:${index}`]);
            return !state.submissions[key] && state.pending?.operationKeyHash !== key;
        });
        if (needsBytes) entityBytes = readImportInput(context, index, STRUCTURED_LIMIT);
    }
    return withOperation(context, ({ lease, value, save }) => {
        const key = `publish:${index}`;
        if (value.effects[key]?.state === 'done') return;
        const { scope, state } = roleplayLease(lease);
        const filename = path.join(scope.directories.root, file.relative);
        if (!value.effects[key]) {
            context.signal.throwIfAborted();
            assertImportTarget(lease, file.target);
            const operationKey = `application:${context.job.id}:import:${index}`;
            if (file.target.resource?.kind === 'chat') {
                value.effects[key] = { state: 'prepared', input: { operationKey, mode: file.target.source ? 'update' : 'create', sourceKind: 'storage',
                    ...(file.target.source ? { source: file.target.source } : { destination: file.target.resource.locator, expectedVacancy: file.target.vacancy }),
                    records: prepared.records, force: true, allowShrink: true, backup: { deferBackup: true } } };
            } else value.effects[key] = { state: 'prepared', operationKey };
            save();
        }
        const effect = value.effects[key];
        if (file.target.resource?.kind === 'chat') {
            commitSingleChatWriteLocked(lease, effect.input, roleplayNativeHost);
        } else if (file.target.resource) {
            const operationKeyHash = roleplayHash([state.accountId, 'lifecycle', effect.operationKey]);
            if (!state.submissions[operationKeyHash] && state.pending?.operationKeyHash !== operationKeyHash) assertImportTarget(lease, file.target);
            const bytes = state.submissions[operationKeyHash] || state.pending?.operationKeyHash === operationKeyHash ? Buffer.alloc(0) : entityBytes;
            commitRoleplayLifecycleLocked(lease, { operationKey: effect.operationKey, action: 'application-import',
                intent: { relative: file.relative, inputHash: value.effects[`binary:import:${index}`].publication.rawHash, target: file.target },
                steps: [{ op: file.target.evidence ? 'update' : 'create', ...file.target.resource, bytes }] });
        } else {
            const staged = prepared.staged;
            const current = inspectRoleplayFile(filename, BINARY_FILE_LIMIT, { allowMissingParent: true });
            if (!same(evidence(current), staged.after)) {
                assertImportTarget(lease, file.target);
                const temporary = path.join(scope.directories.root, staged.temporary);
                const input = inspectRoleplayFile(temporary, BINARY_FILE_LIMIT, { flush: true });
                if (!input || !same(evidence(input), staged.after) || input.size !== staged.size) throw operationError('The prepared import publication is missing.');
                fs.renameSync(temporary, filename);
                fsyncDirectorySync(path.dirname(filename));
            }
            const published = inspectRoleplayFile(filename, BINARY_FILE_LIMIT, { flush: true });
            if (!same(evidence(published), staged.after)) throw operationError('The imported file publication needs recovery.');
        }
        afterImportPublication?.({ relative: file.relative, index });
        value.effects[key].state = 'done'; save();
    });
}
