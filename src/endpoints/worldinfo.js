import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { tryParse, tryWriteFileSync } from '../util.js';
import { removeSourceMemory } from '../mewmory/store.js';
import {
    appendWorldInfoCommit, deleteWorldInfoHistory, mergeWorldInfoHistory, newWorldInfoHistory,
    readWorldInfoHistory, renameWorldInfoHistory, validateWorldInfoHistory, worldInfoRevision, writeWorldInfoHistory,
} from '../world-info-history.js';

const WORLD_INFO_EXTENSION = '.json';
// Neconyan divergence: canonical World Info filenames are UTF-8 bounded and written through the fork's safe persistence path.
const MAX_FILENAME_BYTES = 255;
const ATOMIC_WRITE_SUFFIX_BYTES = 16;

function truncateUtf8(value, maxBytes) {
    let result = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character);
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        result += character;
        bytes += characterBytes;
    }
    return result;
}

/**
 * Gets the canonical filename for a World Info name.
 * @param {string} name World Info name
 * @returns {string} Canonical JSON filename
 */
export function getWorldInfoFilename(name) {
    const worldName = getWorldInfoName(name);
    return worldName ? `${worldName}${WORLD_INFO_EXTENSION}` : '';
}

/**
 * Gets the canonical persisted name for a World Info name.
 * @param {string} name World Info name
 * @returns {string} Canonical World Info name
 */
export function getWorldInfoName(name) {
    const sanitizedName = sanitize(String(name ?? ''));
    return truncateUtf8(sanitizedName, MAX_FILENAME_BYTES - Buffer.byteLength(WORLD_INFO_EXTENSION) - ATOMIC_WRITE_SUFFIX_BYTES);
}

function getLegacyWorldInfoFilename(name) {
    return sanitize(`${String(name ?? '')}${WORLD_INFO_EXTENSION}`);
}

function getExistingWorldInfoFilename(directories, name) {
    const legacyFilename = getLegacyWorldInfoFilename(name);
    if (legacyFilename && fs.existsSync(path.join(directories.worlds, legacyFilename))) {
        return legacyFilename;
    }

    const canonicalFilename = getWorldInfoFilename(name);
    if (canonicalFilename && fs.existsSync(path.join(directories.worlds, canonicalFilename))) {
        return canonicalFilename;
    }

    return null;
}

