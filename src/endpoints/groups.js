import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { color, getConfigValue, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { clearChatRecoveryState, createGroupChatTarget, markChatDeleted, runChatRecoveryBestEffort } from '../chat-recovery.js';
import { ensureEntityDateAdded, reconcileEntityDateAdded, removeEntityDateAdded } from '../entity-date-added.js';
import { removeChatMemory } from '../mewmory/store.js';
import { readRoleplayEntityLocked } from '../generation/roleplay-source.js';
import { commitRoleplayLifecycleLocked, commitSingleGroupUpdateLocked, roleplayTrackedInstance } from '../roleplay-lifecycle.js';
import { roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount, withUntrackedRoleplayFiles } from '../roleplay-store.js';

export const router = express.Router();
const isChatBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', 25, 'number'));
const getEntityDateAddedRoot = directories => directories.root || path.dirname(directories.groups);
const getGroupDateAddedFallback = stat => [stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs]
    .find(timestamp => Number.isFinite(timestamp) && timestamp > 0) ?? Date.now();

/**
 * Warns if group data contains deprecated metadata keys and removes them.
 * @param {object} groupData Group data object
 */
function warnOnGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return;
    }
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            console.warn(color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            let anyDataMigrated = false;
            const backupPath = path.join(userDirs.backups, '_group_metadata_update');
            const groupFiles = await fsPromises.readdir(userDirs.groups, { withFileTypes: true });
            // Capture addition dates before metadata migration rewrites group files.
            reconcileEntityDateAdded(
                getEntityDateAddedRoot(userDirs),
                'groups',
                groupFiles
                    .filter(groupFile => groupFile.isFile() && path.extname(groupFile.name) === '.json')
                    .map(groupFile => ({
                        groupFile,
                        filePath: path.join(userDirs.groups, groupFile.name),
                    }))
                    .map(({ groupFile, filePath }) => {
                        try {
                            return { id: groupFile.name, fallback: getGroupDateAddedFallback(fs.statSync(filePath)) };
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean),
            );
            for (const groupFile of groupFiles) {
                try {
                    const isJsonFile = groupFile.isFile() && path.extname(groupFile.name) === '.json';
                    if (!isJsonFile) {
                        continue;
                    }
                    const groupFilePath = path.join(userDirs.groups, groupFile.name);
                    const groupDataRaw = await fsPromises.readFile(groupFilePath, 'utf8');
                    const groupData = tryParse(groupDataRaw) || {};
                    const needsMigration = ['chat_metadata', 'past_metadata'].some(key => Object.hasOwn(groupData, key));
                    if (!needsMigration) {
                        continue;
                    }
                    if (!Array.isArray(groupData.chats)) {
                        console.warn(color.yellow(`Group ${groupFile.name} has no chats array, skipping migration.`));
                        continue;
                    }
                    const chats = groupData.chats.map(chatId => ({ chatId, filename: path.join(userDirs.groupChats, sanitize(`${chatId}.jsonl`)) }));
                    withUntrackedRoleplayFiles({ owner: path.basename(userDirs.root), directories: userDirs },
                        [groupFilePath, ...chats.map(chat => chat.filename)], () => {
                            if (fs.readFileSync(groupFilePath, 'utf8') !== groupDataRaw) throw new Error('Group changed during migration');
                            const allMetadata = { ...(groupData.past_metadata || {}), [groupData.chat_id]: groupData.chat_metadata || {} };
                            const updates = chats.map(({ chatId, filename }) => {
                                const raw = fs.readFileSync(filename, 'utf8');
                                const data = raw.split('\n').filter(line => line.trim()).map(line => tryParse(line)).filter(Boolean);
                                if (!data.length) throw new Error(`Group chat ${chatId} is unreadable`);
                                if (Object.hasOwn(data[0], 'chat_metadata')) return null;
                                const header = { chat_metadata: allMetadata[chatId] || {}, user_name: 'unused', character_name: 'unused' };
                                return { filename, text: [header, ...data].map(JSON.stringify).join('\n') };
                            }).filter(Boolean);
                            fs.mkdirSync(backupPath, { recursive: true });
                            fs.copyFileSync(groupFilePath, path.join(backupPath, groupFile.name));
                            for (const update of updates) {
                                fs.copyFileSync(update.filename, path.join(backupPath, path.basename(update.filename)));
                                writeFileAtomicSync(update.filename, update.text, { encoding: 'utf8' });
                            }
                            delete groupData.chat_metadata;
                            delete groupData.past_metadata;
                            writeFileAtomicSync(groupFilePath, JSON.stringify(groupData, null, 4), { encoding: 'utf8' });
                            anyDataMigrated = true;
                        });
                    console.log(`Migrated group chats metadata for group: ${groupData.id}`);
                } catch (groupError) {
                    console.error(color.red(`Could not process group file ${groupFile.name}`), groupError);
                }
            }
            if (anyDataMigrated) {
                console.log(color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
                console.log(color.cyan(`Backups of modified files are located at ${backupPath}`));
            }
        } catch (directoryError) {
            console.error(color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

router.post('/all', (request, response) => {
    const groups = [];

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    const files = fs.readdirSync(request.user.directories.groups).filter(x => path.extname(x) === '.json');
    const chats = fs.readdirSync(request.user.directories.groupChats).filter(x => path.extname(x) === '.jsonl');
    const chatFileSet = new Set(chats);
    const groupStats = new Map();
    const dateAddedEntries = files.map(file => {
        try {
            const fileStat = fs.statSync(path.join(request.user.directories.groups, file));
            groupStats.set(file, fileStat);
            return { id: file, fallback: getGroupDateAddedFallback(fileStat) };
        } catch {
            return null;
        }
    }).filter(Boolean);
    const dateAddedByFile = reconcileEntityDateAdded(
        getEntityDateAddedRoot(request.user.directories),
        'groups',
        dateAddedEntries,
    );
    let protectedError;

    files.forEach(function (file) {
        try {
            const filePath = path.join(request.user.directories.groups, file);
            const saved = withRoleplayAccount({ owner: request.user.profile.handle, directories: request.user.directories }, null,
                (lease, account) => {
                    const result = readRoleplayEntityLocked(lease, 'group', path.parse(file).name, { storage: true });
                    if (result.changed) saveRoleplayAccount(lease);
                    return { ...result, account };
                });
            const group = structuredClone(saved.data);
            const groupStat = groupStats.get(file) ?? fs.statSync(filePath);
            group.date_added = dateAddedByFile.get(file);
            group.create_date = new Date(groupStat.birthtimeMs).toISOString();

            let chat_size = 0;
            let date_last_chat = 0;
            let latestChatId = null;

            if (Array.isArray(group.chats)) {
                /** @type {string[]} */
                const normalizedChats = [];
                const seenChats = new Set();

                for (const rawChatId of group.chats) {
                    const chatId = String(rawChatId);
                    const chatFileName = sanitize(`${chatId}.jsonl`);

                    if (seenChats.has(chatId) || !chatFileSet.has(chatFileName)) {
                        continue;
                    }

                    seenChats.add(chatId);
                    normalizedChats.push(chatId);

                    const chatStat = fs.statSync(path.join(request.user.directories.groupChats, chatFileName));
                    chat_size += chatStat.size;

                    if (chatStat.mtimeMs >= date_last_chat) {
                        date_last_chat = chatStat.mtimeMs;
                        latestChatId = chatId;
                    }
                }

                // If at least one real group chat still exists, prefer the on-disk truth over
                // stale chat IDs that were saved without a corresponding JSONL.
                if (normalizedChats.length > 0) {
                    group.chats = normalizedChats;

                    if (!normalizedChats.includes(String(group.chat_id ?? ''))) {
                        group.chat_id = latestChatId ?? normalizedChats[normalizedChats.length - 1];
                    }
                }
            }

            group.date_last_chat = date_last_chat;
            group.chat_size = chat_size;
            group.__roleplay = { account: saved.account, locator: { kind: 'group', groupId: saved.locator.groupId },
                source: { instanceId: saved.instanceId, revision: saved.revision, rawHash: saved.rawHash } };
            groups.push(group);
        } catch (error) {
            if (error?.code?.startsWith('ROLEPLAY_')) protectedError = error;
            console.error(error);
        }
    });

    if (protectedError) return response.status(protectedError.status || 503).send({ error: protectedError.code });
    return response.send(groups);
});

/** The optional browser `roleplay` block: `{ account?, operationKey? }`. Unkeyed callers get a fresh identity. */
function lifecycleBlock(request) {
    if (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== request.user.profile.handle) {
        throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'The signed-in account changed.');
    }
    const block = request.body?.roleplay;
    if (block !== undefined && (!block || typeof block !== 'object' || Array.isArray(block)
        || Object.keys(block).some(key => !['account', 'operationKey'].includes(key))
        || (block.operationKey !== undefined && (typeof block.operationKey !== 'string' || !block.operationKey || block.operationKey.length > 200))
        || (block.account !== undefined && (!block.account || typeof block.account !== 'object' || typeof block.account.accountId !== 'string'
            || !Number.isSafeInteger(block.account.dataEpoch))))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay lifecycle request.', 400);
    }
    // ponytail: unkeyed extension callers get single-attempt semantics; the bundled browser sends a key.
    return { account: block?.account ?? null, operationKey: block?.operationKey ?? crypto.randomUUID() };
}

function sendLifecycleError(response, error) {
    console.error('Protected group lifecycle failed:', error);
    const code = String(error?.code ?? '').startsWith('ROLEPLAY_') ? error.code : 'ROLEPLAY_IO_ERROR';
    const uncertain = error?.roleplayWritePending || code === 'ROLEPLAY_WRITE_UNCERTAIN' || code === 'ROLEPLAY_RECOVERY_REQUIRED';
    const status = uncertain ? 503 : code === 'ROLEPLAY_STORE_FULL' ? 507 : code === 'ROLEPLAY_IO_ERROR' ? 503 : error.status || 409;
    return response.status(status).send({ error: code.slice(9).toLowerCase(), code });
}

const groupBase = request => ({ owner: request.user.profile.handle, directories: request.user.directories });

router.post('/create', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    try {
        const { account, operationKey } = lifecycleBlock(request);
        const body = { ...request.body };
        delete body.roleplay;
        warnOnGroupMetadata(body);
        const id = String(Date.now());
        const groupMetadata = {
            id: id,
            name: body.name ?? 'New Group',
            members: body.members ?? [],
            avatar_url: body.avatar_url,
            allow_self_responses: !!body.allow_self_responses,
            activation_strategy: body.activation_strategy ?? 0,
            generation_mode: body.generation_mode ?? 0,
            disabled_members: body.disabled_members ?? [],
            fav: body.fav,
            chat_id: body.chat_id ?? id,
            chats: body.chats ?? [id],
            generation_mode_join_prefix: body.generation_mode_join_prefix ?? '',
            generation_mode_join_suffix: body.generation_mode_join_suffix ?? '',
            conversation_settings: body.conversation_settings ?? {},
        };
        const saved = withRoleplayAccount(groupBase(request), account, (lease, current) => {
            const result = commitRoleplayLifecycleLocked(lease, { operationKey, action: 'group-create', intent: body,
                steps: [{ op: 'create', kind: 'group', locator: { groupId: id }, bytes: Buffer.from(JSON.stringify(groupMetadata, null, 4)) }],
                auxiliary: [{ task: 'date-added-create', entity: 'groups', id: `${id}.json`, time: Date.now() }] });
            // A replay answers with the group the first attempt created, not a second group.
            const resource = roleplayLease(lease).state.resources[result.instanceId];
            const data = resource.status === 'live'
                ? JSON.parse(fs.readFileSync(path.join(request.user.directories.groups, `${resource.locator.groupId}.json`), 'utf8'))
                : { id: resource.locator.groupId };
            return { data, account: current, result };
        });
        return response.send({ ...saved.data, __roleplay: { account: saved.account, locator: { kind: 'group', groupId: String(saved.data.id) },
            source: { instanceId: saved.result.instanceId, revision: saved.result.revision, rawHash: saved.result.rawHash } } });
    } catch (error) {
        return sendLifecycleError(response, error);
    }
});

router.post('/edit', getFileNameValidationFunction('id'), (request, response) => {
    if (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== request.user.profile.handle) return response.status(409).send({ error: 'account_changed' });
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    const { roleplay } = request.body;
    const group = { ...request.body };
    delete group.roleplay;
    delete group.__roleplay;
    if (!roleplay || !roleplay.account || !roleplay.source || typeof roleplay.operationKey !== 'string') {
        return response.status(400).send({ error: 'roleplay_required' });
    }
    try {
        const result = withRoleplayAccount({ owner: request.user.profile.handle, directories: request.user.directories }, roleplay.account,
            lease => commitSingleGroupUpdateLocked(lease, { operationKey: roleplay.operationKey, source: roleplay.source, group }));
        const fileName = sanitize(`${group.id}.json`);
        const pathToFile = path.join(request.user.directories.groups, fileName);
        try {
            ensureEntityDateAdded(getEntityDateAddedRoot(request.user.directories), 'groups', fileName,
                getGroupDateAddedFallback(fs.statSync(pathToFile)), Date.now());
        } catch (error) { console.warn('Could not preserve the group addition date:', error); }
        return response.send({ ok: true, roleplay: { account: roleplay.account, operationKey: roleplay.operationKey,
            changed: result.changed, rawChanged: result.rawChanged,
            source: { instanceId: result.instanceId, revision: result.revision, rawHash: result.rawHash } } });
    } catch (error) {
        const code = error.code || 'ROLEPLAY_WRITE_UNCERTAIN';
        const status = code === 'ROLEPLAY_STORE_FULL' ? 507 : error.status || (code === 'ROLEPLAY_WRITE_UNCERTAIN' ? 503 : 409);
        return response.status(status).send({ error: code.toLowerCase(), code });
    }
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = String(request.body.id);
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const dateAddedRoot = getEntityDateAddedRoot(request.user.directories);
    const groupFileName = path.basename(pathToGroup);

    try {
        const { account, operationKey } = lifecycleBlock(request);
        const handled = withRoleplayAccount(groupBase(request), account, lease => {
            const { state } = roleplayLease(lease);
            if (!state.submissions[roleplayHash([state.accountId, 'lifecycle', operationKey])]
                && !roleplayTrackedInstance(lease, 'group', { groupId: id })) return null;
            let chats = [];
            if (roleplayTrackedInstance(lease, 'group', { groupId: id })) {
                const group = readRoleplayEntityLocked(lease, 'group', id, { storage: true });
                if (group.changed) saveRoleplayAccount(lease);
                chats = [...new Set((group.data.chats ?? []).map(chat => path.parse(sanitize(`${chat}.jsonl`)).name).filter(Boolean))];
            }
            const locators = chats.map(chat => ({ group: true, chat }));
            return commitRoleplayLifecycleLocked(lease, { operationKey, action: 'group-delete', intent: { groupId: id },
                steps: [{ op: 'delete', kind: 'group', locator: { groupId: id } }, ...locators.map(locator => ({
                    op: roleplayTrackedInstance(lease, 'chat', locator) ? 'delete' : 'discard', kind: 'chat', locator }))],
                auxiliary: [...locators.flatMap(locator => [{ task: 'chat-memory-remove', locator }, { task: 'chat-recovery-clear', locator }]),
                    { task: 'date-added-remove', entity: 'groups', id: groupFileName }] },
            { backups: isChatBackupEnabled, recoveryTarget: locator => createGroupChatTarget({
                groupChatsDirectory: request.user.directories.groupChats, backupDirectory: request.user.directories.backups,
                filename: `${locator.chat}.jsonl`, maxRecoveryStates: maxTotalChatBackups }) });
        });
        if (handled) return response.send({ ok: true, roleplay: { operationKey, result: handled } });
    } catch (error) {
        return sendLifecycleError(response, error);
    }

    try {
        // Delete group chats
        const group = JSON.parse(fs.readFileSync(pathToGroup, 'utf8'));
        /** @type {ReturnType<typeof createGroupChatTarget>[]} */
        let recoveryTargets = [];
        const chatFiles = group && Array.isArray(group.chats) ? group.chats.map(chat => sanitize(`${chat}.jsonl`)) : [];
        withUntrackedRoleplayFiles(groupBase(request),
            [pathToGroup, ...chatFiles.map(chatFile => path.join(request.user.directories.groupChats, chatFile))], () => {
                recoveryTargets = chatFiles.map(chatFile => createGroupChatTarget({
                    groupChatsDirectory: request.user.directories.groupChats,
                    backupDirectory: request.user.directories.backups,
                    filename: chatFile,
                    maxRecoveryStates: maxTotalChatBackups,
                }));
                if (isChatBackupEnabled) {
                    // Neconyan: tombstones keep intentional group deletion from looking like recoverable loss.
                    for (const recoveryTarget of recoveryTargets) {
                        runChatRecoveryBestEffort(
                            () => markChatDeleted(recoveryTarget),
                            'Failed to mark chat recovery state for deletion; continuing with group deletion.',
                        );
                    }
                }
                for (const chatFile of chatFiles) {
                    console.info('Deleting group chat', chatFile);
                    const pathToFile = path.join(request.user.directories.groupChats, chatFile);

                    if (fs.existsSync(pathToFile)) {
                        fs.unlinkSync(pathToFile);
                    }
                    removeChatMemory(request.user.directories, { chat: path.parse(chatFile).name, group: true });
                }
                if (fs.existsSync(pathToGroup)) {
                    fs.unlinkSync(pathToGroup);
                }
            });
        try {
            removeEntityDateAdded(dateAddedRoot, 'groups', groupFileName);
        } catch (metadataError) {
            console.error('Could not remove date-added metadata after group deletion.', metadataError);
        }
        for (const recoveryTarget of recoveryTargets) {
            runChatRecoveryBestEffort(
                () => clearChatRecoveryState(recoveryTarget),
                'Failed to clear chat recovery state after group deletion.',
            );
        }
    } catch (error) {
        if (String(error?.code ?? '').startsWith('ROLEPLAY_')) return sendLifecycleError(response, error);
        console.error('Could not delete group chats. Clean them up manually.', error);
        return response.sendStatus(500);
    }

    return response.send({ ok: true });
});
