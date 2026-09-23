import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { withChatFileLocks } from '../chat-file-lock.js';
import { normaliseRoleplayLocator, roleplayChatPath } from '../generation/roleplay-source.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayError } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';
import { hash } from './core.js';
import { buildBranchMemoryState, buildMemoryRecoveryGuard, MAX_ARCHIVE_BYTES } from './store.js';

const damaged = () => roleplayError('ROLEPLAY_MEMORY_CHANGED', 'Branch memory is incomplete or changed; its saved evidence was retained.');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprint = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;

/** Match the existing memory format without stripping an exact chat basename again. */
export function canonicalMemoryPaths(directories, value) {
    const locator = normaliseRoleplayLocator(value);
    const memoryLocator = { chat: locator.chat, avatar: locator.group ? '' : locator.avatar, group: locator.group };
    const id = hash(memoryLocator) + '.json';
    return { locator: memoryLocator, archive: path.join(directories.root, 'mewmory', 'stories', id),
        guard: path.join(directories.root, 'mewmory', 'recovery', id) };
}

function readPair(paths) {
    const archive = readRoleplayFile(paths.archive, MAX_ARCHIVE_BYTES, { allowMissingParent: true });
    const guard = readRoleplayFile(paths.guard, MAX_ARCHIVE_BYTES, { allowMissingParent: true });
    if (!archive && !guard) return null;
    if (!archive) throw damaged();
    try {
        const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(archive.bytes));
        if (state?.format !== 1 || !Array.isArray(state.records) || !isDeepStrictEqual(state.locator, paths.locator)
            || ['storyId', 'branchId'].some(key => typeof state[key] !== 'string' || !state[key].trim())) throw damaged();
        if (guard) {
            const savedGuard = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(guard.bytes));
            if (!isDeepStrictEqual(JSON.parse(JSON.stringify(buildMemoryRecoveryGuard(state))), savedGuard)) throw damaged();
        }
        return { state, archive, guard };
    } catch (cause) { throw Object.assign(damaged(), { cause }); }
}

function pairEvidence(pair) {
    return pair ? { archive: fingerprint(pair.archive), guard: fingerprint(pair.guard) } : null;
}

/** Called under the account lock, before the chat transaction publishes any bytes. */
export function prepareBranchMemoryCapture(directories, locator, { metadata, messages }, { mode }) {
    validateMode(mode);
    const child = canonicalMemoryPaths(directories, locator);
    if (mode === 'create') assertAbsent(child);
    if (!metadata.main_chat || metadata.main_chat === child.locator.chat) return { plan: null, payloads: [] };
    const chatFile = roleplayChatPath({ directories }, locator);
    const existing = readPair(child);
    if (existing) return withChatFileLocks([chatFile], () => withChatFileLocks([child.archive], () => {
        const current = readPair(child);
        if (!isDeepStrictEqual(pairEvidence(current), pairEvidence(existing))) throw damaged();
        return { plan: { kind: 'existing', child: pairEvidence(current) }, payloads: [] };
    }));
    const parentLocator = normaliseRoleplayLocator({ ...locator, chat: metadata.main_chat });
    const parent = canonicalMemoryPaths(directories, parentLocator);
    // Inspect before locking: the lock helper creates directories, which preparation must not do.
    const inherited = readPair(parent);
    if (!existing && !inherited) return { plan: { kind: 'absent', parentLocator, parent: null }, payloads: [] };
    const lockFile = readRoleplayFile(chatFile, 64 * 1024 * 1024, { allowMissingParent: true })
        ? chatFile : roleplayChatPath({ directories }, parentLocator);
    if (!readRoleplayFile(lockFile, 64 * 1024 * 1024, { allowMissingParent: true })) throw damaged();
    return withChatFileLocks([lockFile], () => {
        return withChatFileLocks([parent.archive, child.archive], () => {
            const current = readPair(child);
            if (current) throw damaged();
            const source = readPair(parent);
            if (!source) return { plan: { kind: 'absent', parentLocator, parent: null }, payloads: [] };
            const state = buildBranchMemoryState(source.state, child.locator, messages);
            const archive = Buffer.from(JSON.stringify(state));
            const guard = Buffer.from(JSON.stringify(buildMemoryRecoveryGuard(state)));
            if (archive.length > MAX_ARCHIVE_BYTES || guard.length > MAX_ARCHIVE_BYTES) throw roleplayError('ROLEPLAY_MEMORY_FULL', 'Prepared memory exceeds its storage limit.', 413);
            return { plan: { kind: 'create', parentLocator, parent: pairEvidence(source), branchId: state.branchId,
                archiveHash: digest(archive), guardHash: digest(guard), archiveBytes: archive.length, guardBytes: guard.length },
            payloads: [{ name: 'memory.archive.json', bytes: archive }, { name: 'memory.guard.json', bytes: guard }] };
        });
    });
}

