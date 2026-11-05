import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE } from './constants.js';
import { getSettingsRevision, getSettingsVersion } from './settings-version.js';
import { FILE_WRITE_RECOVERY_SUFFIX, tryWriteFileSync } from './util.js';

/** Data saved while the app was still called SillyBunny is moved to its Neconyan names once, at start-up. */

const EXTENSION_SETTINGS_KEYS = Object.freeze({
    'sillybunny_conversation': 'neconyan_conversation',
    'SillyBunny-Deep-Swipe': 'Neconyan-Deep-Swipe',
    'SillyBunny-Regex-Agent-Themes': 'Neconyan-Regex-Agent-Themes',
    'SillyBunny-Story-Mode': 'Neconyan-Story-Mode',
    'SillyBunny-Terminal-UI': 'Neconyan-Terminal-UI',
    'SillyBunny-TwitterLike': 'Neconyan-TwitterLike',
    'SillyBunnyBotSearcher': 'NeconyanBotSearcher',
    'SillyBunnyCardTimeMachine': 'NeconyanCardTimeMachine',
    'SillyBunnyLorebookDistiller': 'NeconyanLorebookDistiller',
    'SillyBunnyPromptingLab': 'NeconyanPromptingLab',
    'SillyBunnyWorldInfoLab': 'NeconyanWorldInfoLab',
});
const TIME_MACHINE_ATTACHMENTS = Object.freeze(['__SillyBunny-Card-Time-Machine__', '__Neconyan-Card-Time-Machine__']);
const WORLD_EXTENSION_KEYS = Object.freeze({
    'sillybunny_pathfinder': 'neconyan_pathfinder',
    'SillyBunnyWorldInfoLab': 'NeconyanWorldInfoLab',
});
const LEGACY_RECOVERY_SUFFIX = '.sillybunny-write-recovery';
const LEGACY_LEFTOVER = /^\.sillybunny-(?:write-\d+\.[0-9a-f]{16}\.(?:tmp|restore)|chat-[0-9a-f]{64}\.lock|recovery-state\.lock)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);
const SCAN_CACHE_FILE = '.neconyan-legacy-name-scan.json';

function scanIdentity(filePath) {
    const stat = fs.lstatSync(filePath, { bigint: true });
    return { stat, key: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':') };
}

function loadScanCache(root) {
    try {
        const cache = JSON.parse(fs.readFileSync(path.join(root, SCAN_CACHE_FILE), 'utf8'));
        if (cache.version === 1 && isPlainObject(cache.directories) && isPlainObject(cache.files)) return cache;
    } catch {
        // A missing or damaged optimisation cache always falls back to a full scan.
    }
    return { version: 1, directories: {}, files: {} };
}

