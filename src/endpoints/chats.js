import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { isDeepStrictEqual, TextDecoder, types } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';

import { acquireChatFileLock, withChatFileLocks } from '../chat-file-lock.js';
import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import { renameChatFile } from '../chat-rename.js';
import { captureBranchMemory, chatMemoryExists, removeChatMemory, renameChatMemory } from '../mewmory/store.js';
import { confirmRoleplayAccount, readRoleplayFile, readRoleplayWriteJournal, roleplayAvatarOwner, roleplayError, roleplayHash, roleplayLease, roleplayPathKey, saveRoleplayAccount, withRoleplayAccount, withUntrackedRoleplayFiles } from '../roleplay-store.js';
import { normaliseRoleplayLocator, readRoleplayChatLocked, roleplayChatPath, ROLEPLAY_METADATA_KEY } from '../generation/roleplay-source.js';
import { cleanupRoleplayReceiptsLocked, commitRoleplayLifecycleLocked, commitSingleChatImport, forgetRoleplayReceiptLocked, commitSingleChatWriteLocked, repairSingleChatWriteLocked, roleplayTrackedInstance } from '../roleplay-lifecycle.js';
import {
    clearChatRecoveryState,
    createCharacterChatTarget,
    createGroupChatTarget,
    getChatRecoveryPaths,
    isRecognizedChatHeader,
    loadActiveChatWithRecovery,
    markChatDeleted,
    normalizeChatRecoveryTarget,
    parseChatJsonl,
    readChatJsonlStrict,
    removeLatestChatSnapshotIfMatches,
    rekeyChatRecoveryState,
    runChatRecoveryBestEffort,
    seedLatestChatSnapshot,
    writeLatestChatSnapshot,
} from '../chat-recovery.js';
import {
    getConfigValue,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    color,
    recoverFileWriteSync,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    isPathUnderParent,
    uuidv4,
    decodeFileWriteRecovery,
} from '../util.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', 25, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');
const isBackupLoggingEnabled = !!getConfigValue('backups.chat.logging', false, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';
const CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX = 'chat_forced_overwrite_';
const CHAT_PRE_WRITE_BACKUPS_PREFIX = 'chat_pre_write_';
const PRE_WRITE_BACKUP_RING_SIZE = 3;

/**
 * Trims regular chat backups only. `CHAT_BACKUPS_PREFIX` is a prefix of the pre-write and
 * forced-overwrite prefixes, so a plain prefix sweep would also rotate away those recovery layers.
 * @param {string} directory The user's backup directory.
 * @param {number} limit Maximum number of regular chat backups to keep.
 */
export function removeOldRegularChatBackups(directory, limit) {
    const reservedPrefixes = [CHAT_PRE_WRITE_BACKUPS_PREFIX, CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX];
    const files = fs.readdirSync(directory)
        .filter(file => file.startsWith(CHAT_BACKUPS_PREFIX) && !reservedPrefixes.some(reserved => file.startsWith(reserved)))
        .map(file => path.join(directory, file))
        .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);

    while (files.length > limit) {
        const oldest = files.shift();
        if (!oldest) {
            break;
        }

        fs.unlinkSync(oldest);
    }
}

function logBackupEvent(action, details = {}) {
    if (!isBackupLoggingEnabled) {
        return;
    }

    const fields = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
    console.info(color.cyan(`[Backup] ${action}${fields ? ` ${fields}` : ''}`));
}

function getSerializedBackupSizeDetails(data) {
    const sizeBytes = Buffer.byteLength(String(data ?? ''), 'utf8');
    return {
        bytes: sizeBytes,
        size: formatBytes(sizeBytes),
    };
}

function getChatBackupType(backupPrefix) {
    if (backupPrefix === CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX) {
        return 'forced-overwrite';
    }

    if (backupPrefix === CHAT_PRE_WRITE_BACKUPS_PREFIX) {
        return 'pre-write';
    }

    return 'regular';
}

function normalizeSerializedChatForBackupComparison(data) {
    const serialized = String(data ?? '');
    const lines = serialized.split('\n');

    if (!lines[0]) {
        return serialized;
    }

    try {
        const header = JSON.parse(lines[0]);
        if (!isPlainObject(header?.chat_metadata)) {
            return serialized;
        }

        const chatMetadata = { ...header.chat_metadata };
        delete chatMetadata.integrity;
        lines[0] = JSON.stringify({ ...header, chat_metadata: chatMetadata });
        return lines.join('\n');
    } catch {
        return serialized;
    }
}

function getSerializedChatIntegrity(serializedChat) {
    const headerLine = String(serializedChat ?? '').split('\n').find(line => line.trim());
    if (!headerLine) {
        return '';
    }

    try {
        const integrity = JSON.parse(headerLine.replace(/^\uFEFF/, ''))?.chat_metadata?.integrity;
        return typeof integrity === 'string' && integrity ? integrity : '';
    } catch {
        return '';
    }
}

function normalizeChatMessageExtraForComparison(extra) {
    if (!isPlainObject(extra)) {
        return extra;
    }

    const normalized = JSON.parse(JSON.stringify(extra));
    if (Object.hasOwn(normalized, 'file')) {
        normalized.files = Array.isArray(normalized.files) ? normalized.files : [];
        if (normalized.file) {
            normalized.files.push(normalized.file);
        }
        delete normalized.file;
    }
    if (Array.isArray(normalized.image_swipes)) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        for (const imageUrl of normalized.image_swipes) {
            if (typeof imageUrl === 'string' && imageUrl) {
                normalized.media_display = 'gallery';
                normalized.media.push({ type: 'image', url: imageUrl });
            }
        }
        delete normalized.image_swipes;
    }
    if (Object.hasOwn(normalized, 'image')) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        const imageUrl = normalized.image;
        if (typeof imageUrl === 'string' && imageUrl) {
            normalized.media.push({ type: 'image', url: imageUrl });
        }
        if (normalized.media_display === 'gallery') {
            const selectedIndex = normalized.media.findIndex(media => media.url === imageUrl);
            if (selectedIndex > -1) {
                normalized.media_index = selectedIndex;
            }
        }
        normalized.media = normalized.media.filter((media, index, allMedia) => index === allMedia.findIndex(other => other.url === media.url));
        delete normalized.image;
    }
    if (Object.hasOwn(normalized, 'video')) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        if (typeof normalized.video === 'string' && normalized.video) {
            normalized.media.push({ type: 'video', url: normalized.video });
        }
        delete normalized.video;
    }
    return normalized;
}

function normalizeChatMessageForComparison(message, chatMetadata, messageCount) {
    // Reparse JSONL data so retained and synthesized nested values share one realm for strict comparison.
    const normalized = JSON.parse(JSON.stringify(message));
    normalized.extra = normalizeChatMessageExtraForComparison(normalized.extra);
    if (normalized.is_user || normalized.extra?.isSmallSys) {
        return normalized;
    }

    if (!Array.isArray(normalized.swipes)) {
        normalized.swipes = [normalized.mes ?? ''];
    }
    if (typeof normalized.swipe_id !== 'number') {
        normalized.swipe_id = 0;
    }
    const createSwipeInfo = () => {
        const info = { extra: {} };
        for (const key of ['send_date', 'gen_started', 'gen_finished']) {
            if (normalized[key] !== undefined) {
                info[key] = normalized[key];
            }
        }
        return info;
    };
    if (!Array.isArray(normalized.swipe_info)) {
        normalized.swipe_info = normalized.swipes.map(createSwipeInfo);
    }
    for (let index = 0; index < normalized.swipes.length; index++) {
        if (typeof normalized.swipes[index] !== 'string') {
            normalized.swipes[index] = '';
        }
        if (!isPlainObject(normalized.swipe_info[index])) {
            normalized.swipe_info[index] = createSwipeInfo();
        }
    }

    const activeSwipe = normalized.swipe_id;
    if (typeof normalized.swipes[activeSwipe] === 'string' && isPlainObject(normalized.swipe_info[activeSwipe])) {
        if (chatMetadata.tainted || messageCount > 1) {
            normalized.swipes[activeSwipe] = normalized.mes;
        }
        const swipeInfo = normalized.swipe_info[activeSwipe];
        for (const key of ['send_date', 'gen_started', 'gen_finished']) {
            if (normalized[key] === undefined) {
                delete swipeInfo[key];
            } else {
                swipeInfo[key] = normalized[key];
            }
        }
        if (normalized.extra === undefined) {
            delete swipeInfo.extra;
        } else {
            swipeInfo.extra = JSON.parse(JSON.stringify(normalized.extra));
        }
    }
    return normalized;
}

function getChatSaveComparisonRecords(data, { ignoreDerivedMetadata = true, ignoreRoleplayMarker = false } = {}) {
    const parsedChat = Array.isArray(data)
        ? { status: isValidChatSavePayload(data) ? 'ok' : 'invalid', records: data }
        : parseChatJsonl(String(data ?? ''));
    if (parsedChat.status !== 'ok') {
        return null;
    }

    const [header, ...messages] = parsedChat.records;
    const chatMetadata = { ...header.chat_metadata };
    delete chatMetadata.integrity;
    if (ignoreRoleplayMarker) delete chatMetadata.neconyan_roleplay;
    if (ignoreDerivedMetadata) {
        delete chatMetadata.chat_id_hash;
        if (isPlainObject(chatMetadata.variables) && Object.keys(chatMetadata.variables).length === 0) {
            delete chatMetadata.variables;
        }
    }

    // Neconyan: chat loads retain chat_metadata but discard and recreate the outer header envelope.
    return [
        { chat_metadata: chatMetadata },
        ...messages.map(message => normalizeChatMessageForComparison(message, chatMetadata, messages.length)),
    ];
}

function isSameChatSaveContent(left, right, options = {}) {
    const leftRecords = getChatSaveComparisonRecords(left, options);
    const rightRecords = getChatSaveComparisonRecords(right, options);
    return leftRecords !== null && rightRecords !== null && isDeepStrictEqual(leftRecords, rightRecords);
}

// Neconyan: true when the incoming save keeps the existing metadata and every message unchanged
// and in order, so it can only append without rolling back another client's metadata changes.
function isChatSaveExtension(newSerializedChat, existingSerializedChat, options = {}) {
    const incomingRecords = getChatSaveComparisonRecords(newSerializedChat, options);
    const existingRecords = getChatSaveComparisonRecords(existingSerializedChat, options);
    if (incomingRecords === null || existingRecords === null) {
        return false;
    }

    const [incomingHeader, ...incomingMessages] = incomingRecords;
    const [existingHeader, ...existingMessages] = existingRecords;
    return isDeepStrictEqual(incomingHeader, existingHeader)
        && incomingMessages.length >= existingMessages.length
        && isDeepStrictEqual(incomingMessages.slice(0, existingMessages.length), existingMessages);
}