function validateMode(mode) {
    if (!['update', 'create'].includes(mode)) throw new TypeError('Branch capture needs its chat operation mode.');
}

function assertAbsent(paths) {
    if (readRoleplayFile(paths.archive, MAX_ARCHIVE_BYTES, { allowMissingParent: true })
        || readRoleplayFile(paths.guard, MAX_ARCHIVE_BYTES, { allowMissingParent: true })) throw damaged();
}

/** A still-unapplied chat must retain the memory source captured at preparation. */
export function assertPreparedBranchMemory(directories, locator, plan, { mode }) {
    validateMode(mode);
    const child = canonicalMemoryPaths(directories, locator);
    if (mode === 'create') assertAbsent(child);
    if (!plan) return;
    if (plan.kind === 'existing') {
        if (!isDeepStrictEqual(pairEvidence(readPair(child)), plan.child)) throw damaged();
        return;
    }
    const parent = canonicalMemoryPaths(directories, plan.parentLocator);
    if (!isDeepStrictEqual(pairEvidence(readPair(parent)), plan.parent) || readPair(child)) throw damaged();
}

/** Publish only the frozen pair; a guard-only interruption never generates a new branch. */
export function applyPreparedBranchMemoryCapture(directories, locator, plan, { mode, chat, payload }) {
    validateMode(mode);
    if (!plan && mode !== 'create') return;
    const filename = roleplayChatPath({ directories }, locator);
    const inspectChat = () => {
        if (!isDeepStrictEqual(fingerprint(readRoleplayFile(filename, 64 * 1024 * 1024)), chat)) throw damaged();
    };
    inspectChat();
    return withChatFileLocks([filename], () => {
        inspectChat();
        const child = canonicalMemoryPaths(directories, locator);
        if (plan?.kind !== 'create') {
            assertPreparedBranchMemory(directories, locator, plan, { mode });
            return;
        }
        createRoleplayDirectory(path.dirname(child.archive), directories.root);
        createRoleplayDirectory(path.dirname(child.guard), directories.root);
        const parent = canonicalMemoryPaths(directories, plan.parentLocator);
        return withChatFileLocks([parent.archive, child.archive], () => {
            const archive = readRoleplayFile(child.archive, MAX_ARCHIVE_BYTES);
            const guard = readRoleplayFile(child.guard, MAX_ARCHIVE_BYTES);
            if ((archive && archive.rawHash !== plan.archiveHash) || (guard && guard.rawHash !== plan.guardHash)) throw damaged();
            if (!archive && !guard && !isDeepStrictEqual(pairEvidence(readPair(parent)), plan.parent)) throw damaged();
            for (const [name, target, expected] of [['memory.guard.json', child.guard, plan.guardHash], ['memory.archive.json', child.archive, plan.archiveHash]]) {
                let file = readRoleplayFile(target, MAX_ARCHIVE_BYTES);
                if (!file) {
                    const bytes = payload(name, expected);
                    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES || digest(bytes) !== expected) throw damaged();
                    tryWriteFileSync(target, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
                }
                file = readRoleplayFile(target, MAX_ARCHIVE_BYTES, { flush: true });
                if (!file || file.rawHash !== expected) throw damaged();
            }
            const pair = readPair(child);
            if (pair.state.branchId !== plan.branchId) throw damaged();
            inspectChat();
        });
    });
}