function migrateChangedFile(filePath, previous, next, migrate) {
    const { key, stat } = scanIdentity(filePath);
    if (stat.isFile() && previous.files[filePath] === key) {
        next.files[filePath] = key;
        return false;
    }
    const changed = migrate();
    // Do not mark a failed or concurrently replaced read as checked.
    if (stat.isFile() && scanIdentity(filePath).key === key) next.files[filePath] = key;
    return changed;
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function renameName(value) {
    return value.replace(/SillyBunny/g, 'Neconyan').replace(/sillybunny/g, 'neconyan').replace(/SILLYBUNNY/g, 'NECONYAN');
}

/** Move a key unless the new name already holds newer data; the old copy is dropped either way. */
function moveKey(container, from, to) {
    if (!isPlainObject(container) || !Object.hasOwn(container, from)) return false;
    if (!Object.hasOwn(container, to)) container[to] = container[from];
    delete container[from];
    return true;
}

/**
 * Rename the app's own keys in a parsed settings file. Names inside user content, such as a
 * character called SillyBunnyGuide, are left alone.
 * @param {object} settings Parsed settings.json; changed in place.
 * @returns {boolean} Whether anything moved.
 */
export function migrateLegacySettingsNames(settings) {
    if (!isPlainObject(settings)) return false;
    let changed = false;
    const extensions = settings.extension_settings;
    if (isPlainObject(extensions)) {
        for (const [from, to] of Object.entries(EXTENSION_SETTINGS_KEYS)) {
            changed = moveKey(extensions, from, to) || changed;
        }
        changed = moveKey(extensions.character_attachments, ...TIME_MACHINE_ATTACHMENTS) || changed;
        if (Array.isArray(extensions.disabledExtensions)) {
            const renamed = extensions.disabledExtensions.map(name => typeof name === 'string' ? name.replace(/^(third-party\/)?SillyBunny-/, '$1Neconyan-') : name);
            if (renamed.some((name, index) => name !== extensions.disabledExtensions[index])) {
                extensions.disabledExtensions = [...new Set(renamed)];
                changed = true;
            }
        }
    }
    if (isPlainObject(settings.accountStorage)) {
        for (const key of Object.keys(settings.accountStorage)) {
            if (/sillybunny/i.test(key)) changed = moveKey(settings.accountStorage, key, renameName(key)) || changed;
        }
    }
    return changed;
}

function migrateSettingsFile(directories, previous, next) {
    const filePath = path.join(directories.root, SETTINGS_FILE);
    try {
        return migrateChangedFile(filePath, previous, next, () => migrateSettingsText(filePath));
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

function migrateSettingsText(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!/sillybunny/i.test(text)) return false;
    const settings = JSON.parse(text);
    if (!migrateLegacySettingsNames(settings)) return false;

    // A tab opened before the update must reload rather than save the old names back.
    const previousRevision = getSettingsRevision(settings);
    settings._version = getSettingsVersion(settings) + 1;
    settings._settingsRevision = previousRevision + 1;
    const acknowledgement = settings.extension_settings?.neconyan_conversation?.automation?.acknowledgement;
    if (isPlainObject(acknowledgement) && acknowledgement.settingsRevision === previousRevision) {
        acknowledgement.settingsRevision = settings._settingsRevision;
    }
    tryWriteFileSync(filePath, JSON.stringify(settings, null, 4));
    return true;
}

function moveWorldKeys(extensions) {
    let changed = false;
    for (const [from, to] of Object.entries(WORLD_EXTENSION_KEYS)) {
        changed = moveKey(extensions, from, to) || changed;
    }
    return changed;
}

/**
 * Rename Pathfinder layout and World Info Lab keys in a parsed world book.
 * @param {object} book Parsed world file; changed in place.
 * @returns {boolean} Whether anything moved.
 */
export function migrateLegacyWorldNames(book) {
    if (!isPlainObject(book)) return false;
    let changed = moveWorldKeys(book.extensions);
    changed = moveWorldKeys(book.originalData?.extensions) || changed;
    const entries = isPlainObject(book.entries) ? Object.values(book.entries) : [];
    for (const entry of entries) {
        changed = moveWorldKeys(entry?.extensions) || changed;
    }
    return changed;
}

function migrateWorldFiles(directories, previous, next) {
    let moved = 0;
    if (!directories.worlds || !fs.existsSync(directories.worlds)) return moved;
    for (const fileName of fs.readdirSync(directories.worlds)) {
        if (!fileName.endsWith('.json')) continue;
        const filePath = path.join(directories.worlds, fileName);
        try {
            const changed = migrateChangedFile(filePath, previous, next, () => {
                const text = fs.readFileSync(filePath, 'utf8');
                if (!/sillybunny/i.test(text)) return false;
                const book = JSON.parse(text);
                if (!migrateLegacyWorldNames(book)) return false;
                tryWriteFileSync(filePath, JSON.stringify(book, null, 4));
                return true;
            });
            if (changed) moved += 1;
        } catch (error) {
            console.warn(`Could not rename old Neconyan keys in world file ${fileName}:`, error);
        }
    }
    return moved;
}

/** Give interrupted-write journals their new suffix and remove the old temporary files and locks. */
function migrateWriteLeftovers(directory, previous, next, root) {
    let moved = 0;
    let entries;
    let identity;
    try {
        identity = scanIdentity(directory);
        if (!identity.stat.isDirectory()) return moved;
        const cached = previous.directories[directory];
        // Directory timestamps cover entry changes, not changes below a child. Always
        // revisit each child, even when its parent's listing is unchanged.
        if (directory !== root && cached?.identity === identity.key && Array.isArray(cached.children)
            && cached.children.every(name => typeof name === 'string' && name && name !== '.' && name !== '..'
                && !name.includes('/') && !name.includes('\\') && !SKIPPED_DIRECTORIES.has(name))) {
            for (const name of cached.children) moved += migrateWriteLeftovers(path.join(directory, name), previous, next, root);
            next.directories[directory] = cached;
            return moved;
        }
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return moved;
    }
    const children = [];
    let clean = true;
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.name.endsWith(LEGACY_RECOVERY_SUFFIX) && entry.isFile()) {
            clean = false;
            const target = entryPath.slice(0, -LEGACY_RECOVERY_SUFFIX.length) + FILE_WRITE_RECOVERY_SUFFIX;
            if (!fs.existsSync(target)) {
                fs.renameSync(entryPath, target);
                moved += 1;
            }
        } else if (LEGACY_LEFTOVER.test(entry.name)) {
            clean = false;
            fs.rmSync(entryPath, { recursive: true, force: true });
            moved += 1;
        } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
            children.push(entry.name);
            moved += migrateWriteLeftovers(entryPath, previous, next, root);
        }
    }
    // The cache itself changes the root listing, so never cache that small listing.
    if (clean && directory !== root && scanIdentity(directory).key === identity.key) {
        next.directories[directory] = { identity: identity.key, children };
    }
    return moved;
}

/**
 * Move one account's old SillyBunny names to Neconyan names. Safe to run on every start.
 * @param {{root: string, worlds?: string}} directories User directories.
 * @returns {{settings: boolean, worlds: number, files: number}}
 */
export function migrateLegacyNamesForUser(directories) {
    const previous = loadScanCache(directories.root);
    const next = { version: 1, directories: {}, files: {} };
    const files = migrateWriteLeftovers(directories.root, previous, next, directories.root);
    const settings = migrateSettingsFile(directories, previous, next);
    const worlds = migrateWorldFiles(directories, previous, next);
    const serialized = JSON.stringify(next);
    if (serialized !== JSON.stringify(previous)) {
        try {
            tryWriteFileSync(path.join(directories.root, SCAN_CACHE_FILE), serialized);
        } catch (error) {
            console.warn('Could not cache the legacy name scan; the next start will check again.', error);
        }
    }
    return { settings, worlds, files };
}

/**
 * @param {Array<{root: string, worlds?: string}>} directoriesList Every account's directories.
 */
export function migrateLegacyNames(directoriesList) {
    for (const directories of directoriesList) {
        try {
            const result = migrateLegacyNamesForUser(directories);
            if (result.settings || result.worlds || result.files) {
                console.info(`Moved old SillyBunny names to Neconyan names for ${path.basename(directories.root)}.`);
            }
        } catch (error) {
            console.warn(`Could not move old SillyBunny names for ${path.basename(directories.root)}:`, error);
        }
    }
}