function writeWorldInfoFile(filePath, data) {
    const canUseAtomicSuffix = Buffer.byteLength(path.basename(filePath)) + ATOMIC_WRITE_SUFFIX_BYTES <= MAX_FILENAME_BYTES;
    if (canUseAtomicSuffix) {
        tryWriteFileSync(filePath, data);
        return;
    }

    const tempDirectory = fs.mkdtempSync(path.join(path.dirname(filePath), '.wi-write-'));
    const tempPath = path.join(tempDirectory, 'new');
    const backupPath = path.join(tempDirectory, 'old');
    let preserveTempDirectory = false;
    try {
        fs.writeFileSync(tempPath, data, 'utf8');
        try {
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            if (!fs.existsSync(filePath)) {
                throw error;
            }
            fs.renameSync(filePath, backupPath);
            try {
                fs.renameSync(tempPath, filePath);
            } catch (replacementError) {
                try {
                    fs.renameSync(backupPath, filePath);
                } catch (rollbackError) {
                    preserveTempDirectory = true;
                    throw new AggregateError([replacementError, rollbackError], `Failed to replace or restore ${filePath}`);
                }
                throw replacementError;
            }
        }
    } finally {
        if (!preserveTempDirectory) {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
    }
}

// Neconyan: retain the recovery snapshots before replacing a book, and restore the history on a failed write.
function writeWorldInfoWithHistory(filePath, data, history) {
    const previous = readWorldInfoHistory(filePath);
    writeWorldInfoHistory(filePath, history);
    try {
        writeWorldInfoFile(filePath, data);
    } catch (error) {
        if (previous) writeWorldInfoHistory(filePath, previous);
        else deleteWorldInfoHistory(filePath);
        throw error;
    }
}

/**
 * Validates the minimum native World Info shape required by the editor and scanner.
 * @param {unknown} data World Info data
 * @returns {boolean} Whether the data has a usable entries object
 */
export function isValidWorldInfoData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const entries = data.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return false;
    }

    return Object.values(entries).every(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = getExistingWorldInfoFilename(directories, worldInfoName);
    if (!filename) {
        console.error(`World info file ${getWorldInfoFilename(worldInfoName)} doesn't exist.`);
        return dummyObject;
    }
    const pathToWorldInfo = path.join(directories.worlds, filename);

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export const router = express.Router();

// Neconyan: synchronous revision checks and writes keep native authoring operations from interleaving.
router.post('/history', (request, response) => {
    const { name, action = 'get', revision, headCommitId, message, commitId } = request.body ?? {};
    if (typeof name !== 'string' || !name || !['get', 'commit', 'restore'].includes(action)) return response.sendStatus(400);
    try {
        const filename = getExistingWorldInfoFilename(request.user.directories, name);
        if (!filename) return response.sendStatus(404);
        const bookPath = path.join(request.user.directories.worlds, filename);
        let data = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
        let history = readWorldInfoHistory(bookPath) ?? newWorldInfoHistory();
        if (action !== 'get') {
            if (revision !== worldInfoRevision(data) || headCommitId !== history.headCommitId) return response.sendStatus(409);
            if (action === 'commit') {
                if (typeof message !== 'string' || !message.trim() || message.length > 2000) return response.sendStatus(400);
                history = appendWorldInfoCommit(history, data, message.trim());
                writeWorldInfoHistory(bookPath, history);
            } else {
                const commit = history.commits.find(item => item.id === commitId);
                if (!commit) return response.sendStatus(404);
                // Preserve uncommitted edits as well as the old HEAD before a rollback.
                history = appendWorldInfoCommit(history, data, 'Uncommitted changes');
                data = structuredClone(commit.snapshot);
                history = appendWorldInfoCommit(history, data, `Revert to ${commit.id.slice(0, 7)}: ${commit.message}`);
                writeWorldInfoWithHistory(bookPath, JSON.stringify(data, null, 4), history);
            }
        }
        if (request.body.summary === true && action === 'get') {
            history = { ...history, commits: history.commits.filter(commit => commit.id === history.headCommitId) };
        }
        return response.send({ history, revision: worldInfoRevision(data), ...(action === 'restore' || request.body.includeBook === true ? { data } : {}) });
    } catch (error) {
        console.error('World Info history failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const file = readWorldInfoFile(request.user.directories, request.body.name, false);

    if (!file) {
        return response.sendStatus(404);
    }

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = getExistingWorldInfoFilename(request.user.directories, worldInfoName);
    if (!filename) {
        return response.sendStatus(404);
    }
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    fs.unlinkSync(pathToWorldInfo);
    deleteWorldInfoHistory(pathToWorldInfo);
    removeSourceMemory(request.user.directories, { world: path.parse(filename).name });

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const pathToUpload = path.join(request.file.destination, request.file.filename);

    try {
        const requestedName = request.body.name ?? path.parse(request.file.originalname).name;
        const filename = getExistingWorldInfoFilename(request.user.directories, requestedName)
            ?? getWorldInfoFilename(requestedName);
        if (!filename) {
            return response.status(400).send('World file must have a name');
        }

        const fileContents = request.body.convertedData ?? fs.readFileSync(pathToUpload, 'utf8');
        const worldContent = tryParse(fileContents);
        if (!isValidWorldInfoData(worldContent)) {
            console.warn(`World Info import rejected: '${requestedName}' is not a valid world info file`);
            return response.status(400).send('Is not a valid world info file');
        }

        const pathToNewFile = path.join(request.user.directories.worlds, filename);
        if (request.body.history !== undefined) {
            const importedHistory = tryParse(request.body.history);
            if (!validateWorldInfoHistory(importedHistory)) return response.sendStatus(400);
            const currentBook = fs.existsSync(pathToNewFile) ? JSON.parse(fs.readFileSync(pathToNewFile, 'utf8')) : null;
            const history = mergeWorldInfoHistory(readWorldInfoHistory(pathToNewFile), importedHistory, currentBook);
            writeWorldInfoWithHistory(pathToNewFile, fileContents, history);
        } else {
            writeWorldInfoFile(pathToNewFile, fileContents);
        }
        return response.send({ name: path.parse(pathToNewFile).name });
    } catch (err) {
        console.error('World Info import failed:', err);
        return response.sendStatus(500);
    } finally {
        fs.rmSync(pathToUpload, { force: true });
    }
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!isValidWorldInfoData(request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = getExistingWorldInfoFilename(request.user.directories, request.body.name)
        ?? getWorldInfoFilename(request.body.name);
    const pathToFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(filename).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    if (request.body.revision !== undefined) {
        const current = fs.existsSync(pathToFile) ? JSON.parse(fs.readFileSync(pathToFile, 'utf8')) : null;
        if (!current || worldInfoRevision(current) !== request.body.revision) return response.sendStatus(409);
    }

    writeWorldInfoFile(pathToFile, JSON.stringify(request.body.data, null, 4));

    return response.send({ ok: true, name: worldName });
});

router.post('/rename', (request, response) => {
    const { oldName, newName, data } = request.body ?? {};
    if (!oldName || !newName || !isValidWorldInfoData(data)) {
        return response.sendStatus(400);
    }

    const oldFilename = getExistingWorldInfoFilename(request.user.directories, oldName);
    const newFilename = getWorldInfoFilename(newName);
    const canonicalName = getWorldInfoName(newName);
    if (!oldFilename || !newFilename || getWorldInfoName(oldName) === canonicalName) {
        return response.status(400).send('World file must have a different name');
    }

    const oldPath = path.join(request.user.directories.worlds, oldFilename);
    const newPath = path.join(request.user.directories.worlds, newFilename);
    const existingTargetFilename = getExistingWorldInfoFilename(request.user.directories, newName);
    if (existingTargetFilename || fs.existsSync(newPath)) {
        return response.sendStatus(409);
    }

    try {
        writeWorldInfoFile(oldPath, JSON.stringify(data, null, 4));
        fs.renameSync(oldPath, newPath);
        try {
            renameWorldInfoHistory(oldPath, newPath);
        } catch (error) {
            fs.renameSync(newPath, oldPath);
            throw error;
        }
        return response.send({ ok: true, name: canonicalName });
    } catch (err) {
        console.error('World Info rename failed:', err);
        return response.sendStatus(500);
    }
});