function getLatestBackupFilePath(directory, prefix) {
    const backupFiles = fs.readdirSync(directory)
        .filter(fileName => fileName.startsWith(prefix))
        .map(fileName => ({
            fileName,
            filePath: path.join(directory, fileName),
        }))
        .sort((a, b) => {
            const mtimeDifference = fs.statSync(b.filePath).mtimeMs - fs.statSync(a.filePath).mtimeMs;
            return mtimeDifference || b.fileName.localeCompare(a.fileName);
        });

    return backupFiles[0]?.filePath ?? null;
}

function isDuplicateRegularChatBackup(directory, backupPrefix, data) {
    const latestBackupFile = getLatestBackupFilePath(directory, backupPrefix);
    if (!latestBackupFile) {
        return false;
    }

    const latestBackupData = tryReadFileSync(latestBackupFile);
    return Boolean(latestBackupData)
        && normalizeSerializedChatForBackupComparison(latestBackupData) === normalizeSerializedChatForBackupComparison(data);
}

function isDuplicatePreWriteBackup(directory, backupPrefix, data) {
    const prefix = `${backupPrefix}`;
    const latestBackupFile = getLatestBackupFilePath(directory, prefix);
    if (!latestBackupFile) {
        return false;
    }

    const latestBackupData = tryReadFileSync(latestBackupFile);
    return Boolean(latestBackupData)
        && normalizeSerializedChatForBackupComparison(latestBackupData) === normalizeSerializedChatForBackupComparison(data);
}

