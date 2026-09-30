import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import bytes from 'bytes';

import { SETTINGS_FILE } from '../constants.js';
import { prepareSettingsSave, restoreSettingsSnapshot } from '../settings-version.js';
import { readAgentCollection } from '../in-chat-agent-storage.js';
import {
    getConfigValue,
    generateTimestamp,
    removeOldBackups,
    tryWriteFileSync,
    formatBytes,
    color,
} from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { withRoleplayAccount } from '../roleplay-store.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const ENABLE_REQUEST_COMPRESSION = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');
const REQUEST_COMPRESSION_MIN = bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb'));
const REQUEST_COMPRESSION_MAX = bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb'));
const REQUEST_COMPRESSION_TIMEOUT = Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number'));
const isBackupLoggingEnabled = !!getConfigValue('backups.chat.logging', false, 'boolean');

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/** Cancel pending autosave throttles. Used when a process is winding down. */
export function cancelAutoSaves() {
    for (const scheduled of AUTOSAVE_FUNCTIONS.values()) {
        scheduled?.cancel?.();
    }
    AUTOSAVE_FUNCTIONS.clear();
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

function getSettingsBackupSizeDetails(sourceFile) {
    const sizeBytes = fs.statSync(sourceFile).size;
    return {
        bytes: sizeBytes,
        size: formatBytes(sizeBytes),
    };
}

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
export function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => {
            logBackupEvent('settings-autosave-fired', { handle });
            backupUserSettings(handle, true);
        }, AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        logBackupEvent('settings-autosave-requested', { handle });
        try {
            functionToCall();
        } catch (error) {
            logBackupEvent('settings-autosave-failed', { handle, error: error?.message });
        }
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension File extension
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, fileExtension = '.json') {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const files = fs
        .readdirSync(directoryPath)
        .filter(x => path.parse(x).ext == fileExtension)
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        } catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    if (!fs.existsSync(directoryPath)) {
        return {
            fileContents: [],
            fileNames: [],
        };
    }

    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = fs.readdirSync(directoryPath).sort(sortFunction).filter(x => path.parse(x).ext == fileExtension);
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            console.warn(`${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        logBackupEvent('settings-backup-skipped', { handle, reason: 'missing-user-root' });
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        logBackupEvent('settings-backup-skipped', {
            handle,
            reason: 'duplicate',
            ...getSettingsBackupSizeDetails(sourceFile),
        });
        return;
    }

    if (!fs.existsSync(sourceFile)) {
        logBackupEvent('settings-backup-skipped', { handle, reason: 'missing-source' });
        return;
    }

    const sizeDetails = getSettingsBackupSizeDetails(sourceFile);
    fs.copyFileSync(sourceFile, backupFile);
    logBackupEvent('settings-backup-written', { handle, file: path.basename(backupFile), ...sizeDetails });
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
function areFilesEqual(file1, file2) {
    if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
        return false;
    }

    const content1 = fs.readFileSync(file1);
    const content2 = fs.readFileSync(file2);
    return content1.toString() === content2.toString();
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/save', function (request, response) {
    try {
        const account = request.get('X-Neconyan-Account');
        if (account && account !== request.user.profile.handle) return response.status(409).send({ error: 'account_changed' });
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
            return response.status(400).send({ error: 'invalid_settings' });
        }

        const currentSettings = fs.existsSync(pathToSettings)
            ? JSON.parse(fs.readFileSync(pathToSettings, 'utf8'))
            : {};

        // Neconyan: prevent one open device or tab from overwriting newer settings from another.
        const preparedSave = prepareSettingsSave(request.body, currentSettings, { acknowledgeAccount: request.user.profile.handle });
        if (!preparedSave.ok) {
            return response.status(409).send({
                error: preparedSave.conversationConflict ? 'conversation_conflict' : 'settings_conflict',
                version: preparedSave.currentVersion,
                reload: preparedSave.conversationConflict ? '/api/neconyan-conversation/store/get' : undefined,
            });
        }

        tryWriteFileSync(pathToSettings, JSON.stringify(preparedSave.settings, null, 4));
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok', version: preparedSave.version, settingsRevision: preparedSave.settingsRevision });
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: 'settings_save_failed' });
    }
});

const SETTINGS_SECTION_NAMES = new Set(['settings', 'presets', 'worlds', 'quickReplies', 'agents']);

/**
 * Reads the parts of the settings bootstrap one caller asked for. Each section
 * touches its own directories only, so a caller that needs the agent list does
 * not also re-read settings.json and every preset on disk.
 * @param {import('express').Request} request
 * @param {Set<string>} sections
 */
function readSettingsSections(request, sections) {
    const directories = request.user.directories;
    const result = {};

    if (sections.has('settings')) {
        result.settings = fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8');
    }

    if (sections.has('presets')) {
        const families = [
            ['novelai_settings', 'novelai_setting_names', directories.novelAI_Settings],
            ['openai_settings', 'openai_setting_names', directories.openAI_Settings],
            ['textgenerationwebui_presets', 'textgenerationwebui_preset_names', directories.textGen_Settings],
            ['koboldai_settings', 'koboldai_setting_names', directories.koboldAI_Settings],
        ];
        for (const [contentsKey, namesKey, directory] of families) {
            const { fileContents, fileNames } = readPresetsFromDirectory(directory, {
                sortFunction: sortByName(directory), removeFileExtension: true,
            });
            result[contentsKey] = fileContents;
            result[namesKey] = fileNames;
        }
        result.instruct = readAndParseFromDirectory(directories.instruct);
        result.context = readAndParseFromDirectory(directories.context);
        result.sysprompt = readAndParseFromDirectory(directories.sysprompt);
        result.reasoning = readAndParseFromDirectory(directories.reasoning);
    }

    if (sections.has('worlds')) {
        result.world_names = fs
            .readdirSync(directories.worlds)
            .filter(file => path.extname(file).toLowerCase() === '.json')
            .sort((a, b) => a.localeCompare(b))
            .map(item => path.parse(item).name);
    }

    if (sections.has('quickReplies')) {
        result.quickReplyPresets = readAndParseFromDirectory(directories.quickreplies);
    }

    if (sections.has('agents')) {
        const agentLibrary = readAgentCollection(directories.inChatAgents, 'agent',
            { owner: request.user.profile.handle, directories });
        result.inChatAgents = agentLibrary.records;
        result.inChatAgentLoadErrors = agentLibrary.errors;
        result.inChatAgentRevisions = agentLibrary.revisions;
        result.inChatAgentAccount = request.user.profile.handle;
    }

    return result;
}

/**
 * Reads the saved settings of the named extensions from the current settings
 * file. Extensions that poll or confirm their own block use this so they do not
 * download the whole settings file, which can run to several megabytes.
 * @param {import('express').Request} request
 * @param {string[]} names
 * @returns {Record<string, any>} Only the names that exist in the file.
 */
function readExtensionSettings(request, names) {
    const text = fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8');
    const source = JSON.parse(text)?.extension_settings;
    const result = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
    for (const name of names) {
        if (Object.hasOwn(source, name)) result[name] = source[name];
    }
    return result;
}

// Wintermute's code
router.post('/get', (request, response) => {
    // Persistence checks need the current on-disk version only; extensions can
    // name the sections they use. Without either field the full bootstrap is sent.
    const extensionNames = request.body?.extensionSettings;
    if (Array.isArray(extensionNames)) {
        if (!extensionNames.length || extensionNames.some(name => typeof name !== 'string' || !name)) {
            return response.status(400).send({ error: 'unknown_settings_section' });
        }
        try {
            return response.send({ extension_settings: readExtensionSettings(request, extensionNames) });
        } catch (error) {
            console.error('Extension settings could not be read:', error);
            return response.sendStatus(500);
        }
    }

    const requested = request.body?.settingsOnly === true ? ['settings'] : request.body?.sections;
    if (Array.isArray(requested)) {
        if (!requested.length || requested.some(name => !SETTINGS_SECTION_NAMES.has(name))) {
            return response.status(400).send({ error: 'unknown_settings_section' });
        }
        try {
            return response.send(readSettingsSections(request, new Set(requested)));
        } catch (error) {
            console.error('Settings sections could not be read:', error);
            return response.sendStatus(500);
        }
    }

    let full;
    try {
        full = readSettingsSections(request, new Set(['settings']));
    } catch (e) {
        return response.sendStatus(500);
    }
    Object.assign(full, readSettingsSections(request, new Set(['presets', 'worlds', 'quickReplies', 'agents'])));

    let roleplayAccount = null;
    try {
        roleplayAccount = withRoleplayAccount({ owner: request.user.profile.handle, directories: request.user.directories }, null, (_lease, current) => current);
    } catch (error) {
        console.warn('Protected chat storage is unavailable for this account:', error.code);
    }

    response.send({
        settings: full.settings,
        koboldai_settings: full.koboldai_settings,
        koboldai_setting_names: full.koboldai_setting_names,
        world_names: full.world_names,
        novelai_settings: full.novelai_settings,
        novelai_setting_names: full.novelai_setting_names,
        openai_settings: full.openai_settings,
        openai_setting_names: full.openai_setting_names,
        textgenerationwebui_presets: full.textgenerationwebui_presets,
        textgenerationwebui_preset_names: full.textgenerationwebui_preset_names,
        themes: readAndParseFromDirectory(request.user.directories.themes),
        movingUIPresets: readAndParseFromDirectory(request.user.directories.movingUI),
        quickReplyPresets: full.quickReplyPresets,
        instruct: full.instruct,
        context: full.context,
        sysprompt: full.sysprompt,
        reasoning: full.reasoning,
        inChatAgents: full.inChatAgents,
        inChatAgentLoadErrors: full.inChatAgentLoadErrors,
        inChatAgentRevisions: full.inChatAgentRevisions,
        inChatAgentAccount: full.inChatAgentAccount,
        roleplayAccount,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
        request_compression: {
            enabled: ENABLE_REQUEST_COMPRESSION,
            minPayloadSize: REQUEST_COMPRESSION_MIN || 0,
            maxPayloadSize: REQUEST_COMPRESSION_MAX || 0,
            timeout: REQUEST_COMPRESSION_TIMEOUT || 0,
        },
    });
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        const restored = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        restoreSettingsSnapshot(pathToSettings, restored);

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
