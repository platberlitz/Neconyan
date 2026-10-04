import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { parseChatJsonl } from './chat-recovery.js';
import { FILE_WRITE_RECOVERY_MAX_BYTES, FILE_WRITE_RECOVERY_SUFFIX, fsyncDirectorySync } from './util.js';
import { normaliseRoleplayLocator, normaliseRoleplayGroupId, roleplayContentHash, roleplayEntityContent } from './generation/roleplay-source.js';
import { confirmRoleplayAccount, createRoleplayDirectory, readRoleplayFile, roleplayAvatarOwner, roleplayError, roleplayHash, roleplayLease,
    roleplayPathKey, saveRoleplayAccount, withRoleplayAccount } from './roleplay-store.js';

const FILE_LIMIT = Math.max(64 * 1024 * 1024, FILE_WRITE_RECOVERY_MAX_BYTES);
const FILE_COUNT_LIMIT = 100000;
const changed = () => roleplayError('ROLEPLAY_RECOVERY_CHANGED', 'The files changed after the check. Check transferred data again.');

/** Includes staged writes and journals, but never follows links or copies live locks. */
function inventory(lease) {
    const { scope, root } = roleplayLease(lease);
    const files = [];
    const walk = (directory, prefix, library) => {
        // Validate every parent through the protected reader, including empty directories.
        readRoleplayFile(path.join(directory, '.neconyan-recovery-check'), 0, { allowMissingParent: true });
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.endsWith('.lock') || entry.name.endsWith('.lock.owner')) continue;
            const filename = path.join(directory, entry.name);
            const relative = path.posix.join(prefix, entry.name);
            if (entry.isDirectory()) walk(filename, relative, library);
            else {
                const file = readRoleplayFile(filename, FILE_LIMIT);
                if (!file) throw changed();
                files.push({ filename, relative, library, rawHash: file.rawHash, physical: file.physical, size: file.bytes.length });
                if (files.length > FILE_COUNT_LIMIT) throw roleplayError('ROLEPLAY_RECOVERY_LIMIT', 'There are too many files for one repair.', 413);
            }
        }
    };
    for (const key of ['characters', 'groups', 'chats', 'groupChats']) walk(scope.directories[key], key, key);
    walk(root, '_roleplay', null);
    return files;
}

function inspect(lease) {
    const { state, stateFile } = roleplayLease(lease);
    const files = inventory(lease);
    const entries = [];
    const issues = [];
    const warnings = [];
    const groups = [];
    const avatars = new Map();
    for (const file of files.filter(file => file.library === 'characters' && /^characters\/[^/]+\.png$/.test(file.relative))) {
        const avatar = path.basename(file.relative);
        const owner = roleplayAvatarOwner(avatar);
        if (avatars.has(owner)) issues.push({ file: file.relative, reason: 'More than one character uses this chat folder.' });
        avatars.set(owner, avatar);
    }
    for (const file of files) {
        const parts = file.relative.split('/');
        let kind, locator, id;
        try {
            if (file.library === 'characters' && parts.length === 2 && parts[1].endsWith('.png')) {
                kind = 'character'; id = parts[1];
                normaliseRoleplayLocator({ group: false, chat: 'check', avatar: id });
                locator = { avatar: id };
            } else if (file.library === 'groups' && parts.length === 2 && parts[1].endsWith('.json')) {
                kind = 'group'; id = normaliseRoleplayGroupId(parts[1].slice(0, -5)); locator = { groupId: id };
            } else if (file.library === 'groupChats' && parts.length === 2 && parts[1].endsWith('.jsonl')) {
                kind = 'chat'; locator = normaliseRoleplayLocator({ group: true, chat: parts[1].slice(0, -6) });
            } else if (file.library === 'chats' && parts.length === 3 && parts[2].endsWith('.jsonl')) {
                kind = 'chat'; locator = normaliseRoleplayLocator({ group: false, avatar: avatars.get(parts[1]) ?? parts[1] + '.png', chat: parts[2].slice(0, -6) });
                if (!avatars.has(parts[1])) warnings.push({ file: file.relative, reason: 'The character card is missing. Import it to show this chat in the character list.' });
            } else continue;
            // Adopt only files the ordinary protected readers can open afterwards.
            const current = readRoleplayFile(file.filename, 64 * 1024 * 1024);
            if (!current || current.rawHash !== file.rawHash || !isDeepStrictEqual(current.physical, file.physical)) throw changed();
            let contentHash;
            if (kind === 'chat') {
                const parsed = parseChatJsonl(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes));
                if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The chat is incomplete or is not valid chat JSONL.');
                contentHash = roleplayContentHash(parsed.records);
            } else {
                const parsed = roleplayEntityContent(kind, id, current.bytes, { storage: true });
                contentHash = parsed.contentHash;
                if (kind === 'group') groups.push({ file: file.relative, data: parsed.data });
            }
            entries.push({ kind, locator, head: { rawHash: file.rawHash, physical: file.physical, contentHash, writeId: null } });
        } catch (error) {
            if (error.code === 'ROLEPLAY_RECOVERY_CHANGED') throw error;
            issues.push({ file: file.relative, reason: error.reason ?? (error.code?.startsWith('ROLEPLAY_') ? error.message : 'The file could not be decoded.') });
        }
    }
    const groupChats = new Set(entries.filter(entry => entry.kind === 'chat' && entry.locator.group).map(entry => entry.locator.chat));
    for (const group of groups) {
        for (const avatar of group.data.members ?? []) {
            if (![...avatars.values()].includes(avatar)) warnings.push({ file: group.file, reason: `Missing character card: ${avatar}` });
        }
        for (const chat of group.data.chats ?? []) {
            if (!groupChats.has(String(chat))) warnings.push({ file: group.file, reason: `Missing chat file: ${chat}` });
        }
    }
    const counts = { chats: 0, characters: 0, groups: 0 };
    for (const entry of entries) counts[{ chat: 'chats', character: 'characters', group: 'groups' }[entry.kind]]++;
    const token = roleplayHash({ state: stateFile.rawHash, files, entries });
    return { files, entries, report: { token, counts, issues, warnings, canRepair: entries.length > 0 && issues.length === 0,
        pending: state.pending?.kind ?? null, lastRepair: state.transferRecovery?.dataEpoch === state.dataEpoch ? state.transferRecovery : null } };
}