function getChatBackupName(name) {
    const normalized = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    // ponytail: 160 ASCII bytes leave room for the longest prefix, timestamp, UUID and the writer's 11-byte temporary suffix.
    return normalized.length <= 160 ? normalized : `${normalized.slice(0, 95)}_${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @param {string} handle User handle for diagnostic logging.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX, handle = '') {
    const originalName = name;
    const backupType = getChatBackupType(backupPrefix);
    try {
        if (!isBackupEnabled) {
            logBackupEvent('chat-backup-skipped', { type: backupType, handle, chat: originalName, reason: 'disabled' });
            return;
        }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
            logBackupEvent('chat-backup-skipped', { type: backupType, handle, chat: originalName, reason: 'missing-directory' });
            return;
        }
        name = getChatBackupName(name);
        const prefix = `${backupPrefix}${name}_`;
        const sizeDetails = getSerializedBackupSizeDetails(data);

        if (backupPrefix === CHAT_BACKUPS_PREFIX && isDuplicateRegularChatBackup(directory, prefix, data)) {
            logBackupEvent('chat-backup-skipped', {
                type: backupType,
                handle,
                chat: originalName,
                sanitizedName: name,
                reason: 'duplicate',
                ...sizeDetails,
            });
            return;
        }

        const backupFile = path.join(directory, `${prefix}${generateTimestamp()}_${uuidv4()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        logBackupEvent('chat-backup-written', {
            type: backupType,
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        removeOldBackups(directory, prefix);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        if (backupPrefix === CHAT_BACKUPS_PREFIX) {
            removeOldRegularChatBackups(directory, maxTotalChatBackups);
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

function backupChatPreWrite(directory, name, data, handle = '') {
    const originalName = name;
    try {
        if (!isBackupEnabled) {
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'disabled' });
            return;
        }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'missing-directory' });
        }
        name = getChatBackupName(name);
        const sizeDetails = getSerializedBackupSizeDetails(data);

        if (isDuplicatePreWriteBackup(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_`, data)) {
            logBackupEvent('chat-backup-skipped', {
                type: 'pre-write',
                handle,
                chat: originalName,
                sanitizedName: name,
                reason: 'duplicate',
                ...sizeDetails,
            });
            return;
        }

        const backupFile = path.join(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_${generateTimestamp()}_${uuidv4()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        logBackupEvent('chat-backup-written', {
            type: 'pre-write',
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        removeOldBackups(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_`, PRE_WRITE_BACKUP_RING_SIZE);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, CHAT_PRE_WRITE_BACKUPS_PREFIX, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not create pre-write chat backup for ${name}`, err);
        throw err;
    }
}

function countSerializedChatLines(serializedChat) {
    if (!serializedChat) {
        return 0;
    }

    return String(serializedChat).split('\n').filter(line => line.trim()).length;
}

function isSuspiciousChatShrink(newData, existingSerializedChat) {
    const existingLines = countSerializedChatLines(existingSerializedChat);
    if (existingLines <= 5) {
        return false;
    }

    return Array.isArray(newData) && newData.length < existingLines * 0.5;
}

/**
 * Classifies a save that would replace an existing chat with substantially less content.
 * A chat payload carries one metadata header, so a length below two rows has no messages at all.
 * @param {Array} newData Incoming chat array.
 * @param {string} existingSerializedChat Current serialized chat on disk.
 * @returns {''|'emptied'|'shrink'} Reason the save is destructive, or an empty string.
 */
function getDestructiveChatSaveReason(newData, existingSerializedChat) {
    const existingLines = countSerializedChatLines(existingSerializedChat);
    if (existingLines < 2 || !Array.isArray(newData)) {
        return '';
    }

    if (newData.length < 2) {
        return 'emptied';
    }

    return isSuspiciousChatShrink(newData, existingSerializedChat) ? 'shrink' : '';
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

// Neconyan: track active deferred save sequences (e.g. multi-step in-chat agent runs).
// A deferred run captures one pre-write snapshot of the pre-run on-disk state before the first
// intermediate mutation, and suppresses redundant pre-write churn during subsequent in-flight passes (#373).
const deferredPreWriteBackupSequences = new Map();

function normalizeDeferredBackupPath(filePath) {
    return path.resolve(filePath);
}

function hasDeferredSequenceId(deferSequenceId) {
    return deferSequenceId !== undefined && deferSequenceId !== null && String(deferSequenceId).trim().length > 0;
}

export function clearActiveDeferredChatPreWrites() {
    deferredPreWriteBackupSequences.clear();
}

function getDeferredPreWriteBackupDecision({
    filePath,
    deferBackup,
    deferSequenceId,
}) {
    const normalizedPath = normalizeDeferredBackupPath(filePath);
    const hasSequence = hasDeferredSequenceId(deferSequenceId);
    const activeSequence = deferredPreWriteBackupSequences.get(normalizedPath);

    // No token means this is an unrelated ordinary save. It must always retain
    // normal pre-write backup behavior and clear any stale abandoned sequence.
    if (!hasSequence) {
        return {
            normalizedPath,
            shouldCreateBackup: true,
            closeSequence: false,
            clearActiveSequenceAfterSuccess: Boolean(activeSequence),
        };
    }

    if (deferBackup === true) {
        if (activeSequence === deferSequenceId) {
            return {
                normalizedPath,
                shouldCreateBackup: false,
                closeSequence: false,
            };
        }

        // First save of this sequence: preserve the pre-turn baseline.
        return {
            normalizedPath,
            shouldCreateBackup: true,
            beginSequence: true,
            closeSequence: false,
        };
    }

    // Closing save. Only the matching sequence may skip the redundant backup.
    if (activeSequence === deferSequenceId) {
        return {
            normalizedPath,
            shouldCreateBackup: false,
            closeSequence: true,
        };
    }

    // A closing save with no matching active sequence is an ordinary save.
    return {
        normalizedPath,
        shouldCreateBackup: true,
        closeSequence: false,
    };
}

function commitDeferredPreWriteBackupDecision(decision, deferSequenceId) {
    if (decision.beginSequence) {
        deferredPreWriteBackupSequences.set(
            decision.normalizedPath,
            deferSequenceId,
        );
    }

    if (decision.closeSequence || decision.clearActiveSequenceAfterSuccess) {
        deferredPreWriteBackupSequences.delete(decision.normalizedPath);
    }
}

function clearDeferredPreWriteBackupSequence(filePath) {
    deferredPreWriteBackupSequences.delete(
        normalizeDeferredBackupPath(filePath),
    );
}

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData, timestamp) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date(timestamp).toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date(timestamp).toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData, timestamp) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date(timestamp).toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData, timestamp) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date(timestamp).toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    return (jsonData.histories.histories ?? []).map(history => convert(history).map(obj => JSON.stringify(obj)).join('\n'));
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data, timestamp) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date(timestamp).toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData, timestamp) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? timestamp)).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/** Convert one uploaded file completely before any import destination is published. */
export function convertImportedChatFile(bytes, { format, userName, characterName, timestamp }) {
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new InvalidChatDataError('Invalid chat import.');
    let data;
    try { data = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new InvalidChatDataError('Invalid chat text encoding.'); }
    if (format === 'jsonl') {
        const first = data.split('\n').find(line => line.trim());
        let header;
        try { header = JSON.parse(first); } catch { throw new InvalidChatDataError('Invalid chat JSONL header.'); }
        if (!isRecognizedChatHeader(header)) throw new InvalidChatDataError('Invalid chat JSONL header.');
        return [flattenChubChat(userName, characterName, data.split('\n'))];
    }
    if (format !== 'json') throw new InvalidChatDataError('Unsupported chat import format.');
    let json;
    try { json = JSON.parse(data); } catch { throw new InvalidChatDataError('Invalid chat JSON.'); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new InvalidChatDataError('Invalid chat JSON.');
    const converter = json.savedsettings !== undefined ? importKoboldLiteChat
        : json.histories !== undefined ? importCAIChat
            : Array.isArray(json.data_visible) ? importOobaChat
                : Array.isArray(json.messages) ? importAgnaiChat
                    : json.type === 'risuChat' ? importRisuChat : null;
    if (!converter) throw new InvalidChatDataError('Unsupported chat JSON format.');
    let converted;
    try { converted = converter(userName, characterName, json, timestamp); } catch { throw new InvalidChatDataError('Invalid chat JSON data.'); }
    return Array.isArray(converted) ? converted : [converted];
}

function assertNativeChatPath(filePath) {
    let stats;
    try {
        stats = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') throw Object.assign(new IntegrityMismatchError('Native chat source is missing.'), { code: 'ESTALE' });
        throw error;
    }
    if (!stats.isFile() || stats.nlink !== 1n || fs.realpathSync(filePath) !== path.resolve(filePath)) {
        throw Object.assign(new Error(`Chat path is unsafe for native mutation: ${filePath}`), { code: 'EINVAL' });
    }
}

function readChatFileSnapshot(filePath, { strict = false, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
    let initialPathStats;
    try {
        initialPathStats = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (!initialPathStats.isFile() && !initialPathStats.isSymbolicLink()) {
        throw Object.assign(new Error(`Chat path is not a regular file: ${filePath}`), { code: 'EINVAL' });
    }
    if (strict) assertNativeChatPath(filePath);

    const fileDescriptor = fs.openSync(filePath, strict
        ? fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
        : 'r');
    try {
        const initialDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
        if (!initialDescriptorStats.isFile() || initialDescriptorStats.size > BigInt(maxBytes)) {
            throw Object.assign(new Error(`Chat file cannot be read safely: ${filePath}`), { code: 'EINVAL' });
        }
        const data = Buffer.alloc(Number(initialDescriptorStats.size));
        let offset = 0;
        while (offset < data.byteLength) {
            const bytesRead = fs.readSync(fileDescriptor, data, offset, data.byteLength - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }

        const finalDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
        const finalPathStats = fs.lstatSync(filePath, { bigint: true });
        const pathChanged = finalPathStats.dev !== initialPathStats.dev || finalPathStats.ino !== initialPathStats.ino;
        const descriptorChanged = finalDescriptorStats.dev !== initialDescriptorStats.dev
            || finalDescriptorStats.ino !== initialDescriptorStats.ino
            || finalDescriptorStats.size !== initialDescriptorStats.size
            || finalDescriptorStats.mtimeNs !== initialDescriptorStats.mtimeNs
            || finalDescriptorStats.ctimeNs !== initialDescriptorStats.ctimeNs;
        const regularPathChangedTarget = initialPathStats.isFile()
            && (initialDescriptorStats.dev !== initialPathStats.dev || initialDescriptorStats.ino !== initialPathStats.ino);
        if (pathChanged || descriptorChanged || regularPathChangedTarget || offset !== data.byteLength
            || (strict && finalDescriptorStats.nlink !== 1n)) {
            throw Object.assign(new Error(`Chat file changed while it was being read: ${filePath}`), { code: 'ESTALE' });
        }

        return {
            data: strict ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) : data.toString('utf8'),
            hash: crypto.createHash('sha256').update(data).digest('hex'),
            pathStats: initialPathStats,
            descriptorStats: initialDescriptorStats,
        };
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function assertChatFileSnapshotCurrent(filePath, expectedSnapshot, options) {
    const currentSnapshot = readChatFileSnapshot(filePath, options);
    if (!currentSnapshot
        || currentSnapshot.pathStats.dev !== expectedSnapshot.pathStats.dev
        || currentSnapshot.pathStats.ino !== expectedSnapshot.pathStats.ino
        || currentSnapshot.hash !== expectedSnapshot.hash) {
        throw Object.assign(new Error(`Chat file changed after it was checked: ${filePath}`), { code: 'ESTALE' });
    }
}

function repairRejectedChatRecoverySnapshot(recoveryTarget, rejectedSnapshotData) {
    runChatRecoveryBestEffort(() => {
        const refreshedSnapshot = seedLatestChatSnapshot(recoveryTarget);
        if (!refreshedSnapshot.seeded) {
            removeLatestChatSnapshotIfMatches(recoveryTarget, rejectedSnapshotData);
        }
    }, 'Failed to reconcile chat recovery after a rejected save.');
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {number} [token_estimate] - The approximate number of tokens in the chat
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null, previewMessageLimit = 0) {
    try {
        const parsedPath = path.parse(pathToFile);
        const stats = await fs.promises.stat(pathToFile);
        const hasMatcher = (typeof matcher === 'function');

        const chatData = {
            match: false,
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: formatBytes(stats.size),
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
            last_mes: stats.mtimeMs,
            ...additionalData,
        };

        if (stats.size === 0) {
            return chatData;
        }

        const fileStream = fs.createReadStream(pathToFile);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        return await new Promise((res, rej) => {
            let lastLine;
            let itemCounter = 0;
            let hasAnyMatch = false;
            let matchBuffer = [];
            let messageCharacters = 0;
            const previewMessages = [];
            const previewLimit = Math.max(0, Number(previewMessageLimit) || 0);

            fileStream.once('error', rej);
            rl.once('error', rej);

            rl.on('line', (line) => {
                const isMessageLine = itemCounter > 0;
                let jsonData = null;

                if (withMetadata && !isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                        chatData.chat_metadata = jsonData.chat_metadata;
                    }
                }

                if (isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData) {
                        messageCharacters += String(jsonData.mes ?? '').length;

                        // Skip matching if any match was already found
                        if (hasMatcher && !hasAnyMatch) {
                            matchBuffer.push(jsonData.mes || '');
                            if (matcher(matchBuffer)) {
                                hasAnyMatch = true;
                                matchBuffer = [];
                            }
                        }

                        if (previewLimit > 0) {
                            previewMessages.push(jsonData);
                            if (previewMessages.length > previewLimit) {
                                previewMessages.shift();
                            }
                        }
                    }
                }
                itemCounter++;
                lastLine = line;
            });
            rl.on('close', () => {
                rl.close();

                if (!lastLine) {
                    res(chatData);
                    return;
                }

                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    // Neconyan: expose a cheap chat length indicator for chat selectors.
                    chatData.token_estimate = Math.round(messageCharacters / 4);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;
                    if (previewLimit > 0) {
                        chatData.preview_messages = previewMessages;
                    }

                    res(chatData);
                } else {
                    console.warn('Found an invalid or corrupted chat file:', pathToFile);
                    res({});
                }
            });
        });
    } catch (error) {
        console.error('Failed to read chat info:', pathToFile, error);
        return {};
    }
}

export async function getListableGroupChatInfo(chatFilePath, id) {
    const chatInfo = await getChatInfo(chatFilePath);
    const fileName = String(chatInfo?.file_name ?? '').trim();

    if (fileName) {
        return chatInfo;
    }

    const fallbackFileName = sanitize(`${id}.jsonl`);
    const fallbackFileId = path.parse(fallbackFileName).name;
    const normalizedChatInfo = chatInfo && typeof chatInfo === 'object' ? chatInfo : {};

    // Neconyan: keep corrupted group chats visible so chat selectors do not enter empty-list retry storms.
    return {
        ...normalizedChatInfo,
        file_id: String(normalizedChatInfo.file_id ?? '').trim() || fallbackFileId,
        file_name: fallbackFileName,
    };
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

export class InvalidChatDataError extends Error {
    constructor(...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, InvalidChatDataError);
        }
        this.date = new Date();
    }
}

// Neconyan: a save that would destroy an existing chat is rejected unless the client forces it.
class DestructiveChatSaveError extends Error {
    constructor(reason, ...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, DestructiveChatSaveError);
        }
        this.reason = reason;
        this.date = new Date();
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidChatSavePayload(chatData) {
    return Array.isArray(chatData)
        && chatData.length > 0
        && isPlainObject(chatData[0])
        && isPlainObject(chatData[0].chat_metadata)
        && chatData.every(isPlainObject);
}

function createChatRecoveryTarget(request, isGroup, fileName) {
    if (isGroup) {
        return createGroupChatTarget({
            groupChatsDirectory: request.user.directories.groupChats,
            backupDirectory: request.user.directories.backups,
            filename: fileName,
            maxRecoveryStates: maxTotalChatBackups,
        });
    }

    return createCharacterChatTarget({
        chatsDirectory: request.user.directories.chats,
        backupDirectory: request.user.directories.backups,
        owner: roleplayAvatarOwner(String(request.body.avatar_url)),
        filename: fileName,
        maxRecoveryStates: maxTotalChatBackups,
    });
}

const ROLEPLAY_CHAT_MAX_BYTES = 64 * 1024 * 1024;
const ROLEPLAY_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function roleplayRequest(request, group, saving = false) {
    const base = { owner: request.user.profile.handle, directories: request.user.directories };
    if (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== base.owner) {
        throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'The selected account changed. Reload before continuing.');
    }
    const body = request.body;
    const name = group && Number.isSafeInteger(body?.id) ? String(body.id) : group ? body?.id : body?.file_name;
    const locator = normaliseRoleplayLocator(group ? { group: true, chat: name } : { group: false, chat: name, avatar: body?.avatar_url });
    if (locator.chat + '.jsonl' !== sanitize(locator.chat + '.jsonl')) throw roleplayError('ROLEPLAY_INVALID', 'The chat filename is too long.', 400);
    const block = body?.roleplay;
    const invalid = () => roleplayError('ROLEPLAY_REQUIRED', 'Reload the chat before saving; its account and source versions are required.', 400);
    if (saving || block !== undefined) {
        if (!isPlainObject(block) || Object.keys(block).some(key => !['account', 'operationKey', 'source', 'vacancy'].includes(key))
            || !isPlainObject(block.account) || Object.keys(block.account).some(key => !['accountId', 'dataEpoch'].includes(key))
            || typeof block.account.accountId !== 'string' || !ROLEPLAY_UUID.test(block.account.accountId)
            || !Number.isSafeInteger(block.account.dataEpoch) || block.account.dataEpoch < 1) throw invalid();
    }
    if (saving) {
        // 'job:' keys belong to server job completions; a client save must not satisfy one.
        if (typeof block.operationKey !== 'string' || !block.operationKey || block.operationKey.length > 256 || block.operationKey.startsWith('job:')
            || Object.hasOwn(block, 'source') === Object.hasOwn(block, 'vacancy')) throw invalid();
        if (Object.hasOwn(block, 'source')) {
            if (!isPlainObject(block.source) || Object.keys(block.source).some(key => !['instanceId', 'revision', 'rawHash'].includes(key))
                || typeof block.source.instanceId !== 'string' || !ROLEPLAY_UUID.test(block.source.instanceId)
                || !Number.isSafeInteger(block.source.revision) || block.source.revision < 1
                || typeof block.source.rawHash !== 'string' || !/^[a-f0-9]{64}$/.test(block.source.rawHash)) throw invalid();
        } else if (!Number.isSafeInteger(block.vacancy) || block.vacancy < 0) throw invalid();
        if (['force', 'allowShrink', 'deferBackup'].some(key => body[key] !== undefined && typeof body[key] !== 'boolean')
            || (body.deferSequenceId !== undefined && (typeof body.deferSequenceId !== 'string' || body.deferSequenceId.length > 256))) throw invalid();
    }
    return { base, locator, block, account: block?.account ?? null };
}

function wireChatSource({ instanceId, revision, rawHash }) {
    return { instanceId, revision, rawHash };
}

function setRoleplayResponseEvidence(response, evidence) {
    // HTTP headers are ASCII; JSON escapes preserve the exact Unicode locator without a second encoding.
    const header = JSON.stringify(evidence).replace(/[^\x20-\x7E]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'));
    response.set('X-Neconyan-Roleplay', header);
}

function assertUnmarkedLegacyChat(bytes) {
    // A broken later message must not hide ownership in the first non-empty header.
    const parsed = parseChatJsonl(bytes.toString('utf8').trimStart().split('\n', 1)[0]);
    if (parsed.records?.[0]?.chat_metadata?.[ROLEPLAY_METADATA_KEY]) {
        throw roleplayError('ROLEPLAY_FOREIGN_SOURCE', 'Import this native chat as a new copy; its marker cannot establish ownership.');
    }
}

function assertLegacyPhysicalIdentity(state, physical) {
    if (Object.values(state.resources).some(({ head }) => head.physical.dev === physical.dev && head.physical.ino === physical.ino
        && (physical.birthtimeNs === null || head.physical.birthtimeNs === physical.birthtimeNs))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'This file already has a protected identity at another location.');
    }
}

function assertUntrackedLegacyEvidence(state, file, journal) {
    if (file) {
        assertUnmarkedLegacyChat(file.bytes);
        assertLegacyPhysicalIdentity(state, file.physical);
    }
    if (journal) {
        assertLegacyPhysicalIdentity(state, journal.physical);
        const record = decodeFileWriteRecovery(journal.bytes, ROLEPLAY_CHAT_MAX_BYTES);
        if (!record) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The earlier chat write needs explicit recovery.');
        assertLegacyPhysicalIdentity(state, { dev: record.dev, ino: record.ino, birthtimeNs: record.birthtime });
        assertUnmarkedLegacyChat(Buffer.from(JSON.parse(journal.bytes.toString('utf8')).originalData, 'base64'));
    }
}

function loadLegacyChatForEnrolment(lease, target) {
    const { state } = roleplayLease(lease);
    const active = readRoleplayFile(target.activePath, ROLEPLAY_CHAT_MAX_BYTES, { allowMissingParent: true });
    const journal = readRoleplayWriteJournal(target.activePath, { allowMissingParent: true });
    assertUntrackedLegacyEvidence(state, active, journal);
    if (isBackupEnabled) {
        const inspection = runChatRecoveryBestEffort(
            () => {
                const { latestPath } = getChatRecoveryPaths(target);
                return { file: readRoleplayFile(latestPath, ROLEPLAY_CHAT_MAX_BYTES, { allowMissingParent: true }),
                    journal: readRoleplayWriteJournal(latestPath, { allowMissingParent: true }) };
            },
            'Failed to inspect chat recovery state; continuing without sidecar recovery.',
        );
        if (!inspection.ok) return readChatJsonlStrict(target.activePath);
        assertUntrackedLegacyEvidence(state, inspection.value.file, inspection.value.journal);
    }
    // Only untracked legacy content may use legacy recovery. Protected content never reaches it.
    return isBackupEnabled ? loadActiveChatWithRecovery(target) : readChatJsonlStrict(target.activePath);
}

function loadProtectedChat(request, group) {
    const { base, locator, account } = roleplayRequest(request, group);
    return withRoleplayAccount(base, account, (lease, currentAccount) => {
        confirmRoleplayAccount(lease);
        const { state } = roleplayLease(lease);
        if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier chat write must settle first.');
        cleanupRoleplayReceiptsLocked(lease);
        const target = createChatRecoveryTarget(request, group, locator.chat + '.jsonl');
        const slot = state.paths[roleplayPathKey(state, 'chat', locator)];
        if (!slot) {
            const legacy = loadLegacyChatForEnrolment(lease, target);
            if (legacy.status !== 'ok' && legacy.status !== 'missing') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The chat needs recovery.', 422);
        }
        const file = readRoleplayFile(target.activePath, ROLEPLAY_CHAT_MAX_BYTES, { allowMissingParent: true });
        if (!file && !slot?.instanceId && request.body.allow_create === true) {
            return { records: [], evidence: { account: currentAccount, locator, vacancy: slot?.generation ?? 0 } };
        }
        if (!file) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved chat does not exist.', 404);
        let saved;
        try { saved = readRoleplayChatLocked(lease, locator); } catch (error) {
            if (error.code !== 'ROLEPLAY_SOURCE_DAMAGED' || !slot?.instanceId || !isBackupEnabled) throw error;
            const inspection = runChatRecoveryBestEffort(
                () => readRoleplayFile(getChatRecoveryPaths(target).latestPath, ROLEPLAY_CHAT_MAX_BYTES, { allowMissingParent: true }),
                'Failed to inspect the exact recorded chat snapshot; retaining the damaged chat.',
            );
            const snapshot = inspection.ok ? inspection.value : null;
            if (!snapshot || snapshot.rawHash !== state.resources[slot.instanceId].head.rawHash) throw error;
            repairSingleChatWriteLocked(lease, { locator, snapshotBytes: snapshot.bytes }, roleplayNativeHost);
            saved = readRoleplayChatLocked(lease, locator);
        }
        if (saved.changed) saveRoleplayAccount(lease);
        return { records: saved.records, evidence: { account: currentAccount, locator, source: wireChatSource(saved) } };
    });
}

function saveProtectedChat(request, group) {
    const { base, locator, block, account } = roleplayRequest(request, group, true);
    return withRoleplayAccount(base, account, (lease, currentAccount) => {
        const { state } = roleplayLease(lease);
        try {
            const result = commitSingleChatWriteLocked(lease, {
                operationKey: block.operationKey, sourceKind: 'storage', mode: block.source ? 'update' : 'create',
                ...(block.source ? { source: { kind: 'storage', ...currentAccount, ...block.source, locator, dependencies: [] } }
                    : { destination: locator, expectedVacancy: block.vacancy }),
                records: request.body.chat, force: request.body.force === true, allowShrink: request.body.allowShrink === true,
                backup: { deferBackup: request.body.deferBackup === true,
                    ...(request.body.deferSequenceId !== undefined ? { deferSequenceId: request.body.deferSequenceId } : {}) },
            }, roleplayBrowserHost);
            return { ok: true, integrity: result.integrity,
                roleplay: { account: currentAccount, operationKey: block.operationKey, changed: result.changed, source: wireChatSource(result) } };
        } catch (error) {
            // A failed lease is never reused. This reference only classifies the response to an admitted write.
            if (state.pending?.operationKeyHash === roleplayHash([state.accountId, 'chat-write', block.operationKey])
                && error.code !== 'ROLEPLAY_INTENT_CONFLICT') error.roleplayWritePending = true;
            if (Object.hasOwn(error, 'current')) error.roleplay = { account: currentAccount,
                ...(error.current?.instanceId ? { source: error.current } : error.current ?? { source: null }) };
            throw error;
        }
    });
}

function sendRoleplayError(response, error) {
    const code = error.code;
    const uncertain = error.roleplayWritePending || error.chatCommitted || error.chatWriteUncertain;
    if (!uncertain && (code === 'ROLEPLAY_STORE_FULL' || code === 'ROLEPLAY_MEMORY_FULL')) return response.status(507).send({ error: 'roleplay_store_full', code });
    if (uncertain || code === 'ELOCKED'
        || code === 'ROLEPLAY_RECOVERY_REQUIRED' || code?.startsWith('ROLEPLAY_STORE_') || code === 'ROLEPLAY_ACCOUNT_UNAVAILABLE') {
        return response.status(503).send({ error: 'roleplay_recovery_required', code: code || 'ROLEPLAY_WRITE_UNCERTAIN' });
    }
    if (code === 'ROLEPLAY_ACCOUNT_CHANGED') return response.status(409).send({ error: 'account_changed', code });
    if (code === 'ROLEPLAY_SOURCE_MISSING') return response.status(404).send({ error: 'missing', code });
    if (code === 'ROLEPLAY_SOURCE_DAMAGED') return response.status(422).send({ error: 'corrupt', code });
    if (code === 'ROLEPLAY_SOURCE_CHANGED' && error.roleplay) return response.status(400).send({ error: 'integrity', code, roleplay: error.roleplay });
    if (code === 'ROLEPLAY_INVALID' || code === 'ROLEPLAY_REQUIRED') return response.status(400).send({ error: code.toLowerCase(), code });
    if (error instanceof DestructiveChatSaveError) return response.status(409).send({ error: 'destructive', reason: error.reason });
    if (error instanceof InvalidChatDataError) return response.status(400).send({ error: error.message });
    if (code?.startsWith('ROLEPLAY_')) return response.status(409).send({ error: code.slice(9).toLowerCase(), code });
    console.error('Protected chat request failed:', error);
    return response.status(503).send({ error: 'roleplay_recovery_required', code: 'ROLEPLAY_IO_ERROR' });
}

function sendProtectedChatLoad(request, response, group) {
    try {
        const result = loadProtectedChat(request, group);
        setRoleplayResponseEvidence(response, result.evidence);
        return response.set('Cache-Control', 'no-store').send(result.records);
    } catch (error) { return sendRoleplayError(response, error); }
}

function sendProtectedChatSave(request, response, group) {
    try { return response.set('Cache-Control', 'no-store').send(saveProtectedChat(request, group)); } catch (error) { return sendRoleplayError(response, error); }
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 * @param {object} [options] Additional save options.
 * @param {boolean} [options.deferBackup] Skip the regular chat backup for this save.
 * @param {object} [options.recoveryTarget] Exact chat recovery target.
 * @param {boolean} [options.allowShrink] The client is deliberately removing messages, so allow a smaller chat.
 * @param {boolean} [options.persistDerivedMetadata] Persist metadata normally ignored during load-only saves.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, options = {}) {
    if (!isValidChatSavePayload(chatData)) {
        throw new InvalidChatDataError('Invalid chat save payload. Expected a non-empty chat array with a metadata header.');
    }

    return withChatFileLocks([filePath], () => {
        const result = trySaveChatLocked(chatData, filePath, skipIntegrityCheck, handle, cardName, backupDirectory, options);
        if (options.mewmory) captureBranchMemory(options.mewmory.directories, options.mewmory.locator,
            { metadata: chatData[0].chat_metadata || {}, messages: chatData.slice(1) });
        return result;
    });
}

/**
 * Mutates an existing server-resolved chat under its save lock. The callback must be
 * synchronous and return JSON records; it must not perform external effects.
 * The exact SHA-256 source hash is mandatory even when legacy integrity checks are disabled.
 * Failed post-save memory capture or lock cleanup carries chatCommitted=true: do not repeat the mutation.
 * A write failure carries chatWriteUncertain=true and the attempted integrity: reconcile recovery
 * and the saved content before deciding whether to repeat any mutation or associated external work.
 * @param {object} options Trusted native write options (never an HTTP request body).
 * @param {string} options.filePath Absolute path of the existing chat.
 * @param {string} options.expectedHash SHA-256 of the captured JSONL bytes.
 * @param {string} options.handle Account handle for backup scheduling.
 * @param {string} options.cardName Name for backups.
 * @param {string} options.backupDirectory Account backup directory.
 * @param {object} [options.recoveryTarget] Exact recovery target for this chat.
 * @param {object} [options.mewmory] Account directories and chat locator for branch capture.
 * @param {boolean} [options.allowShrink] Explicit permission to remove history.
 * @param {boolean} [options.deferBackup] Defer the regular backup.
 * @param {string} [options.deferSequenceId] Existing deferred-backup sequence identity.
 * @param {(records: object[]) => object[]} mutate Native synchronous mutation.
 * @returns {{integrity: string, records: object[]}} Authoritative saved content.
 */
export function mutateChat({ filePath, expectedHash, handle, cardName, backupDirectory,
    recoveryTarget = null, mewmory, allowShrink = false, deferBackup = false, deferSequenceId }, mutate) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
        || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || typeof mutate !== 'function' || types.isAsyncFunction(mutate)
        || typeof handle !== 'string' || typeof cardName !== 'string'
        || typeof backupDirectory !== 'string' || !path.isAbsolute(backupDirectory)
        || (recoveryTarget && path.resolve(recoveryTarget.activePath) !== path.resolve(filePath))) {
        throw new TypeError('Invalid native chat mutation options or asynchronous callback.');
    }

    assertNativeChatPath(filePath);
    const release = acquireChatFileLock(filePath);
    let result;
    try {
        assertNativeChatPath(filePath);
        recoverFileWriteSync(filePath);
        const snapshot = readChatFileSnapshot(filePath, { strict: true });
        if (!snapshot || snapshot.hash !== expectedHash) {
            throw Object.assign(new IntegrityMismatchError('Native chat source changed or is missing.'), { code: 'ESTALE' });
        }
        const source = parseChatJsonl(snapshot.data);
        if (source.status !== 'ok') throw new InvalidChatDataError('Native chat source is corrupt.');
        const changed = mutate(source.records);
        if (changed && typeof changed.then === 'function') {
            // A rejected promise must not escape after the synchronous contract is refused.
            Promise.resolve(changed).catch(() => {});
            throw new TypeError('Native chat mutation callbacks must be synchronous.');
        }
        if (!isValidChatSavePayload(changed)) throw new InvalidChatDataError('Invalid native chat mutation records.');
        const detached = parseChatJsonl(changed.map(record => JSON.stringify(record)).join('\n'));
        if (detached.status !== 'ok' || !isDeepStrictEqual(detached.records, changed)) {
            throw new InvalidChatDataError('Native chat mutation records must contain only JSON values.');
        }
        result = trySaveChatLocked(detached.records, filePath, false, handle, cardName, backupDirectory,
            { recoveryTarget, allowShrink, deferBackup, deferSequenceId, expectedSnapshot: snapshot });
        try {
            if (mewmory) captureBranchMemory(mewmory.directories, mewmory.locator,
                { metadata: result.records[0].chat_metadata, messages: result.records.slice(1) });
        } catch (cause) {
            throw Object.assign(new Error('Chat was saved, but its branch memory could not be captured.', { cause }),
                { chatCommitted: true, integrity: result.integrity });
        }
    } catch (failure) {
        try {
            release();
        } catch (cause) {
            // Preserve the original rejection or tagged write/memory outcome through cleanup.
            console.warn('Native chat lock cleanup also failed:', cause?.code || cause?.name);
        }
        throw failure;
    }
    try {
        release();
    } catch (cause) {
        throw Object.assign(new Error('Chat was saved, but its lock could not be released.', { cause }),
            { chatCommitted: true, integrity: result.integrity });
    }
    return result;
}

function prepareChatSave(chatData, integrity = uuidv4()) {
    const records = chatData.map((message, index) => index === 0
        ? { ...message, chat_metadata: { ...message.chat_metadata, integrity } }
        : message);
    return { records, serialized: records.map(message => JSON.stringify(message)).join('\n'), integrity };
}

/** Prepare once; the private lifecycle coordinator durably stages these exact bytes before publication. */
export function prepareNativeChatWrite(records, { beforeBytes = null, marker, force = false, allowShrink = false } = {}) {
    if (!isValidChatSavePayload(records)) throw new InvalidChatDataError('Invalid prepared chat records.');
    const detached = parseChatJsonl(records.map(record => JSON.stringify(record)).join('\n'));
    if (detached.status !== 'ok' || !isDeepStrictEqual(detached.records, records)) throw new InvalidChatDataError('Prepared chat records must contain only JSON values.');
    const inputRecords = detached.records;
    const before = beforeBytes === null ? null : parseChatJsonl(beforeBytes);
    if (before && before.status !== 'ok') throw new InvalidChatDataError('Invalid prepared chat source.');
    // Incoming metadata never grants native authority, including on imported copies.
    delete inputRecords[0].chat_metadata.neconyan_roleplay;
    delete inputRecords[0].chat_metadata.integrity;
    for (const key of ['neconyan_roleplay', 'integrity']) {
        if (before && Object.hasOwn(before.records[0].chat_metadata, key)) {
            inputRecords[0].chat_metadata[key] = structuredClone(before.records[0].chat_metadata[key]);
        }
    }
    if (before && isDeepStrictEqual(inputRecords, before.records)) {
        return { changed: false, inputRecords, records: before.records,
            serialized: Buffer.isBuffer(beforeBytes) ? beforeBytes.toString('utf8') : beforeBytes,
            integrity: before.records[0].chat_metadata.integrity ?? '' };
    }
    if (!marker || marker.schema !== 1 || !Number.isSafeInteger(marker.revision) || marker.revision < 1
        || ![marker.instanceId, marker.writeId].every(value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) {
        throw new TypeError('A prepared native write needs its server-assigned commit marker.');
    }
    const output = structuredClone(inputRecords);
    output[0].chat_metadata.neconyan_roleplay = structuredClone(marker);
    const prepared = { changed: true, inputRecords, ...prepareChatSave(output) };
    // Publication enforces the same rule; refusing here keeps a destructive write from ever becoming pending.
    const reason = before && getDestructiveChatSaveReason(prepared.records, beforeBytes.toString('utf8'));
    if (reason && !force && !allowShrink) throw new DestructiveChatSaveError(reason, 'The save would remove existing chat messages.');
    return prepared;
}

/** Preserve the browser's existing display-equivalent no-op and reject policy errors before admission. */
export function prepareBrowserChatWrite(records, { beforeBytes = null, marker, force = false, allowShrink = false } = {}) {
    if (!isValidChatSavePayload(records)) throw new InvalidChatDataError('Invalid prepared chat records.');
    const detached = parseChatJsonl(records.map(record => JSON.stringify(record)).join('\n'));
    if (detached.status !== 'ok' || !isDeepStrictEqual(detached.records, records)) throw new InvalidChatDataError('Prepared chat records must contain only JSON values.');
    const before = beforeBytes === null ? null : parseChatJsonl(beforeBytes);
    if (before && before.status !== 'ok') throw new InvalidChatDataError('Invalid prepared chat source.');
    if (before && isSameChatSaveContent(detached.records, before.records, { ignoreRoleplayMarker: true })) {
        return { changed: false, inputRecords: structuredClone(before.records), records: before.records,
            serialized: beforeBytes.toString('utf8'), integrity: before.records[0].chat_metadata.integrity ?? '' };
    }
    return prepareNativeChatWrite(detached.records, { beforeBytes, marker, force, allowShrink });
}

// Startup reconciliation uses this host too, so lifecycle replays keep recovery sidecars and deferred backups consistent.
export const roleplayNativeHost = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite,
    backups: isBackupEnabled, clearDeferred: clearDeferredPreWriteBackupSequence };
export const roleplayBrowserHost = { prepare: prepareBrowserChatWrite, publish: publishNativeChatWrite };

/** Private managed publication: no automatic recovery, memory capture or generation work. */
export function publishNativeChatWrite({ filePath, before, payloadPath, payloadHash, prepared,
    handle, cardName, backupDirectory, recoveryTarget = null, force = false, allowShrink = false, deferBackup = false, deferSequenceId, expectedJournal = null }) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
        || (payloadPath === null ? !before || prepared?.changed !== false
            : typeof payloadPath !== 'string' || !path.isAbsolute(payloadPath) || filePath === payloadPath)
        || typeof backupDirectory !== 'string' || !path.isAbsolute(backupDirectory)
        || typeof handle !== 'string' || typeof cardName !== 'string' || typeof prepared?.changed !== 'boolean'
        || !isValidChatSavePayload(prepared.inputRecords) || !isValidChatSavePayload(prepared.records)
        || (recoveryTarget && path.resolve(recoveryTarget.activePath) !== path.resolve(filePath))) throw new TypeError('Invalid managed chat publication.');
    if (recoveryTarget) {
        recoveryTarget = normalizeChatRecoveryTarget({ ...recoveryTarget, maxRecoveryStates: maxTotalChatBackups });
        if (path.resolve(recoveryTarget.activePath) !== path.resolve(filePath)) throw new TypeError('Invalid managed recovery target.');
    }
    // Proven output can finish the existing no-op backup path without its temporary after-image.
    const payload = readRoleplayFile(payloadPath ?? filePath, 64 * 1024 * 1024, { flush: true });
    if (!payload || payload.rawHash !== payloadHash || payload.bytes.toString('utf8') !== prepared.serialized
        || !isDeepStrictEqual(parseChatJsonl(payload.bytes).records, prepared.records)) throw new InvalidChatDataError('Prepared chat payload changed.');
    const inspect = () => {
        const file = readRoleplayFile(filePath, 64 * 1024 * 1024);
        if (before === null ? file !== null : !file || file.rawHash !== before.rawHash || !isDeepStrictEqual(file.physical, before.physical)) {
            throw Object.assign(new IntegrityMismatchError('Managed chat source changed.'), { code: 'ESTALE' });
        }
        // Never let legacy undo recovery precede the protected transaction's own classification.
        try {
            const journal = readRoleplayWriteJournal(filePath);
            if (expectedJournal === null ? journal !== null : !journal || journal.rawHash !== expectedJournal.rawHash
                || !isDeepStrictEqual(journal.physical, expectedJournal.physical)) throw new Error('Recovery journal changed.');
        } catch (cause) { throw new InvalidChatDataError('An earlier chat write needs explicit reconciliation.', { cause }); }
        return file;
    };
    inspect(); // Includes safe, existing parent validation before the lock helper can create directories.
    const release = acquireChatFileLock(filePath);
    let result;
    try {
        inspect();
        const snapshot = before === null ? null : readChatFileSnapshot(filePath, { strict: true, maxBytes: 64 * 1024 * 1024 });
        if (before && (!snapshot || snapshot.hash !== before.rawHash
            || String(snapshot.pathStats.dev) !== before.physical.dev || String(snapshot.pathStats.ino) !== before.physical.ino
            || String(snapshot.pathStats.birthtimeNs) !== before.physical.birthtimeNs)) {
            throw Object.assign(new IntegrityMismatchError('Managed chat source changed before publication.'), { code: 'ESTALE' });
        }
        if (prepared.changed === false && (before === null || payload.rawHash !== before.rawHash)) throw new InvalidChatDataError('Invalid managed no-op.');
        result = trySaveChatLocked(prepared.inputRecords, filePath, force, handle, cardName, backupDirectory,
            { recoveryTarget, allowShrink, deferBackup, deferSequenceId, expectedSnapshot: snapshot, nativePrepared: prepared,
                createOnly: before === null, validateNativeSource: inspect });
        const saved = readRoleplayFile(filePath, 64 * 1024 * 1024, { flush: true });
        if (!saved || saved.rawHash !== payloadHash || (before && !isDeepStrictEqual(saved.physical, before.physical))) {
            throw new IntegrityMismatchError('Managed chat output changed during publication.');
        }
        result = { ...result, file: saved };
    } catch (failure) {
        try { release(); } catch (cause) { console.warn('Managed chat lock cleanup also failed:', cause?.code || cause?.name); }
        throw Object.assign(failure, { chatWriteUncertain: true, integrity: prepared.integrity });
    }
    try { release(); } catch (cause) {
        throw Object.assign(new Error('Managed chat was saved, but its lock could not be released.', { cause }),
            { chatCommitted: true, integrity: prepared.integrity });
    }
    return result;
}

function trySaveChatLocked(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, { deferBackup = false, deferSequenceId = undefined, recoveryTarget = null, allowShrink = false, persistDerivedMetadata = false, expectedSnapshot = null, nativePrepared = null, createOnly = false, validateNativeSource = null } = {}) {
    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const incomingIntegrity = chatData?.[0]?.chat_metadata?.integrity;
    const chatIntegritySlug = doIntegrityCheck && typeof incomingIntegrity === 'string' ? incomingIntegrity : '';

    const prepared = nativePrepared || prepareChatSave(chatData);
    const nextIntegrity = prepared.integrity;
    const savedChatData = prepared.records;
    const jsonlData = prepared.serialized;
    const savedChatSizeDetails = getSerializedBackupSizeDetails(jsonlData);
    logBackupEvent('chat-save', {
        handle,
        chat: cardName,
        rows: Array.isArray(savedChatData) ? savedChatData.length : undefined,
        force: Boolean(skipIntegrityCheck),
        deferBackup: Boolean(deferBackup),
        ...savedChatSizeDetails,
    });

    // Neconyan: set when the payload represents the same loaded chat apart from the rotating
    // integrity slug and the discarded outer header envelope. The save then keeps the exact bytes
    // already on disk, so the recovery snapshot and regular backup mirror the authoritative file.
    let unchangedChatData = null;
    let unchangedIntegrity;
    let backupDecision = null;
    let preserveFileIdentity = false;
    let replaceFileOnly = false;
    let expectedFileIdentity;
    let expectedFileHash;
    let currentSnapshot = null;
    let existingFile = false;

    if (expectedSnapshot) assertNativeChatPath(filePath);
    try {
        if (!nativePrepared) recoverFileWriteSync(filePath);
        existingFile = fs.existsSync(filePath);
        if (createOnly && existingFile) throw Object.assign(new Error('The managed create destination already exists.'), { code: 'ESTALE' });
        if (existingFile) {
            currentSnapshot = readChatFileSnapshot(filePath, { strict: Boolean(expectedSnapshot), maxBytes: nativePrepared ? 64 * 1024 * 1024 : Number.MAX_SAFE_INTEGER });
        }
    } catch (error) {
        if (error?.code === 'ESTALE') {
            throw new IntegrityMismatchError(`Chat changed while it was being checked: "${filePath}".`, { cause: error });
        }
        if (!skipIntegrityCheck) {
            throw new DestructiveChatSaveError('unreadable', `Refused a chat save for "${cardName}": the existing chat file could not be read, so it cannot be backed up before being replaced.`);
        }
        existingFile = fs.existsSync(filePath);
    }

    // Native mutations never use the legacy append-retry exemption to accept a changed source.
    // Check before backups or recovery snapshots can replace evidence of that source.
    if (expectedSnapshot && (!currentSnapshot || currentSnapshot.hash !== expectedSnapshot.hash
        || currentSnapshot.pathStats.dev !== expectedSnapshot.pathStats.dev
        || currentSnapshot.pathStats.ino !== expectedSnapshot.pathStats.ino
        || currentSnapshot.pathStats.birthtimeNs !== expectedSnapshot.pathStats.birthtimeNs)) {
        throw Object.assign(new IntegrityMismatchError('Native chat source changed during mutation.'), { code: 'ESTALE' });
    }
    validateNativeSource?.();

    if (existingFile) {
        if (currentSnapshot) {
            const activeFileStats = currentSnapshot.pathStats;
            const descriptorMatchesPath = currentSnapshot.descriptorStats.dev === activeFileStats.dev
                && currentSnapshot.descriptorStats.ino === activeFileStats.ino;
            preserveFileIdentity = activeFileStats.isFile() && activeFileStats.nlink === 1n && descriptorMatchesPath;
            replaceFileOnly = !preserveFileIdentity;
            expectedFileIdentity = { dev: activeFileStats.dev, ino: activeFileStats.ino };
            expectedFileHash = currentSnapshot.hash;
        } else {
            const activeFileStats = fs.lstatSync(filePath, { bigint: true });
            replaceFileOnly = true;
            expectedFileIdentity = { dev: activeFileStats.dev, ino: activeFileStats.ino };
        }

        // An existing chat that cannot be read can be neither checked nor backed up, so never overwrite it blind.
        if (!currentSnapshot && !skipIntegrityCheck) {
            throw new DestructiveChatSaveError('unreadable', `Refused a chat save for "${cardName}": the existing chat file could not be read, so it cannot be backed up before being replaced.`);
        }

        const currentChatData = currentSnapshot?.data ?? null;
        const existingIntegrity = currentChatData === null ? '' : getSerializedChatIntegrity(currentChatData);
        const destructiveReason = currentChatData ? getDestructiveChatSaveReason(savedChatData, currentChatData) : '';

        // Neconyan: classify a history-destroying save before the integrity check, so the client is
        // told what is actually wrong with it. A client that lost its slug and a client sending an
        // unloaded chat both fail the slug comparison, but only the second is destructive, and
        // reporting it as a slug mismatch sends the client into a reload loop it cannot resolve:
        // reloading never repopulates the chat it failed to send.
        // Reject before the pre-write ring runs, so a rejected save cannot evict the last good state.
        // Deliberate message deletion sets allowShrink, which is not the same confirmation as an integrity overwrite.
        if (destructiveReason && !skipIntegrityCheck && !allowShrink) {
            throw new DestructiveChatSaveError(destructiveReason, `Refused a destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${savedChatData.length} JSONL rows, existing file has ${countSerializedChatLines(currentChatData)} rows.`);
        }

        // Neconyan: the slug rotates on every save and only reaches the client in the response
        // body, so a dropped response leaves a remote client holding the previous slug forever.
        // Accept that retry when it merely appends to what is on disk, because a superset save
        // cannot lose history; a genuinely divergent save still fails the check.
        if (doIntegrityCheck && existingIntegrity && existingIntegrity !== chatIntegritySlug
            && !isChatSaveExtension(jsonlData, currentChatData, { ignoreDerivedMetadata: !persistDerivedMetadata })) {
            throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
        }

        if (currentChatData) {
            const existingLines = countSerializedChatLines(currentChatData);

            // Neconyan: compare parsed records because loading canonicalizes legacy JSONL formatting.
            // Replacing equivalent content through atomic temp-and-rename would swap the file identity
            // for no gain. Legacy chats remain slugless until their first genuine content change.
            backupDecision = getDeferredPreWriteBackupDecision({
                filePath,
                deferBackup,
                deferSequenceId,
            });

            const unchanged = nativePrepared ? !nativePrepared.changed : expectedSnapshot
                ? isDeepStrictEqual(chatData, parseChatJsonl(currentChatData).records)
                : isSameChatSaveContent(jsonlData, currentChatData, { ignoreDerivedMetadata: !persistDerivedMetadata });
            if (unchanged) {
                unchangedChatData = currentChatData;
                unchangedIntegrity = existingIntegrity;
            } else {
                if (backupDecision.shouldCreateBackup) {
                    backupChatPreWrite(backupDirectory, cardName, currentChatData, handle);
                } else {
                    logBackupEvent('chat-backup-skipped', {
                        type: 'pre-write',
                        handle,
                        chat: cardName,
                        reason: backupDecision.closeSequence ? 'deferred-closed' : 'deferred-intermediate',
                    });
                }

                if (destructiveReason) {
                    console.warn(`Forced destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${savedChatData.length} JSONL rows, existing file has ${existingLines} rows.`);
                }

                if (skipIntegrityCheck) {
                    backupChat(backupDirectory, cardName, currentChatData, CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX, handle);
                }
            }
        }
    }

    // Neconyan: the regular backup still runs for an unchanged save. An agent run defers every
    // backup and closes with one non-deferred save, which can land unchanged; skipping it there would
    // leave the whole run without a backup. isDuplicateRegularChatBackup collapses the steady state.
    const persistedChatData = unchangedChatData ?? jsonlData;
    let hasRecoverySnapshot = false;

    if (isBackupEnabled && recoveryTarget) {
        // Neconyan: exact snapshots are immediate and are not subject to history backup throttling.
        // Destructive payloads are rejected above, so this cannot mirror a chat-destroying write.
        try {
            const snapshot = writeLatestChatSnapshot(recoveryTarget, persistedChatData);
            hasRecoverySnapshot = snapshot.stored === true;
        } catch (error) {
            // Recovery storage is supplementary and must not prevent the authoritative chat write.
            console.warn('Failed to write the exact chat recovery snapshot; continuing with the active chat save.', error);
        }
    }
    if (unchangedChatData !== null && currentSnapshot) {
        try {
            assertChatFileSnapshotCurrent(filePath, currentSnapshot, nativePrepared ? { strict: true, maxBytes: 64 * 1024 * 1024 } : undefined);
        } catch (error) {
            if (!nativePrepared && hasRecoverySnapshot && recoveryTarget) {
                repairRejectedChatRecoverySnapshot(recoveryTarget, persistedChatData);
            }
            throw new IntegrityMismatchError(`Chat changed after it was checked: "${filePath}".`, { cause: error });
        }
    }
    // Backup I/O must not silently invalidate the recorded source or journal handoff.
    validateNativeSource?.();
    if (unchangedChatData === null) {
        try {
            tryWriteFileSync(filePath, jsonlData, 'utf8', {
                preserveFileIdentity,
                expectedFileIdentity,
                expectedFileHash,
                expectedFileAbsent: !existingFile,
                invalidateBeforeWrite: preserveFileIdentity && (hasRecoverySnapshot || Boolean(nativePrepared)),
                replaceFileOnly,
                durable: !existingFile,
                preserveOnCreateError: Boolean(nativePrepared) && !existingFile,
                preserveOnWriteError: Boolean(nativePrepared) && preserveFileIdentity,
                maxFileBytes: nativePrepared ? 64 * 1024 * 1024 : Number.MAX_SAFE_INTEGER,
            });
        } catch (error) {
            let failure = error;
            if (['EMLINK', 'ESTALE'].includes(error?.code)) {
                if (!nativePrepared && hasRecoverySnapshot && recoveryTarget) {
                    repairRejectedChatRecoverySnapshot(recoveryTarget, persistedChatData);
                }
                failure = new IntegrityMismatchError(`Chat changed after it was checked: "${filePath}".`, { cause: error });
            }
            if (expectedSnapshot) Object.assign(failure, { chatWriteUncertain: true, integrity: nextIntegrity });
            throw failure;
        }
        logBackupEvent('chat-save-written', {
            handle,
            chat: cardName,
            mode: preserveFileIdentity ? 'in-place' : replaceFileOnly ? 'replace' : 'atomic',
            ...savedChatSizeDetails,
        });
    } else {
        logBackupEvent('chat-save-skipped', { handle, chat: cardName, reason: 'unchanged', force: Boolean(skipIntegrityCheck), ...savedChatSizeDetails });
    }
    // A no-op cannot open a sequence: it has not captured a pre-write snapshot yet.
    if (backupDecision && (!backupDecision.beginSequence || unchangedChatData === null)) {
        commitDeferredPreWriteBackupDecision(backupDecision, deferSequenceId);
    }
    if (!deferBackup) {
        // Protected completion cannot leave its requested backup on a process-local timer.
        const saveBackup = nativePrepared ? backupChat : getBackupFunction(handle);
        saveBackup(backupDirectory, cardName, persistedChatData, CHAT_BACKUPS_PREFIX, handle);
    } else {
        logBackupEvent('chat-backup-skipped', { type: 'regular', handle, chat: cardName, reason: 'deferred', ...savedChatSizeDetails });
    }
    return { integrity: unchangedIntegrity ?? nextIntegrity,
        ...(expectedSnapshot || nativePrepared ? { records: parseChatJsonl(persistedChatData).records } : {}) };
}

router.post('/save', validateAvatarUrlMiddleware, (request, response) => sendProtectedChatSave(request, response, false));

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    let chatData = [];

    const chatJSON = tryReadFileSync(chatFilePath);
    if (typeof chatJSON === 'string' && chatJSON.length > 0) {
        const lines = chatJSON.split('\n');
        // Iterate through the array of strings and parse each line as JSON
        chatData = lines.map(line => tryParse(line)).filter(x => x);
    } else if (fs.existsSync(chatFilePath)) {
        console.warn(`Chat file is empty: ${chatFilePath}.`);
    }

    return chatData;
}

router.post('/get', validateAvatarUrlMiddleware, (request, response) => sendProtectedChatLoad(request, response, false));

/**
 * Protected chats are deleted or renamed only through a recorded lifecycle transaction.
 * Returns null when the chat has never been enrolled, so the caller keeps the untracked legacy path.
 */
function protectedChatLifecycle(request, { group, chat, destination = null, chatIdHash = null }) {
    const base = { owner: request.user.profile.handle, directories: request.user.directories };
    if (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== base.owner) {
        throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'The selected account changed. Reload before continuing.');
    }
    const block = request.body?.roleplay;
    if (block !== undefined && (!isPlainObject(block) || Object.keys(block).some(key => !['account', 'operationKey'].includes(key))
        || (block.operationKey !== undefined && (typeof block.operationKey !== 'string' || !block.operationKey || block.operationKey.length > 200
            || block.operationKey.startsWith('job:')))
        || (block.account !== undefined && (!isPlainObject(block.account) || typeof block.account.accountId !== 'string'
            || !ROLEPLAY_UUID.test(block.account.accountId) || !Number.isSafeInteger(block.account.dataEpoch) || block.account.dataEpoch < 1)))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid chat lifecycle authority.', 400);
    }
    const locator = normaliseRoleplayLocator(group ? { group: true, chat } : { group: false, chat, avatar: request.body.avatar_url });
    const target = destination === null ? null : { ...locator, chat: destination };
    // Callers without a key get a one-shot key whose receipts are dropped once closed; the browser sends a stable key so retries replay.
    const oneShot = block?.operationKey === undefined;
    const operationKey = block?.operationKey ?? crypto.randomUUID();
    return withRoleplayAccount(base, block?.account ?? null, (lease, currentAccount) => {
        confirmRoleplayAccount(lease);
        const { state } = roleplayLease(lease);
        const receipt = state.submissions[roleplayHash([state.accountId, 'lifecycle', operationKey])];
        if (!receipt && !state.paths[roleplayPathKey(state, 'chat', locator)]) return null;
        if (!receipt && target && (state.paths[roleplayPathKey(state, 'chat', target)]?.instanceId
            || fs.existsSync(roleplayChatPath(base, target)) || chatMemoryExists(base.directories, target))) {
            // Refuse a taken name before the identity stamp below changes the source chat.
            throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'A chat with that name already exists.');
        }
        if (!receipt && target && Number.isSafeInteger(chatIdHash) && roleplayTrackedInstance(lease, 'chat', locator)) {
            // Legacy renames stamp a stable chat identity first; protected chats record that as its own storage write.
            const saved = readRoleplayChatLocked(lease, locator);
            if (saved.changed) saveRoleplayAccount(lease);
            const metadata = saved.records[0]?.chat_metadata ?? {};
            const mainChat = typeof metadata.main_chat === 'string' && metadata.main_chat.trim().length > 0;
            if (!Number.isSafeInteger(metadata.chat_id_hash) && !mainChat) {
                const records = structuredClone(saved.records);
                records[0].chat_metadata = { ...records[0].chat_metadata, chat_id_hash: chatIdHash };
                commitSingleChatWriteLocked(lease, {
                    operationKey: `${operationKey}:identity`, sourceKind: 'storage', mode: 'update',
                    source: { kind: 'storage', ...currentAccount, instanceId: saved.instanceId, revision: saved.revision,
                        rawHash: saved.rawHash, locator, dependencies: [] },
                    records, force: false, allowShrink: false, backup: { deferBackup: true },
                }, roleplayNativeHost);
                if (oneShot) forgetRoleplayReceiptLocked(lease, 'chat-write', `${operationKey}:identity`);
            }
        }
        const result = commitRoleplayLifecycleLocked(lease, {
            operationKey,
            action: target ? 'chat-rename' : 'chat-delete',
            intent: { locator, destination: target },
            steps: [target ? { op: 'move', kind: 'chat', locator, destination: target } : { op: 'delete', kind: 'chat', locator }],
            auxiliary: target
                ? [{ task: 'chat-memory-rename', from: locator, to: target }]
                : [{ task: 'chat-memory-remove', locator }, { task: 'chat-recovery-clear', locator }],
        }, { ...roleplayNativeHost, recoveryTarget: value => createChatRecoveryTarget(request, value.group, value.chat + '.jsonl') });
        if (oneShot) forgetRoleplayReceiptLocked(lease, 'lifecycle', operationKey);
        return { ok: true, roleplay: { account: currentAccount, operationKey, result } };
    });
}

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }
        try {
            const original = path.parse(sanitize(String(request.body.original_file))).name;
            const renamed = path.parse(sanitize(String(request.body.renamed_file))).name;
            const handled = protectedChatLifecycle(request, { group: Boolean(request.body.is_group), chat: original,
                destination: renamed, chatIdHash: request.body.chat_id_hash });
            if (handled) return response.set('Cache-Control', 'no-store').send({ ...handled, sanitizedFileName: renamed });
        } catch (error) { return sendRoleplayError(response, error); }

        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const originalFileName = sanitize(request.body.original_file);
        const renamedFileName = sanitize(request.body.renamed_file);
        const pathToOriginalFile = path.join(pathToFolder, originalFileName);
        const pathToRenamedFile = path.join(pathToFolder, renamedFileName);
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        const untracked = { owner: request.user.profile.handle, directories: request.user.directories };
        const outcome = withUntrackedRoleplayFiles(untracked, [pathToOriginalFile, pathToRenamedFile], () => withChatFileLocks([pathToOriginalFile, pathToRenamedFile], () => {
            if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
                console.error('Either Source or Destination files are not available');
                return { status: 400, body: { error: true } };
            }

            const sourceRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, originalFileName);
            const destinationRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, renamedFileName);
            const requestedChatIdHash = request.body.chat_id_hash;
            if (Number.isSafeInteger(requestedChatIdHash)) {
                const sourceChat = readChatJsonlStrict(pathToOriginalFile);
                const storedChatIdHash = sourceChat.records?.[0]?.chat_metadata?.chat_id_hash;
                const storedMainChat = sourceChat.records?.[0]?.chat_metadata?.main_chat;
                const hasStableMainChat = typeof storedMainChat === 'string' && storedMainChat.trim().length > 0;
                if (sourceChat.status === 'ok' && !Number.isSafeInteger(storedChatIdHash) && !hasStableMainChat) {
                    sourceChat.records[0] = {
                        ...sourceChat.records[0],
                        chat_metadata: {
                            ...(sourceChat.records[0].chat_metadata || {}),
                            chat_id_hash: requestedChatIdHash,
                        },
                    };
                    trySaveChatLocked(
                        sourceChat.records,
                        pathToOriginalFile,
                        false,
                        request.user.profile.handle,
                        path.parse(originalFileName).name,
                        request.user.directories.backups,
                        { deferBackup: true, recoveryTarget: sourceRecoveryTarget, persistDerivedMetadata: true },
                    );
                }
            }
            if (isBackupEnabled) {
                runChatRecoveryBestEffort(
                    () => seedLatestChatSnapshot(sourceRecoveryTarget),
                    'Failed to prepare chat recovery state; continuing with chat rename.',
                );
            }

            // Neconyan: atomic renames prevent interrupted chat renames from leaving cloned files behind.
            const memorySource = { chat: path.parse(originalFileName).name, avatar: request.body.avatar_url, group: Boolean(request.body.is_group) };
            const memoryDestination = { ...memorySource, chat: sanitizedFileName };
            let memoryMoved = false;
            let renameResult;
            try {
                memoryMoved = renameChatMemory(request.user.directories, memorySource, memoryDestination);
                renameResult = renameChatFile(pathToOriginalFile, pathToRenamedFile);
            } catch (error) {
                if (memoryMoved) renameChatMemory(request.user.directories, memoryDestination, memorySource);
                throw error;
            }
            clearDeferredPreWriteBackupSequence(pathToOriginalFile);
            if (isBackupEnabled) {
                const rekeyResult = runChatRecoveryBestEffort(
                    () => rekeyChatRecoveryState(sourceRecoveryTarget, destinationRecoveryTarget),
                    'Failed to move chat recovery state; continuing with renamed chat.',
                );
                if (!rekeyResult.ok) {
                    runChatRecoveryBestEffort(
                        () => clearChatRecoveryState(sourceRecoveryTarget),
                        'Failed to clear source chat recovery state after rename.',
                    );
                    runChatRecoveryBestEffort(
                        () => clearChatRecoveryState(destinationRecoveryTarget),
                        'Failed to clear destination chat recovery state after rename.',
                    );
                }
            }
            console.info(`Successfully renamed chat file (${renameResult.method}).`);
            return { status: 200, body: { ok: true, sanitizedFileName } };
        }));
        return response.status(outcome.status).send(outcome.body);
    } catch (error) {
        if (error.roleplayWritePending || error.code?.startsWith('ROLEPLAY_')) return sendRoleplayError(response, error);
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile);
        const sanitizedChatFileName = sanitize(chatFileName);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitizedChatFileName);
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        try {
            const handled = protectedChatLifecycle(request, { group: false, chat: path.parse(sanitizedChatFileName).name });
            if (handled) return response.set('Cache-Control', 'no-store').send(handled);
        } catch (error) { return sendRoleplayError(response, error); }
        return withUntrackedRoleplayFiles({ owner: request.user.profile.handle, directories: request.user.directories }, [chatFilePath], () => {
            const recoveryTarget = createChatRecoveryTarget(request, false, sanitizedChatFileName);
            if (isBackupEnabled) {
                runChatRecoveryBestEffort(
                    () => markChatDeleted(recoveryTarget),
                    'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
                );
            }

            //Return success if the file was deleted.
            let chatFileDeleted = false;
            try {
                chatFileDeleted = tryDeleteFile(chatFilePath);
            } finally {
            // Neconyan: a chat that survived the delete must not keep a tombstone blocking its recovery.
                if (isBackupEnabled && !chatFileDeleted) {
                    runChatRecoveryBestEffort(
                        () => seedLatestChatSnapshot(recoveryTarget),
                        'Failed to clear the chat recovery tombstone after a failed deletion.',
                    );
                }
            }

            if (chatFileDeleted) {
                removeChatMemory(request.user.directories, { avatar: request.body.avatar_url, chat: path.parse(sanitizedChatFileName).name, group: false });
                clearDeferredPreWriteBackupSequence(chatFilePath);
                runChatRecoveryBestEffort(
                    () => clearChatRecoveryState(recoveryTarget),
                    'Failed to clear chat recovery state after deletion.',
                );
                return response.send({ ok: true });
            } else {
                console.error('The chat file was not deleted.');
                return response.sendStatus(400);
            }
        });
    } catch (error) {
        if (error.roleplayWritePending || error.code?.startsWith('ROLEPLAY_')) return sendRoleplayError(response, error);
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
        return response.sendStatus(400);
    }
    let exportfilename = request.body.exportfilename;
    if (!fs.existsSync(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = fs.readFileSync(filename, 'utf8');
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                console.info(`Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                console.error(err);
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                console.error(errorMessage.message);
                return response.status(500).json(errorMessage);
            }
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

function importProtectedChat(request, response, group) {
    const uploaded = request.file && path.join(request.file.destination, request.file.filename);
    try {
        if (!uploaded) throw roleplayError('ROLEPLAY_INVALID', 'Choose one chat file to import.', 400);
        let block;
        try { block = JSON.parse(request.body?.roleplay ?? 'null'); } catch { throw roleplayError('ROLEPLAY_INVALID', 'Invalid chat import authority.', 400); }
        if (!isPlainObject(block) || typeof block.operationKey !== 'string' || !block.operationKey
            || block.operationKey.length > 256 || !isPlainObject(block.account)
            || typeof block.account.accountId !== 'string' || !ROLEPLAY_UUID.test(block.account.accountId)
            || !Number.isSafeInteger(block.account.dataEpoch) || block.account.dataEpoch < 1) {
            throw roleplayError('ROLEPLAY_REQUIRED', 'Reload before importing; account and import key are required.', 400);
        }
        const owner = request.user.profile.handle;
        if (request.get('X-Neconyan-Account') !== owner) throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'The selected account changed.');
        const source = group ? block.source : undefined;
        const target = group
            ? { group: true, groupId: String(request.body.group_id), source }
            : { group: false, avatar: String(request.body.avatar_url) };
        const result = commitSingleChatImport({ owner, directories: request.user.directories, ...block.account }, {
            operationKey: block.operationKey, bytes: fs.readFileSync(uploaded), originalName: request.file.originalname,
            format: request.body.file_type, userName: request.body.user_name, characterName: request.body.character_name,
            target,
        }, roleplayNativeHost, convertImportedChatFile);
        return response.set('Cache-Control', 'no-store').send({ res: true, fileNames: result.names, roleplay: result });
    } catch (error) {
        if (error.roleplayImportUnaccepted === true) response.set('X-Neconyan-Import-Unaccepted', '1');
        return sendRoleplayError(response, error);
    } finally {
        if (uploaded) try { fs.unlinkSync(uploaded); } catch { /* A failed temporary-file cleanup cannot change the receipt. */ }
    }
}

router.post('/group/import', (request, response) => importProtectedChat(request, response, true));
router.post('/import', validateAvatarUrlMiddleware, (request, response) => importProtectedChat(request, response, false));

router.post('/group/get', (request, response) => sendProtectedChatLoad(request, response, true));

router.post('/group/info', async (request, response) => {
    try {
        const { base, locator } = roleplayRequest(request, true);
        try {
            const loaded = loadProtectedChat(request, true);
            setRoleplayResponseEvidence(response, loaded.evidence);
        } catch (error) {
            // Keep damaged chats listable, but never offer source authority for their contents.
            if (error.code !== 'ROLEPLAY_SOURCE_DAMAGED') throw error;
        }
        const chatInfo = await getListableGroupChatInfo(roleplayChatPath(base, locator), locator.chat);
        response.set('Cache-Control', 'no-store');
        return response.send(chatInfo);
    } catch (error) {
        return sendRoleplayError(response, error);
    }
});

router.post('/group/delete', (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFileName = sanitize(`${id}.jsonl`);
        const chatFilePath = path.join(request.user.directories.groupChats, chatFileName);
        try {
            const handled = protectedChatLifecycle(request, { group: true, chat: path.parse(chatFileName).name });
            if (handled) return response.set('Cache-Control', 'no-store').send(handled);
        } catch (error) { return sendRoleplayError(response, error); }
        return withUntrackedRoleplayFiles({ owner: request.user.profile.handle, directories: request.user.directories }, [chatFilePath], () => {
            const recoveryTarget = createChatRecoveryTarget(request, true, chatFileName);

            if (isBackupEnabled) {
                runChatRecoveryBestEffort(
                    () => markChatDeleted(recoveryTarget),
                    'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
                );
            }

            //Return success if the file was deleted.
            let chatFileDeleted = false;
            try {
                chatFileDeleted = tryDeleteFile(chatFilePath);
            } finally {
            // Neconyan: a chat that survived the delete must not keep a tombstone blocking its recovery.
                if (isBackupEnabled && !chatFileDeleted) {
                    runChatRecoveryBestEffort(
                        () => seedLatestChatSnapshot(recoveryTarget),
                        'Failed to clear the chat recovery tombstone after a failed deletion.',
                    );
                }
            }

            if (chatFileDeleted) {
                removeChatMemory(request.user.directories, { chat: String(id), group: true });
                clearDeferredPreWriteBackupSequence(chatFilePath);
                runChatRecoveryBestEffort(
                    () => clearChatRecoveryState(recoveryTarget),
                    'Failed to clear chat recovery state after deletion.',
                );
                return response.send({ ok: true });
            } else {
                console.error('The group chat file was not deleted.');
                return response.sendStatus(400);
            }
        });
    } catch (error) {
        if (error.roleplayWritePending || error.code?.startsWith('ROLEPLAY_')) return sendRoleplayError(response, error);
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', (request, response) => sendProtectedChatSave(request, response, true));

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;

        /** @type {string[]} */
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            chatFiles = targetGroup.chats
                .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
                .filter(fileName => fs.existsSync(fileName));
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number} [token_estimate] - The approximate number of tokens in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatFile of chatFiles) {
            const matcher = query ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    token_estimate: chatInfo.token_estimate,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @typedef {{pngFile?: string, groupId?: string, filePath: string, mtime: number}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];

        const getCharacterChatFiles = async () => {
            const pngDirents = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true });
            const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

            for (const pngFile of pngFiles) {
                const chatsDirectory = pngFile.replace('.png', '');
                const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                if (!fs.existsSync(pathToChats)) {
                    continue;
                }
                const pathStats = await fs.promises.stat(pathToChats);
                if (pathStats.isDirectory()) {
                    const chatFiles = await fs.promises.readdir(pathToChats);
                    const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                    for (const file of jsonlFiles) {
                        const filePath = path.join(pathToChats, file);
                        const stats = await fs.promises.stat(filePath);
                        allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                    }
                }
            }
        };

        const getGroupChatFiles = async () => {
            const groupDirents = await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true });
            const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

            for (const group of groups) {
                try {
                    const groupPath = path.join(request.user.directories.groups, group);
                    const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                    const groupData = JSON.parse(groupContents);

                    if (Array.isArray(groupData.chats)) {
                        for (const chat of groupData.chats) {
                            const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                            if (!fs.existsSync(filePath)) {
                                continue;
                            }
                            const stats = await fs.promises.stat(filePath);
                            allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                        }
                    }
                } catch (error) {
                    // Skip group files that can't be read or parsed
                    continue;
                }
            }
        };

        const getRootChatFiles = async () => {
            const dirents = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
            const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

            for (const file of chatFiles) {
                const filePath = path.join(request.user.directories.chats, file);
                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ filePath, mtime: stats.mtimeMs });
            }
        };

        await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);

        const parsedMax = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER);
        const max = (Number.isFinite(parsedMax) ? parsedMax : Number.MAX_SAFE_INTEGER) + pinnedChats.length;
        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.filePath) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const sortRecentChatFiles = (/** @type {ChatFile} */ a, /** @type {ChatFile} */ b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.mtime - a.mtime;
        };
        /**
         * Keeps Recent Chats filters populated when one chat category dominates the newest files.
         * @param {ChatFile[]} sortedChatFiles Chat files sorted by recency
         * @param {number} limit Maximum number of files to include per recent-chat bucket
         * @returns {ChatFile[]} Balanced recent chat files
         */
        const getBalancedRecentChatFiles = (sortedChatFiles, limit) => {
            if (limit >= sortedChatFiles.length) {
                return sortedChatFiles;
            }

            /** @type {Map<string, ChatFile>} */
            const selectedChats = new Map();
            const addChat = (/** @type {ChatFile} */ chatFile) => {
                selectedChats.set(`${chatFile.groupId || ''}\0${chatFile.pngFile || ''}\0${chatFile.filePath}`, chatFile);
            };

            sortedChatFiles.slice(0, limit).forEach(addChat);

            // Neconyan: include the same recent depth per filter so Individual does not disappear behind a busy Groups list.
            let groupCount = 0;
            let individualCount = 0;

            for (const chatFile of sortedChatFiles) {
                if (chatFile.groupId) {
                    if (groupCount < limit) {
                        addChat(chatFile);
                        groupCount++;
                    }
                } else if (individualCount < limit) {
                    addChat(chatFile);
                    individualCount++;
                }

                if (groupCount >= limit && individualCount >= limit) {
                    break;
                }
            }

            return Array.from(selectedChats.values()).sort(sortRecentChatFiles);
        };
        const sortedChatFiles = allChatFiles.sort(sortRecentChatFiles);
        const recentChats = getBalancedRecentChatFiles(sortedChatFiles, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            const previewMessageLimit = Math.max(0, Math.min(20, Number(request.body.previewMessages) || 0));
            return file.groupId
                ? getChatInfo(file.filePath, { group: file.groupId }, withMetadata, null, previewMessageLimit)
                : getChatInfo(file.filePath, { avatar: file.pngFile }, withMetadata, null, previewMessageLimit);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
