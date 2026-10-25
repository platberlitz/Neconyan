import fs from 'node:fs';
import path from 'node:path';

import { createLimiter } from './file-summary-cache.js';

// A large library has tens of thousands of chats. Directory reads and stats run
// in bounded batches so a recent-list refresh does not open one syscall per file
// at once, and one vanished file cannot discard the rest of its category.
export const RECENT_SCAN_CONCURRENCY = 32;
const FILES_PER_DIRECTORY = 8;

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} run
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, run) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next++;
            results[index] = await run(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Stats one chat file and reports a missing or unreadable entry as absent.
 * @param {(filePath: string) => Promise<import('node:fs').Stats>} stat
 * @param {string} filePath
 * @returns {Promise<{filePath: string, mtime: number} | null>}
 */
async function statChatFile(stat, filePath) {
    try {
        const stats = await stat(filePath);
        return { filePath, mtime: stats.mtimeMs };
    } catch {
        // Deleted, renamed or unreadable since readdir: drop only this entry.
        return null;
    }
}

/**
 * Builds the same chat inventory as the former serial walk: character chats for
 * each card, group chats listed by each group file, and root chats. Concurrency
 * bounds directory reads and stats; per-file failures skip only that file.
 * @param {object} directories User directory map
 * @param {{concurrency?: number, stat?: Function, readdir?: Function, readFile?: Function}} [options]
 * @returns {Promise<Array<{pngFile?: string, groupId?: string, filePath: string, mtime: number}>>}
 */
export async function collectRecentChatFiles(directories, {
    concurrency = RECENT_SCAN_CONCURRENCY,
    stat = fs.promises.stat,
    readdir = fs.promises.readdir,
    readFile = fs.promises.readFile,
} = {}) {
    const statLimit = createLimiter(concurrency);
    const boundedStat = filePath => statLimit(() => stat(filePath));

    const getCharacterChatFiles = async () => {
        let pngFiles;
        try {
            const dirents = await readdir(directories.characters, { withFileTypes: true });
            pngFiles = dirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.png').map(entry => entry.name);
        } catch {
            return [];
        }

        const perCharacter = await mapWithConcurrency(pngFiles, concurrency, async pngFile => {
            const pathToChats = path.join(directories.chats, pngFile.replace('.png', ''));
            let chatFiles;
            try {
                chatFiles = await readdir(pathToChats);
            } catch {
                // A character without a chat directory simply has no chats.
                return [];
            }
            const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');
            const entries = await mapWithConcurrency(jsonlFiles, FILES_PER_DIRECTORY, file =>
                statChatFile(boundedStat, path.join(pathToChats, file)));
            return entries.filter(Boolean).map(entry => ({ pngFile, ...entry }));
        });
        return perCharacter.flat();
    };

    const getGroupChatFiles = async () => {
        let groups;
        try {
            const groupDirents = await readdir(directories.groups, { withFileTypes: true });
            groups = groupDirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.json').map(entry => entry.name);
        } catch {
            return [];
        }

        const perGroup = await mapWithConcurrency(groups, concurrency, async group => {
            try {
                const groupPath = path.join(directories.groups, group);
                const groupData = JSON.parse(await readFile(groupPath, 'utf8'));
                if (!Array.isArray(groupData.chats)) {
                    return [];
                }
                const entries = await mapWithConcurrency(groupData.chats, FILES_PER_DIRECTORY, chat =>
                    statChatFile(boundedStat, path.join(directories.groupChats, `${chat}.jsonl`)));
                return entries.filter(Boolean).map(entry => ({ groupId: groupData.id, ...entry }));
            } catch {
                // Skip group files that cannot be read or parsed.
                return [];
            }
        });
        return perGroup.flat();
    };

    const getRootChatFiles = async () => {
        let chatFiles;
        try {
            const dirents = await readdir(directories.chats, { withFileTypes: true });
            chatFiles = dirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.jsonl').map(entry => entry.name);
        } catch {
            return [];
        }
        const entries = await mapWithConcurrency(chatFiles, concurrency, file =>
            statChatFile(boundedStat, path.join(directories.chats, file)));
        return entries.filter(Boolean);
    };

    const categories = await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);
    /** @type {Array<{pngFile?: string, groupId?: string, filePath: string, mtime: number}>} */
    const allChatFiles = [];
    for (const category of categories) {
        if (category.status === 'fulfilled') {
            allChatFiles.push(...category.value);
        }
    }
    return allChatFiles;
}

/**
 * The original pinned test, minus the file-name comparison. Callers group pins
 * by file name first, so this only has to keep the avatar/group OR exactly as
 * it was, including undefined on either side.
 * @param {{avatar?: string, group?: string}} pinned
 * @param {{pngFile?: string, groupId?: string}} chatFile
 * @returns {boolean}
 */
function pinnedChatMatches(pinned, chatFile) {
    return pinned.avatar === chatFile.pngFile || pinned.group === chatFile.groupId;
}

/**
 * Builds the pinned membership for one selection pass. Pins are indexed by
 * file name so a chat only compares against pins that could match its basename.
 * Duplicate basenames stay correct because every chat with that basename is
 * checked against the same pin list.
 * @param {Array<{filePath: string, pngFile?: string, groupId?: string}>} chatFiles
 * @param {Array<{file_name: string, avatar?: string, group?: string}>} pinnedChats
 * @returns {Set<object>}
 */
function collectPinnedChatFiles(chatFiles, pinnedChats) {
    /** @type {Map<string, Array<{file_name: string, avatar?: string, group?: string}>>} */
    const pinsByName = new Map();
    for (const pinned of pinnedChats) {
        const pins = pinsByName.get(pinned.file_name);
        if (pins) {
            pins.push(pinned);
        } else {
            pinsByName.set(pinned.file_name, [pinned]);
        }
    }

    /** @type {Set<object>} */
    const pinnedFiles = new Set();
    for (const chatFile of chatFiles) {
        const pins = pinsByName.get(path.basename(chatFile.filePath));
        if (pins && pins.some(pinned => pinnedChatMatches(pinned, chatFile))) {
            pinnedFiles.add(chatFile);
        }
    }
    return pinnedFiles;
}

/**
 * Sorts pinned chats first, then newest first, and keeps the same per-category
 * depth so one busy category cannot hide the other in Recent Chats filters.
 * @param {Array<{filePath: string, pngFile?: string, groupId?: string, mtime: number}>} chatFiles
 * @param {{max: number, pinnedChats: Array<{file_name: string, avatar?: string, group?: string}>}} options
 * @returns {Array<{filePath: string, pngFile?: string, groupId?: string, mtime: number}>}
 */
export function selectRecentChatFiles(chatFiles, { max, pinnedChats }) {
    const pinnedFiles = pinnedChats.length > 0 ? collectPinnedChatFiles(chatFiles, pinnedChats) : null;
    const sortRecentChatFiles = (a, b) => {
        const isAPinned = pinnedFiles !== null && pinnedFiles.has(a);
        const isBPinned = pinnedFiles !== null && pinnedFiles.has(b);

        if (isAPinned && !isBPinned) return -1;
        if (!isAPinned && isBPinned) return 1;

        return b.mtime - a.mtime;
    };
    const getBalancedRecentChatFiles = (sortedChatFiles, limit) => {
        if (limit >= sortedChatFiles.length) {
            return sortedChatFiles;
        }

        /** @type {Map<string, object>} */
        const selectedChats = new Map();
        const addChat = chatFile => {
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

    const sortedChatFiles = chatFiles.slice().sort(sortRecentChatFiles);
    return getBalancedRecentChatFiles(sortedChatFiles, max);
}