export function inspectTransferredRoleplay(base) {
    return withRoleplayAccount(base, null, lease => inspect(lease).report);
}

function writeBackupFile(filename, bytes, root) {
    createRoleplayDirectory(path.dirname(filename), root);
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectorySync(path.dirname(filename));
}

/**
 * Explicit adoption, never an ordinary read fallback. No user file is rewritten.
 * A durable independent backup precedes one atomic ledger publication, so an
 * interruption leaves either the old authority or the complete new authority.
 * The epoch fences captured saves/jobs; orphaned native markers are not authority.
 */
export function repairTransferredRoleplay(base, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw changed();
    return withRoleplayAccount(base, null, lease => {
        confirmRoleplayAccount(lease);
        const { state, scope, root } = roleplayLease(lease);
        if (state.transferRecovery?.token === token && state.transferRecovery.dataEpoch === state.dataEpoch) return state.transferRecovery;
        const checked = inspect(lease);
        if (checked.report.token !== token) throw changed();
        if (!checked.report.canRepair) throw roleplayError('ROLEPLAY_RECOVERY_INVALID', 'Some files need attention. Review the check before repairing.', 422);
        const backupId = crypto.randomUUID();
        const dataRoot = path.dirname(scope.directories.root);
        const backup = path.join(dataRoot, '_roleplay-recovery', path.basename(root), backupId);
        createRoleplayDirectory(backup, dataRoot);
        for (const file of checked.files) {
            const current = readRoleplayFile(file.filename, FILE_LIMIT);
            if (!current || current.rawHash !== file.rawHash || !isDeepStrictEqual(current.physical, file.physical)) throw changed();
            writeBackupFile(path.join(backup, file.relative), current.bytes, dataRoot);
        }
        const journals = checked.files.filter(file => file.library && file.relative.endsWith(FILE_WRITE_RECOVERY_SUFFIX))
            .map(({ relative, library, rawHash, physical }) => ({ relative, library, rawHash, physical }));
        const receipt = { token, backup, dataEpoch: state.dataEpoch + 1, counts: checked.report.counts, repairedAt: new Date().toISOString(), journals };
        writeBackupFile(path.join(backup, 'manifest.json'), JSON.stringify({ ...receipt, owner: scope.owner, accountId: state.accountId,
            previousEpoch: state.dataEpoch, files: checked.files, warnings: checked.report.warnings }), dataRoot);
        // Cooperating writers hold this lock; check again for manual copying during the backup.
        if (inspect(lease).report.token !== token) throw changed();
        confirmRoleplayAccount(lease);
        // Old evidence remains in the backup, including unfinished operations and their payloads.
        // Removing receipts here also prevents old receipt cleanup from touching retained journals.
        state.dataEpoch++;
        state.paths = {}; state.resources = {}; state.submissions = {}; state.pending = null;
        state.accountResets = {};
        state.transferRecovery = receipt;
        for (const entry of checked.entries) {
            const instanceId = crypto.randomUUID();
            state.paths[roleplayPathKey(state, entry.kind, entry.locator)] = { generation: 1, instanceId };
            state.resources[instanceId] = { ...entry, accountId: state.accountId, dataEpoch: state.dataEpoch,
                status: 'live', revision: 1, busySubmission: null };
        }
        saveRoleplayAccount(lease);
        confirmRoleplayAccount(lease);
        return receipt;
    });
}
