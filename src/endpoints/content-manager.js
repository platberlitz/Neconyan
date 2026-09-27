import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, color, recoverFileWriteSync, setPermissionsSync, isValidUrl } from '../util.js';
import { read as readCharacterCard, write } from '../character-card-parser.js';
import { serverDirectory } from '../server-directory.js';
import { Jimp, JimpMime } from '../jimp.js';
import { DEFAULT_AVATAR_PATH, USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { invalidateThumbnail } from './thumbnails.js';
import { assertUntrackedRoleplayFiles, roleplayAccountBase, roleplayLease, validRoleplayAvatar, withRoleplayAccount, readRoleplayFile } from '../roleplay-store.js';
import { commitRoleplayLifecycleLocked, roleplayTrackedInstance } from '../roleplay-lifecycle.js';
import { writeAuthoringFileLocked } from '../authoring-store.js';
import { assertNativeMediaTargetIdle } from '../generation/media-jobs.js';

const contentDirectory = path.join(serverDirectory, 'default/content');
const scaffoldDirectory = path.join(serverDirectory, 'default/scaffold');
const contentIndexPath = path.join(contentDirectory, 'index.json');
const scaffoldIndexPath = path.join(scaffoldDirectory, 'index.json');
const DEFAULT_PRESET_DELETIONS_FILE = 'default-preset-deletions.json';

const WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES = getConfigValue('whitelistImportDomains', []);
const USER_AGENT = 'SillyTavern';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * @param {Buffer} buffer Image buffer
 * @returns {boolean} True if the buffer starts with a PNG signature
 */
function isPngBuffer(buffer) {
    return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * @param {unknown} error Error object
 * @returns {string} Error message with cause when available
 */
function getErrorMessage(error) {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
        return `${error.message}${cause}`;
    }

    return String(error);
}

/**
 * @param {string | null} contentDisposition Content-Disposition header
 * @returns {string | null} Decoded filename from the header
 */
function getFileNameFromContentDisposition(contentDisposition) {
    const fileNameMatch = contentDisposition?.match(/filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i);
    const fileName = fileNameMatch?.[1] || fileNameMatch?.[2];

    if (!fileName) {
        return null;
    }

    try {
        return decodeURIComponent(fileName.replace(/^"|"$/g, ''));
    } catch {
        return fileName.replace(/^"|"$/g, '');
    }
}

/**
 * @param {unknown} name Desired file name
 * @param {string} fallbackName Fallback file name
 * @returns {string} Sanitized PNG file name
 */
function getPngFileName(name, fallbackName = 'character') {
    const safeFallback = sanitize(String(fallbackName || 'character')) || 'character';
    const safeName = sanitize(String(name || safeFallback)) || safeFallback;

    return safeName.toLowerCase().endsWith('.png') ? safeName : `${safeName}.png`;
}

/**
 * @typedef {Object} ContentItem
 * @property {string} filename
 * @property {string} type
 * @property {string} [name]
 * @property {string|null} [folder]
 */

/**
 * @typedef {string} ContentType
 * @enum {string}
 */
export const CONTENT_TYPES = {
    SETTINGS: 'settings',
    CHARACTER: 'character',
    SPRITES: 'sprites',
    BACKGROUND: 'background',
    WORLD: 'world',
    AVATAR: 'avatar',
    THEME: 'theme',
    WORKFLOW: 'workflow',
    KOBOLD_PRESET: 'kobold_preset',
    OPENAI_PRESET: 'openai_preset',
    NOVEL_PRESET: 'novel_preset',
    TEXTGEN_PRESET: 'textgen_preset',
    INSTRUCT: 'instruct',
    CONTEXT: 'context',
    MOVING_UI: 'moving_ui',
    QUICK_REPLIES: 'quick_replies',
    SYSPROMPT: 'sysprompt',
    REASONING: 'reasoning',
    ERROR_PAGE: 'error_page',
    STYLESHEET: 'stylesheet',
};

export const PRESET_CONTENT_TYPES = Object.freeze([
    CONTENT_TYPES.KOBOLD_PRESET,
    CONTENT_TYPES.OPENAI_PRESET,
    CONTENT_TYPES.NOVEL_PRESET,
    CONTENT_TYPES.TEXTGEN_PRESET,
    CONTENT_TYPES.INSTRUCT,
    CONTENT_TYPES.CONTEXT,
    CONTENT_TYPES.SYSPROMPT,
    CONTENT_TYPES.REASONING,
]);

// Neconyan keeps retired bundle fingerprints so existing user edits can be
// distinguished from untouched files during the one-time migration.
export const RETIRED_CONTENT_ITEMS = Object.freeze([
    { stableName: 'bundle-01', filenameHash: '70766ba08221dd2c225d448868f4c341dcd7046ed46458556d8e8aadb2ecf41e', type: CONTENT_TYPES.CHARACTER, hashes: ['8a71e8270f54fafbccf905b1bdf053a6a55f57bea89c01fcd8c0e87ee76a2d52'] },
    { stableName: 'bundle-02', filenameHash: '06d65ffddad89cadeb3e090ec5f881f2c3d72ba6518263d634a1b485b5f70c61', type: CONTENT_TYPES.CHARACTER, hashes: ['622d2d33f343f03b6467c5cd00dcf1952f25bf0645e6df667b674b158299afe4'] },
    { stableName: 'bundle-03', filenameHash: '68dd946c583a3ff2cb30a771757eee4df7966c0f4ff4bd06655b96a7cc8913ab', type: CONTENT_TYPES.SPRITES, hashes: ['d38b009abc40ab4a93c738a22c3b8c84b099292519d01a0336456a6105974da4'] },
    { stableName: 'bundle-04', filenameHash: 'a942bd01c650ffdadaa188b43595570f44a734ee8380da39aaccc258b50b34c3', type: CONTENT_TYPES.WORLD, hashes: ['bfc2548443c890746a54d54e35e41265b02d1b59fd06d72552b305bf9b1e063c'] },
    { stableName: 'bundle-05', filenameHash: '86361ea2b7c588a0b72b22786f2c15e943be4bd5160260ef061e9299d01fb863', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['e05dc9121b9b3225cb1e8f2f7eec0318d84d9e7821d7722ea735787a6e2323fb'] },
    { stableName: 'bundle-06', filenameHash: '9bf63c6e4984cadaacf8c34c90c0d438d7765c858f380fcaf4f9f0a0b44eb6bb', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['730bf63124237040a7dbfea448effe31979185dba6ebfef4ceb4a04d1715473b'] },
    { stableName: 'bundle-07', filenameHash: '2db52aec0939458b25371f1f82777a45ad5a748d4c13b7c998765a101a32f61b', type: CONTENT_TYPES.CONTEXT, hashes: ['e880830c58ac5e477ca72fbd187050114561a567ccd9657e517e6e3c62fb5f27'] },
    { stableName: 'bundle-08', filenameHash: 'fd993da7152a60b12ae92e57367cef93ce4de7e063df5610f6e2b7f2b1f3b1d3', type: CONTENT_TYPES.CONTEXT, hashes: ['eea5e92d951b6934dcef0dd26eb3998db503e54febb2da9f245646c5352659ce'] },
    { stableName: 'bundle-09', filenameHash: '0200b225b616ce9c96b1a5a034b96e945b5c009460e5475dffb54f0864626975', type: CONTENT_TYPES.SYSPROMPT, hashes: ['d2be4bb55c763380bc3b7bbfd783ad61fcf13f505bd0b266d0e230b7ee65a3d1'] },
    { stableName: 'bundle-10', filenameHash: 'dc703c86d280fe37bb2f26ca6f5b1db40a97bc524b0ea8883e4b81924763fae1', type: CONTENT_TYPES.SYSPROMPT, hashes: ['a8f5b16d17eacda342fcf1e7606adcaf8925bd08c396581ed90e6cba57a95d50'] },
    { stableName: 'bundle-11', filenameHash: 'c0191a52a1eeae62c4ec2869b5214901794812f1d754caf7153f4af0051afdd2', type: CONTENT_TYPES.SYSPROMPT, hashes: ['7b41851555f7a65302e491223f02242466afc9851df8e9f090758c53d2292961'] },
    { stableName: 'bundle-12', filenameHash: '96f60211e67e49fa279bee094df711881a65e65f48e8ba4b7d9790ace5d0126c', type: CONTENT_TYPES.SYSPROMPT, hashes: ['f314d2976ef2e68f3f46ae864ec92c7afab19de5ae7a5ce3dd166661480ee86c'] },
    { stableName: 'bundle-13', filenameHash: 'a6833437c542468cc5e301b7ae37f77fd85730b53d301df4e07bdd1b00d5a159', type: CONTENT_TYPES.SYSPROMPT, hashes: ['ba75289e78a159f8c74b418ba09af078e8e76f8056a66dfc90c5b62ab024f097'] },
    { stableName: 'bundle-14', filenameHash: 'f0cbdaf313d972baca00a789cf5a6f70aae7e35c0d289e6848b6270f59078091', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['354a1e6df9294fa2888046579142bf6f4b96cc16e5c8fe3761dcf46c0b390595'] },
    { stableName: 'bundle-15', filenameHash: '4f8548c587c66674b932a8d08476ab9e287d2436bc89ccb0ccd474b4391094c8', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['8312894156feb4b40c745e293dee5b729b4791091339c190aba77dd92ebaf3d8'] },
    { stableName: 'bundle-16', filenameHash: 'bcb465154e6aaf8c0e2c3a2164d56605f9f0293faf6959af142ff3cf15f1c570', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['8312894156feb4b40c745e293dee5b729b4791091339c190aba77dd92ebaf3d8'] },
    { stableName: 'bundle-17', filenameHash: '0f37dd2fdde117eab8be52511d975fa9127208530185be81d7e71f550e07e087', type: CONTENT_TYPES.OPENAI_PRESET, hashes: ['385c5bbdfad4a75d5aebad327d609bf560e9daa37a930445e0c9341d54e0f94f'] },
    { stableName: 'background-01', filename: 'backgrounds/_black.jpg', filenameHash: 'c43e395d6bb52b804b5a018c67c1770d876cf1cab0232558885cebcd165ee693', type: CONTENT_TYPES.BACKGROUND, hashes: ['c562543a0eea1a5fb6a7b54030b37db44abf864fccebd17cf662b5e8c401fd2a'] },
    { stableName: 'background-02', filename: 'backgrounds/_white.jpg', filenameHash: '8788953b0a691c70a5a533de17d5d038e561bc5a872104a2dd7ba2ece0acf41f', type: CONTENT_TYPES.BACKGROUND, hashes: ['2dddd545d6efa2456a7386bea8226940dff8f028d4579d5b042a26f29d1b9db3'] },
    { stableName: 'background-03', filename: 'backgrounds/bedroom clean.jpg', filenameHash: 'b522fd620bf0f5504626aad4edf3b3408433d6fd0231bfa205451b339a728f3b', type: CONTENT_TYPES.BACKGROUND, hashes: ['c138b51f38b9e9fafec8ab7ffdbe04eb900953167797953411353da052c9d3bc'] },
    { stableName: 'background-04', filename: 'backgrounds/bedroom cyberpunk.jpg', filenameHash: '5c9a2a119b8b5b647fb53b990dfbab4214e00e7fba309b1278f3b6b8f8fd85bf', type: CONTENT_TYPES.BACKGROUND, hashes: ['12237000a0723c5e4eac98ae4d7da6d2b4fc5ac1b0e3affdaa6ef9175c2d4ff2'] },
    { stableName: 'background-05', filename: 'backgrounds/bedroom red.jpg', filenameHash: '6bc300cc6a8d04cc496241103c1ccbff2b9c8e66986f8f5e005dd8ee00247546', type: CONTENT_TYPES.BACKGROUND, hashes: ['9dbebe979d952981d9cb77f1dec004051e224ba7b35236684a0747d23b87bfb3'] },
    { stableName: 'background-06', filename: 'backgrounds/bedroom tatami.jpg', filenameHash: 'c614abf9c063e1bb375da3441adec13f04bd47bf3fe44584cb9c16f987b4b896', type: CONTENT_TYPES.BACKGROUND, hashes: ['6ec34e76d9556a5f93d907c9a9a8fac0665364e34d2e711c61fb41e66d5dcd3e'] },
    { stableName: 'background-07', filename: 'backgrounds/cityscape medieval market.jpg', filenameHash: '029ec6456552d9450774ad073c09230a8d18a5c6fa6a5b13a1e9e06104be4125', type: CONTENT_TYPES.BACKGROUND, hashes: ['63caa77149191b9be99b569087e6c2ce82f27724841e48dcf1aca34edcdd1e6b'] },
    { stableName: 'background-08', filename: 'backgrounds/cityscape medieval night.jpg', filenameHash: '75e91c58cf78262b4300fcc986c6df4c9928437bea424dc93343922821bc581c', type: CONTENT_TYPES.BACKGROUND, hashes: ['c863561cd0178a3401fa6d32688e3719988e85f57e8d131761a54c4728331275'] },
    { stableName: 'background-09', filename: 'backgrounds/cityscape postapoc.jpg', filenameHash: '866da5f8984028b14d44de02c6515baa5c4e47ec34f86f698e10a3074644f722', type: CONTENT_TYPES.BACKGROUND, hashes: ['9df377f4802cbe3386bcfd6d77f1f1482015a18aab1f4ba78010928096927efe'] },
    { stableName: 'background-10', filename: 'backgrounds/forest treehouse fireworks air baloons (by kallmeflocc).jpg', filenameHash: '7a8e46ce6309e68da9dd4c52b617082fc8ebd0673c9d6edca2475c3de4a67a79', type: CONTENT_TYPES.BACKGROUND, hashes: ['96f558bb26810b4e4b65001ade84ba992136a58af70ba49dc929141166ce88d5'] },
    { stableName: 'background-11', filename: 'backgrounds/japan classroom side.jpg', filenameHash: '08efb1f1cfb054b6630c9624a4b49d16e962eca110cdd080c1e649ebf37a2dea', type: CONTENT_TYPES.BACKGROUND, hashes: ['a97cf945acb14a3fba023fa4f39a5a314f14e55315707c37f13bf712958b11ca'] },
    { stableName: 'background-12', filename: 'backgrounds/japan classroom.jpg', filenameHash: '6552d578274958d4082ba57129668dcff5754f673a6bafcc9c20168712c43514', type: CONTENT_TYPES.BACKGROUND, hashes: ['0f3cf5732faf8a7a386b3a29427ff76b91447caf94c65a77453aaefa866787c2'] },
    { stableName: 'background-13', filename: 'backgrounds/japan path cherry blossom.jpg', filenameHash: '222b319c5b2ab5234bce920d6d507d11a0616ca52cef138a50376d4befc23b3a', type: CONTENT_TYPES.BACKGROUND, hashes: ['6e79fd32ef735be509ff76aaa2a9a7adf5c818baf9c133ab18f97ddbde939dbd'] },
    { stableName: 'background-14', filename: 'backgrounds/japan university.jpg', filenameHash: 'fb617c6afc0ec62c848256811386e087b2475aa02f71f6f2a86754e6d2a35e69', type: CONTENT_TYPES.BACKGROUND, hashes: ['284ad60047a8ad833fd21cdd57a96a17f111adff4b08ab8b23387c74a74661fe'] },
    { stableName: 'background-15', filename: 'backgrounds/landscape autumn great tree.jpg', filenameHash: '9d60e43fb40e2cd0fb3741c358b15e520d8aac6bed64f5c340500737f874fce6', type: CONTENT_TYPES.BACKGROUND, hashes: ['36d6d7910bededd0cf5d1151f25b394de63e6b1589e55081a799ebf29a141611'] },
    { stableName: 'background-16', filename: 'backgrounds/landscape beach day.png', filenameHash: '24d0c44d785c3a3d8db69bdc2f7799dbfd0677d7e2c48837b485fd00d3d05ca3', type: CONTENT_TYPES.BACKGROUND, hashes: ['8966f84d35ddbd81d4d6df179cbe216fd2df74841d6af9a1fc9e259fc55bf601'] },
    { stableName: 'background-17', filename: 'backgrounds/landscape beach night.jpg', filenameHash: 'afca6bf57318997b6c4acdca591ed97a512569de4c0e5774a7ae407cc0fad353', type: CONTENT_TYPES.BACKGROUND, hashes: ['3589c70337e208eab0c2ec0033771f4d0f2950b399dd12a92c4b41651c34833e'] },
    { stableName: 'background-18', filename: 'backgrounds/landscape mountain lake.jpg', filenameHash: 'f5c81ee8a56ccaf5a76292be046f2606067630d89ec8ec1766fe1c75f75ea37f', type: CONTENT_TYPES.BACKGROUND, hashes: ['f8704b2da19b14538887edb51b2f85eafd63333e1d7be034dd17c68e103af41b'] },
    { stableName: 'background-19', filename: 'backgrounds/landscape postapoc.jpg', filenameHash: 'f0d491813e672c6e646419fe00939b9771c2b0e9870216ec25e827295728170f', type: CONTENT_TYPES.BACKGROUND, hashes: ['f15f2ed31ebcc2bd291a916feb6a9b726a5c1d615d67c9dc5fefb6ffe275d34f'] },
    { stableName: 'background-20', filename: 'backgrounds/landscape winter lake house.jpg', filenameHash: '5135a0fbabb4f9fd2b2ba9d58175429be30708e2cc79943a79089dd572823fcb', type: CONTENT_TYPES.BACKGROUND, hashes: ['309e451eb98641b2fff7035e4cd50cf2123491289fe629a9ca7e708fff9583cb'] },
    { stableName: 'background-21', filename: 'backgrounds/royal.jpg', filenameHash: '71b1b58f5e34b75266c0deb4397f1d58646e2773193077fcf273e10b446c6700', type: CONTENT_TYPES.BACKGROUND, hashes: ['01c5bd746c86792340aa0a1039e750872bacfeab4c1a22a0e068c35083b5a959'] },
    { stableName: 'background-22', filename: 'backgrounds/tavern day.jpg', filenameHash: '543f8ab06657671ffaf5b0b815e0e60341884bef3908631c62460f1673e8d3c6', type: CONTENT_TYPES.BACKGROUND, hashes: ['5b9400b20ec88e42a043d30101c520de938cc9b817519070f44eec5f96ad6426'] },
    { stableName: 'default-avatar', filename: 'user-default.png', filenameHash: '7f15ce33b613c815b3206894d209ed602ed6ff19cd71b5aa658dc333c4507e4c', type: CONTENT_TYPES.AVATAR, hashes: ['ddf571f53289685b253d455a05f92b5ba1c11683314db2c1350a8542a5f83a0f'], oldHash: 'ddf571f53289685b253d455a05f92b5ba1c11683314db2c1350a8542a5f83a0f', replacementHash: 'bf89657f0d536f2804976bb6b5988d637c92a69766e2b9078608e954630a37d2', newHash: 'bf89657f0d536f2804976bb6b5988d637c92a69766e2b9078608e954630a37d2', action: 'replace' },
]);

// Neconyan divergence: reconcile only the bundled Memory Sharding quick reply
// during the existing default content pass. Hash-gating keeps user-authored or
// edited files untouched, repeated runs stay idempotent, and staleHashes is a
// migration ledger for future bundled prompt updates.
const MANAGED_BUNDLED_QUICK_REPLIES = Object.freeze([
    {
        bundledPath: 'presets/quick-replies/Memory Sharding.json',
        staleHashes: Object.freeze([]),
    },
]);

function isPresetContentType(type) {
    return PRESET_CONTENT_TYPES.includes(type);
}

function getDefaultPresetDeletionPath(directories) {
    return path.join(directories.root, DEFAULT_PRESET_DELETIONS_FILE);
}

function getDefaultPresetDeletionKey(contentItem) {
    return `${contentItem.type}::${contentItem.filename}`;
}

function normalizePresetDeletionData(data) {
    const normalized = { version: 1, deleted: {} };

    if (!data || typeof data !== 'object') {
        return normalized;
    }

    const source = data.deleted && typeof data.deleted === 'object' ? data.deleted : data;

    if (Array.isArray(source)) {
        for (const item of source) {
            if (!item || typeof item !== 'object' || !item.type || !item.filename) {
                continue;
            }

            normalized.deleted[getDefaultPresetDeletionKey(item)] = {
                type: String(item.type),
                filename: String(item.filename),
                deletedAt: Number(item.deletedAt) || Date.now(),
            };
        }

        return normalized;
    }

    for (const [key, value] of Object.entries(source)) {
        if (value === true) {
            const [type, filename] = key.split('::');
            if (type && filename) {
                normalized.deleted[key] = { type, filename, deletedAt: Date.now() };
            }
            continue;
        }

        if (!value || typeof value !== 'object' || !value.type || !value.filename) {
            continue;
        }

        normalized.deleted[getDefaultPresetDeletionKey(value)] = {
            type: String(value.type),
            filename: String(value.filename),
            deletedAt: Number(value.deletedAt) || Date.now(),
        };
    }

    return normalized;
}

export function getDefaultPresetDeletions(directories) {
    try {
        const deletionPath = getDefaultPresetDeletionPath(directories);
        if (!fs.existsSync(deletionPath)) {
            return { version: 1, deleted: {} };
        }

        return normalizePresetDeletionData(JSON.parse(fs.readFileSync(deletionPath, 'utf8')));
    } catch (error) {
        console.warn('Failed to read default preset deletions', error);
        return { version: 1, deleted: {} };
    }
}

function writeDefaultPresetDeletions(directories, deletions) {
    const normalized = normalizePresetDeletionData(deletions);
    const deletionPath = getDefaultPresetDeletionPath(directories);

    fs.mkdirSync(path.dirname(deletionPath), { recursive: true });
    writeFileAtomicSync(deletionPath, `${JSON.stringify(normalized, null, 4)}\n`, 'utf8');
}

export function isDefaultPresetDeleted(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    return Object.hasOwn(deletions.deleted, getDefaultPresetDeletionKey(contentItem));
}

export function recordDefaultPresetDeletion(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    const key = getDefaultPresetDeletionKey(contentItem);
    deletions.deleted[key] = {
        type: contentItem.type,
        filename: contentItem.filename,
        deletedAt: Date.now(),
    };
    writeDefaultPresetDeletions(directories, deletions);
    return true;
}

export function clearDefaultPresetDeletion(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    const key = getDefaultPresetDeletionKey(contentItem);

    if (!Object.hasOwn(deletions.deleted, key)) {
        return false;
    }

    delete deletions.deleted[key];
    writeDefaultPresetDeletions(directories, deletions);
    return true;
}

/**
 * @enum {string}
 */
export const CONTENT_SCOPE = {
    USER: 'user',
    GLOBAL: 'global',
};

/**
 * Gets the scope of a content type.
 * @param {CONTENT_TYPES} type Content type
 * @returns {CONTENT_SCOPE} Resolved content scope
 */
function getScopeByType(type) {
    const globalTypes = [
        CONTENT_TYPES.ERROR_PAGE,
        CONTENT_TYPES.STYLESHEET,
    ];
    return globalTypes.includes(type) ? CONTENT_SCOPE.GLOBAL : CONTENT_SCOPE.USER;
}

/**
 * Gets the default presets from the content directory.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object[]} Array of default presets
 */
export function getDefaultPresets(directories, { includeDeleted = true } = {}) {
    try {
        const contentIndex = getContentIndex(CONTENT_SCOPE.USER);
        const presets = [];

        for (const contentItem of contentIndex) {
            if (isPresetContentType(contentItem.type)) {
                if (!includeDeleted && isDefaultPresetDeleted(directories, contentItem)) {
                    continue;
                }

                presets.push({
                    ...contentItem,
                    name: path.parse(contentItem.filename).name,
                    folder: getUserTargetByType(contentItem.type, directories),
                    sourceFolder: contentItem.folder,
                });
            }
        }

        return presets;
    } catch (err) {
        console.warn('Failed to get default presets', err);
        return [];
    }
}

/**
 * Finds a bundled default preset by target folder and display name.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} options Lookup options
 * @param {string} options.folder Target folder
 * @param {string} options.name Preset name without extension
 * @returns {ContentItem|null} Default preset item
 */
export function findDefaultPreset(directories, { folder, name }) {
    if (!folder || !name) {
        return null;
    }

    const defaultPresets = getDefaultPresets(directories, { includeDeleted: true });
    return defaultPresets.find(preset => preset.folder === folder && preset.name === name) || null;
}

/**
 * Restores bundled default preset files for a user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]|null} types Content types to restore, or null for all preset types
 * @returns {{restored: string[], failed: {filename: string, error: string}[]}}
 */
export function restoreDefaultPresetFiles(directories, types = null, lease = null) {
    const allowedTypes = Array.isArray(types) && types.length ? new Set(types) : null;
    const defaultPresets = getDefaultPresets(directories, { includeDeleted: true })
        .filter(preset => !allowedTypes || allowedTypes.has(preset.type));
    const restored = [];
    const failed = [];

    for (const preset of defaultPresets) {
        try {
            const sourceFolder = preset.sourceFolder || contentDirectory;
            const sourcePath = path.join(sourceFolder, preset.filename);
            const targetFolder = preset.folder;
            const targetPath = path.join(targetFolder, path.parse(preset.filename).base);

            if (!targetFolder || !fs.existsSync(sourcePath)) {
                throw new Error('Default preset source is missing.');
            }

            if (lease) {
                assertNativeMediaTargetIdle(lease, { kind: 'preset', id: path.relative(directories.root, targetPath) });
                writeAuthoringFileLocked(lease, targetPath, fs.readFileSync(sourcePath));
            } else {
                fs.mkdirSync(targetFolder, { recursive: true });
                fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
            }
            setPermissionsSync(targetPath);
            clearDefaultPresetDeletion(directories, preset);
            restored.push(preset.filename);
        } catch (error) {
            if (error.code === 'MEDIA_TARGET_BUSY') throw error;
            failed.push({
                filename: preset.filename,
                error: error.message || String(error),
            });
        }
    }

    return { restored, failed };
}

/**
 * Gets a default JSON file from the content directory.
 * @param {string} filename Name of the file to get
 * @returns {object | null} JSON object or null if the file doesn't exist
 */
export function getDefaultPresetFile(filename) {
    try {
        const contentPath = path.join(contentDirectory, filename);

        if (!fs.existsSync(contentPath)) {
            return null;
        }

        const fileContent = fs.readFileSync(contentPath, 'utf8');
        return JSON.parse(fileContent);
    } catch (err) {
        console.warn(`Failed to get default file ${filename}`, err);
        return null;
    }
}

/**
 * Seeds content from a content index into a target location.
 * @param {ContentItem[]} contentIndex Content index
 * @param {string} contentLogPath Path to the content log file
 * @param {(type: string) => string | null} resolveTarget Function to resolve the target directory for a content type
 * @param {string[]} [forceCategories] List of categories to force check (even if content check is skipped)
 * @returns {boolean} Whether any content was added
 */
function seedContent(contentIndex, contentLogPath, resolveTarget, forceCategories, directories = null) {
    let anyContentAdded = false;
    const contentLog = getContentLog(contentLogPath);

    for (const contentItem of contentIndex) {
        const hasLoggedContent = contentLog.includes(contentItem.filename);

        // If the content item is already in the log, skip it
        if (hasLoggedContent && !forceCategories?.includes(contentItem.type)) {
            continue;
        }

        if (!contentItem.folder) {
            console.warn(`Content file ${contentItem.filename} has no parent folder`);
            continue;
        }

        const contentPath = path.join(contentItem.folder, contentItem.filename);

        if (!fs.existsSync(contentPath)) {
            console.warn(`Content file ${contentItem.filename} is missing`);
            continue;
        }

        const contentTarget = resolveTarget(contentItem.type);

        if (!contentTarget) {
            console.warn(`Content file ${contentItem.filename} has unknown type ${contentItem.type}`);
            continue;
        }

        const basePath = path.parse(contentItem.filename).base;
        const targetPath = path.join(contentTarget, basePath);

        if (!hasLoggedContent) {
            contentLog.push(contentItem.filename);
        }

        if (fs.existsSync(targetPath)) {
            if (!hasLoggedContent) {
                console.warn(`Content file ${contentItem.filename} already exists in ${contentTarget}`);
            }
            continue;
        }

        fs.mkdirSync(contentTarget, { recursive: true });
        const account = directories && contentItem.type === CONTENT_TYPES.CHARACTER ? roleplayAccountBase(directories) : null;
        if (account) {
            try {
                publishProtectedCard(account, fs.readFileSync(contentPath), targetPath, 'character-seed',
                    () => fs.cpSync(contentPath, targetPath, { force: false, errorOnExist: true }));
            } catch (error) {
                console.warn(`Content file ${contentItem.filename} could not be added safely`, error);
                continue;
            }
        } else {
            fs.cpSync(contentPath, targetPath, { recursive: true, force: false });
        }
        setPermissionsSync(targetPath);
        console.info(`Content file ${contentItem.filename} copied to ${contentTarget}`);
        anyContentAdded = true;
    }

    writeFileAtomicSync(contentLogPath, contentLog.join('\n'));
    return anyContentAdded;
}

/**
 * Creates a character card in a bootstrapped account through a recorded lifecycle, so vacant protected slots keep their generation.
 * Cards the protected reader cannot hold (invalid names or data) are proved untracked and written as ordinary files.
 */
function publishProtectedCard(account, bytes, targetPath, action, legacyWrite) {
    withRoleplayAccount(account, null, lease => {
        const avatar = path.basename(targetPath);
        const create = () => commitRoleplayLifecycleLocked(lease, {
            action, intent: { avatar, rawHash: getSha256(bytes) },
            steps: [{ op: 'create', kind: 'character', locator: { avatar }, bytes }],
        });
        if (!validRoleplayAvatar(avatar)) {
            assertUntrackedRoleplayFiles(lease, [targetPath]);
            return legacyWrite();
        }
        try {
            return create();
        } catch (error) {
            if (error?.code !== 'ROLEPLAY_SOURCE_DAMAGED') throw error;
            assertUntrackedRoleplayFiles(lease, [targetPath]);
            return legacyWrite();
        }
    });
}

/** Removes an unedited card after its archive copy verified; tracked cards retire through a recorded delete. */
function retireProtectedCard(account, source, expectedHash) {
    withRoleplayAccount(account, null, lease => {
        const locator = { avatar: path.basename(source) };
        const instanceId = roleplayTrackedInstance(lease, 'character', locator);
        if (getRetiredContentHash(source) !== expectedHash
            || (instanceId && roleplayLease(lease).state.resources[instanceId].head.rawHash !== expectedHash)) {
            throw makeRetiredError('The file changed before archiving.', 409);
        }
        if (!instanceId) {
            assertUntrackedRoleplayFiles(lease, [source]);
            return fs.unlinkSync(source);
        }
        commitRoleplayLifecycleLocked(lease, {
            action: 'character-retire', intent: { ...locator, rawHash: expectedHash },
            steps: [{ op: 'delete', kind: 'character', locator }],
        });
    });
}

function getSha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function openRetiredFile(targetPath, limit = Infinity) {
    const before = fs.lstatSync(targetPath);
    if (!before.isFile() || before.nlink > 1 || before.size > limit) {
        throw makeRetiredError('The file is linked, too large, or not a regular file.', 409);
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const fd = fs.openSync(targetPath, flags);
    try {
        const current = fs.fstatSync(fd);
        if (!current.isFile() || current.nlink > 1 || current.size > limit
            || current.dev !== before.dev || current.ino !== before.ino) {
            throw makeRetiredError('The file changed while it was being inspected.', 409);
        }
        return fd;
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

function readRetiredFile(targetPath, limit) {
    const fd = openRetiredFile(targetPath, limit);
    try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

export function getRetiredContentHash(targetPath) {
    try {
        const stat = fs.lstatSync(targetPath);
        if (!stat.isFile() && !stat.isDirectory()) return null;
        const files = [];
        const visit = (directory, relativeDirectory = '') => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const entryPath = path.join(directory, entry.name);
                const relativePath = path.posix.join(relativeDirectory, entry.name);
                const child = fs.lstatSync(entryPath);
                if (child.isDirectory()) visit(entryPath, relativePath);
                else if (child.isFile() && child.nlink <= 1) files.push([relativePath, entryPath]);
                else throw makeRetiredError('Linked or special files are not eligible.', 409);
            }
        };
        if (stat.isDirectory()) visit(targetPath);
        else files.push(['', targetPath]);
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        for (const [relativePath, filePath] of files) {
            if (stat.isDirectory()) hash.update(relativePath).update('\0');
            const fd = openRetiredFile(filePath);
            try {
                let length;
                while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
            } finally { fs.closeSync(fd); }
            if (stat.isDirectory()) hash.update('\0');
        }
        return hash.digest('hex');
    } catch {
        return null;
    }
}

/**
 * Returns exact, logged retired bundle matches for an explicit migration UI.
 * This read-only inventory is deliberately separate from deletion so callers
 * can show the user what will be retired before changing their data.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} [contentLog] Optional content log
 * @returns {{item: object, targetPath: string, hash: string}[]}
 */
export function getRetiredContentCandidates(directories, contentLog = null, catalog = RETIRED_CONTENT_ITEMS) {
    const profileRoot = getRetiredProfileRoot(directories);
    const log = Array.isArray(contentLog) ? contentLog : readRetiredContentLog(directories).log;

    return catalog.flatMap(item => {
        const filename = log.find(entry => typeof entry === 'string'
            && getSha256(Buffer.from(entry, 'utf8')) === item.filenameHash
            && (!item.filename || entry === item.filename));
        if (!filename) {
            return [];
        }

        const targetPath = getRetiredTargetPath(directories, item, filename);
        if (!targetPath || !hasSafePhysicalAncestors(profileRoot, targetPath)) return [];
        const hash = getRetiredContentHash(targetPath);
        return hash && item.hashes.includes(hash) ? [{ item: { ...item, filename }, targetPath, hash }] : [];
    });
}

const RETIRED_ARCHIVE_VERSION = 1;
const RETIRED_ARCHIVE_DIRECTORY = '_neconyan-retired-content';
const RETIRED_METADATA_LIMIT = 1024 * 1024;
const RETIRED_HEADER_LIMIT = 128 * 1024;
const RETIRED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,96}$/;

function getRetiredProfileRoot(directories) {
    if (typeof directories?.root !== 'string' || !directories.root.trim()) {
        throw makeRetiredError('Profile storage is unavailable.', 409);
    }
    const root = path.resolve(directories.root);
    try {
        if (!fs.lstatSync(root).isDirectory()) throw new Error('Not a directory');
    } catch { throw makeRetiredError('Profile storage is unavailable.', 409); }
    return root;
}

function isPathInside(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasSafePhysicalAncestors(rootDirectory, targetPath) {
    const root = path.resolve(rootDirectory);
    const target = path.resolve(targetPath);
    if (!isPathInside(root, target)) {
        return false;
    }

    let cursor = target;
    while (true) {
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                return false;
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                return false;
            }
        }
        if (cursor === root) {
            return true;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor || !isPathInside(root, parent)) {
            return false;
        }
        cursor = parent;
    }
}

function getRetiredArchivePaths(directories) {
    const root = getRetiredProfileRoot(directories);
    const rawBackups = String(directories?.backups || path.join(root, 'backups'));
    const cwdBackups = path.resolve(rawBackups);
    const backups = path.isAbsolute(rawBackups) || isPathInside(root, cwdBackups) ? cwdBackups : path.resolve(root, rawBackups);
    const archive = path.join(backups, RETIRED_ARCHIVE_DIRECTORY);
    if (!isPathInside(root, backups) || !isPathInside(root, archive) || !hasSafePhysicalAncestors(root, archive)) {
        throw new Error('Retired archive path escapes the profile.');
    }
    return {
        root,
        backups,
        archive,
        index: path.join(archive, 'index.json'),
        records: path.join(archive, 'records'),
    };
}

function getRetiredTargetPath(directories, item, filename = item?.filename) {
    const targetDirectory = getUserTargetByType(item?.type, directories);
    if (!targetDirectory || typeof filename !== 'string' || !filename) {
        return null;
    }
    const root = getRetiredProfileRoot(directories);
    const rawTarget = String(targetDirectory);
    const cwdTarget = path.resolve(rawTarget);
    const resolvedTargetDirectory = path.isAbsolute(rawTarget) || isPathInside(root, cwdTarget) ? cwdTarget : path.resolve(root, rawTarget);
    const target = path.resolve(resolvedTargetDirectory, path.basename(filename));
    return hasSafePhysicalAncestors(root, target) ? target : null;
}

function getRetiredTargetDirectory(directories, type) {
    const directory = getUserTargetByType(type, directories);
    if (!directory) return null;
    const root = getRetiredProfileRoot(directories);
    const rawDirectory = String(directory);
    const cwdDirectory = path.resolve(rawDirectory);
    return path.isAbsolute(rawDirectory) || isPathInside(root, cwdDirectory) ? cwdDirectory : path.resolve(root, rawDirectory);
}

function resolveRetiredProfileDirectory(directories, directory) {
    if (!directory) return null;
    const root = getRetiredProfileRoot(directories);
    const raw = String(directory);
    const cwdPath = path.resolve(raw);
    return path.isAbsolute(raw) || isPathInside(root, cwdPath) ? cwdPath : path.resolve(root, raw);
}

function inspectRetiredPath(targetPath) {
    let stat;
    try {
        stat = fs.lstatSync(targetPath);
    } catch (error) {
        return { ok: false, present: error?.code !== 'ENOENT', reason: error?.code === 'ENOENT' ? 'File is missing.' : 'File could not be inspected.' };
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        return { ok: false, present: true, reason: 'Linked files are not eligible.' };
    }
    if (!stat.isFile() && !stat.isDirectory()) {
        return { ok: false, present: true, reason: 'Special files are not eligible.' };
    }
    const hash = getRetiredContentHash(targetPath);
    if (!hash) {
        return { ok: false, present: true, reason: 'The file could not be read safely.' };
    }
    return { ok: true, present: true, kind: stat.isDirectory() ? 'directory' : 'file', hash };
}

function readRetiredContentLog(directories) {
    const root = getRetiredProfileRoot(directories);
    const logPath = path.join(root, 'content.log');
    if (!hasSafePhysicalAncestors(root, logPath)) return { log: [], warning: 'The content log path is unsafe.' };
    try {
        return { log: new TextDecoder('utf-8', { fatal: true }).decode(readRetiredFile(logPath, RETIRED_METADATA_LIMIT)).split('\n') };
    } catch (error) {
        return error?.code === 'ENOENT' ? { log: [] } : { log: [], warning: 'The content log could not be read safely.' };
    }
}

function safeReadJson(targetPath) {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(readRetiredFile(targetPath, RETIRED_METADATA_LIMIT));
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
    } catch (error) {
        return { ok: false, missing: error?.code === 'ENOENT' };
    }
}

function readRetiredHeader(targetPath) {
    let fd;
    try {
        fd = openRetiredFile(targetPath);
        const buffer = Buffer.alloc(RETIRED_HEADER_LIMIT);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const lineEnd = buffer.subarray(0, length).indexOf(0x0a);
        if (lineEnd < 0 && length === buffer.length) return null;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, lineEnd < 0 ? length : lineEnd));
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function retiredNameMatches(value, item) {
    if (typeof value !== 'string' || typeof item?.filename !== 'string') return false;
    let name = value.trim().replace(/^url\(\s*["']?|["']?\s*\)$/gi, '').replaceAll('\\', '/').split(/[?#]/, 1)[0];
    try { name = decodeURIComponent(name); } catch { /* Keep literal names when they are not URL encoded. */ }
    const actual = path.posix.basename(name).toLowerCase();
    const expected = path.basename(item.filename).toLowerCase();
    return actual === expected || actual === path.parse(expected).name || path.parse(actual).name === expected;
}

function collectMatchingRetiredReferences(value, item, reason, output) {
    if (typeof value === 'string') {
        if (retiredNameMatches(value, item)) output.add(reason);
    } else if (Array.isArray(value)) {
        value.forEach(entry => collectMatchingRetiredReferences(entry, item, reason, output));
    } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            const nonempty = entry !== null && entry !== undefined
                && !(Array.isArray(entry) && entry.length === 0)
                && !(typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 0);
            if (nonempty && retiredNameMatches(key, item)) output.add(reason);
            collectMatchingRetiredReferences(entry, item, reason, output);
        }
    }
}

function getRetiredReferenceMap(directories, candidates) {
    const root = getRetiredProfileRoot(directories);
    const references = new Map(candidates.map(candidate => [candidate.item.stableName, new Set()]));
    const warnings = new Set();
    const worldTypes = [CONTENT_TYPES.WORLD, CONTENT_TYPES.BACKGROUND];
    const cardTypes = [CONTENT_TYPES.WORLD, CONTENT_TYPES.SPRITES];
    const allTypes = [CONTENT_TYPES.CHARACTER, CONTENT_TYPES.SPRITES, CONTENT_TYPES.WORLD, CONTENT_TYPES.BACKGROUND, ...PRESET_CONTENT_TYPES];
    const mark = (candidate, reason) => references.get(candidate.item.stableName).add(reason);
    const block = (types, reason) => {
        warnings.add(reason);
        candidates.filter(candidate => types.includes(candidate.item.type)).forEach(candidate => mark(candidate, reason));
    };
    const collect = (value, types, reason) => {
        for (const candidate of candidates) {
            if (types.includes(candidate.item.type)) collectMatchingRetiredReferences(value, candidate.item, reason, references.get(candidate.item.stableName));
        }
    };
    const directoryFor = key => resolveRetiredProfileDirectory(directories, directories[key] || path.join(root, USER_DIRECTORY_TEMPLATE[key]));
    const readDirectory = (directory, types, reason) => {
        try {
            if (!directory || !hasSafePhysicalAncestors(root, directory) || !fs.lstatSync(directory).isDirectory()) throw new Error('Unsafe directory');
            return fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            if (error?.code !== 'ENOENT') block(types, reason);
            return [];
        }
    };
    const settings = safeReadJson(path.join(root, 'settings.json'));
    if (settings.ok) collect(settings.value, allTypes, 'Saved settings reference.');
    else if (!settings.missing) block(allTypes, 'Saved settings could not be inspected.');

    const metadata = safeReadJson(path.join(root, 'image-metadata.json'));
    if (metadata.ok) {
        const { images, folders } = metadata.value;
        const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        const valid = object(images) && Array.isArray(folders)
            && Object.values(images).every(image => object(image) && (image.folderIds === undefined
                || (Array.isArray(image.folderIds) && image.folderIds.every(id => typeof id === 'string' && id))))
            && folders.every(folder => object(folder) && typeof folder.id === 'string' && folder.id
                && typeof folder.thumbnailFile === 'string' && (folder.name === undefined || typeof folder.name === 'string'));
        if (!valid) block([CONTENT_TYPES.BACKGROUND], 'Background folders could not be inspected.');
        else {
            for (const [filename, image] of Object.entries(images)) {
                if (image.folderIds?.length) collect(filename, [CONTENT_TYPES.BACKGROUND], 'Assigned to a background folder.');
            }
            collect(folders, [CONTENT_TYPES.BACKGROUND], 'Used as a background folder cover.');
        }
    } else if (!metadata.missing) block([CONTENT_TYPES.BACKGROUND], 'Background folders could not be inspected.');

    const groupsDirectory = directoryFor('groups');
    for (const entry of readDirectory(groupsDirectory, allTypes, 'Saved groups could not be inspected.')) {
        if (path.extname(entry.name).toLowerCase() !== '.json') continue;
        const group = safeReadJson(path.join(groupsDirectory, entry.name));
        if (group.ok) collect(group.value, allTypes, 'Saved group reference.');
        else block(allTypes, 'Saved groups could not be inspected.');
    }

    for (const candidate of candidates) candidate.item.dependsOn = [];
    const charactersDirectory = directoryFor('characters');
    for (const entry of readDirectory(charactersDirectory, cardTypes, 'Saved character data could not be inspected.')) {
        // The host's character catalog is flat; subdirectories contain expression images.
        if (path.extname(entry.name).toLowerCase() !== '.png') continue;
        const filename = path.join(charactersDirectory, entry.name);
        let character;
        try {
            character = JSON.parse(readCharacterCard(readRetiredFile(filename, 32 * 1024 * 1024)));
            if (!character || typeof character !== 'object' || Array.isArray(character)) throw new Error('Invalid card');
        } catch {
            block(cardTypes, 'Saved character data could not be inspected.');
            continue;
        }
        const data = character.data || character;
        const owner = candidates.find(candidate => candidate.item.type === CONTENT_TYPES.CHARACTER
            && (process.platform === 'win32' ? candidate.targetPath.toLowerCase() === filename.toLowerCase() : candidate.targetPath === filename));
        const spriteNames = [data.name, character.name, path.parse(entry.name).name];
        for (const candidate of candidates) {
            const linked = candidate.item.type === CONTENT_TYPES.WORLD
                ? retiredNameMatches(data.extensions?.world ?? character.extensions?.world, candidate.item)
                : candidate.item.type === CONTENT_TYPES.SPRITES && spriteNames.some(name => retiredNameMatches(name, candidate.item));
            if (!linked) continue;
            if (owner) candidate.item.dependsOn.push(owner.item.stableName);
            else mark(candidate, 'Linked to a retained character.');
        }
    }

    const scanChats = (directory, owners = [], rootScan = false) => {
        const types = rootScan ? [CONTENT_TYPES.CHARACTER, ...worldTypes] : worldTypes;
        const reason = 'Saved chat metadata could not be inspected.';
        let entries;
        try {
            if (!hasSafePhysicalAncestors(root, directory) || !fs.lstatSync(directory).isDirectory()) throw new Error('Unsafe chat directory');
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                block(types, reason);
                owners.forEach(candidate => mark(candidate, reason));
            }
            return;
        }
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            const linkedOwners = [...new Set([...owners, ...candidates.filter(candidate => candidate.item.type === CONTENT_TYPES.CHARACTER
                && retiredNameMatches(entry.name, candidate.item))])];
            if (entry.isDirectory()) {
                scanChats(filePath, linkedOwners);
            } else if (entry.isSymbolicLink()) {
                block(worldTypes, reason);
                linkedOwners.forEach(candidate => mark(candidate, reason));
            } else if (path.extname(entry.name).toLowerCase() === '.jsonl') {
                owners.forEach(candidate => mark(candidate, 'Has a saved chat.'));
                const header = readRetiredHeader(filePath);
                if (header) collect(header, [CONTENT_TYPES.CHARACTER, ...worldTypes], 'Saved chat reference.');
                else {
                    block(worldTypes, reason);
                    owners.forEach(candidate => mark(candidate, reason));
                }
            }
        }
    };
    scanChats(directoryFor('chats'), [], true);
    scanChats(directoryFor('groupChats'), [], true);

    const scanAttachmentFiles = directory => {
        for (const entry of readDirectory(directory, [CONTENT_TYPES.CHARACTER], 'Saved attachments could not be inspected.')) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) scanAttachmentFiles(target);
            else if (entry.isSymbolicLink()) block([CONTENT_TYPES.CHARACTER], 'Saved attachments could not be inspected.');
            else collect(entry.name, [CONTENT_TYPES.CHARACTER], 'Saved attachment reference.');
        }
    };
    scanAttachmentFiles(directoryFor('assets'));
    scanAttachmentFiles(directoryFor('files'));

    for (const candidate of candidates) {
        candidate.item.dependsOn = [...new Set(candidate.item.dependsOn)];
        if (candidate.item.dependsOn.some(id => references.get(id)?.size)) mark(candidate, 'A linked character is still in use.');
    }
    return { references, warnings: [...warnings] };
}

function isRetiredBasename(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 255
        && value !== '.' && value !== '..' && sanitize(value) === value
        && !value.includes('/') && !value.includes('\\');
}

function validateRetiredRecord(record, catalog) {
    const item = catalog.find(item => item.stableName === record?.itemId);
    const date = value => value === null || (typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value)));
    return Boolean(item && record && typeof record === 'object' && !Array.isArray(record)
        && typeof record.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.id)
        && record.type === item.type && isRetiredBasename(record.name)
        && (!item.filename || record.name === path.basename(item.filename))
        && record.kind === (item.type === CONTENT_TYPES.SPRITES ? 'directory' : 'file')
        && item.hashes.includes(record.hash)
        && record.payload === `records/${record.id}/payload`
        && ['pending', 'archived', 'restoring', 'restored', 'attention'].includes(record.status)
        && (record.restoredName === null || isRetiredBasename(record.restoredName))
        && (!['restoring', 'restored'].includes(record.status) || record.restoredName !== null)
        && date(record.restoredAt) && date(record.archivedAt));
}

function readRetiredArchiveIndex(directories, catalog) {
    const paths = getRetiredArchivePaths(directories);
    try {
        if (!hasSafePhysicalAncestors(paths.root, paths.index)) throw new Error('Unsafe index');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readRetiredFile(paths.index, RETIRED_METADATA_LIMIT)));
        if (value?.version !== RETIRED_ARCHIVE_VERSION || !Array.isArray(value.records)
            || !value.records.every(record => validateRetiredRecord(record, catalog))
            || new Set(value.records.map(record => record.id)).size !== value.records.length) throw new Error('Invalid index');
        return { paths, records: value.records };
    } catch (error) {
        if (error?.code === 'ENOENT') return { paths, records: [] };
        throw makeRetiredError('The recovery index could not be validated. It was left unchanged.', 409);
    }
}

function writeRetiredArchiveIndex(paths, records) {
    try {
        if (!hasSafePhysicalAncestors(paths.root, paths.index)) throw new Error('Unsafe index path');
        try {
            const stat = fs.lstatSync(paths.index);
            if (!stat.isFile() || stat.nlink > 1) throw new Error('Unsafe index');
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        fs.mkdirSync(paths.archive, { recursive: true });
        if (!hasSafePhysicalAncestors(paths.root, paths.index)) throw new Error('Unsafe index path');
        writeFileAtomicSync(paths.index, `${JSON.stringify({ version: RETIRED_ARCHIVE_VERSION, records }, null, 2)}\n`, 'utf8');
    } catch {
        throw makeRetiredError('The recovery index could not be saved. Check old defaults and retry.', 409);
    }
}

function isRetiredRecordPayloadValid(directories, record) {
    const paths = getRetiredArchivePaths(directories);
    const payload = path.resolve(paths.archive, ...record.payload.split('/'));
    const inspection = hasSafePhysicalAncestors(paths.root, payload)
        ? inspectRetiredPath(payload) : { ok: false, present: true };
    return { payload, inspection, ok: inspection.ok && inspection.kind === record.kind && inspection.hash === record.hash };
}

function publishRetiredFile(source, destination, expectedHash) {
    // Publish a verified sibling file without rename's overwrite semantics.
    const temporary = path.join(path.dirname(destination), `.neconyan-restore-${crypto.randomUUID()}`);
    let owned;
    try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        owned = fs.lstatSync(temporary);
        if (getRetiredContentHash(temporary) !== expectedHash) throw makeRetiredError('The copied bytes did not verify.', 409);
        fs.linkSync(temporary, destination);
    } finally {
        if (owned) {
            try {
                const current = fs.lstatSync(temporary);
                if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(temporary);
            } catch { /* Never delete an unrelated file while cleaning up a failed publication. */ }
        }
    }
}

function publishRetiredPayload(source, destination, kind, expectedHash) {
    if (kind === 'directory') {
        fs.mkdirSync(destination);
        for (const name of fs.readdirSync(source)) {
            fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
        }
    } else publishRetiredFile(source, destination, expectedHash);
    const restored = inspectRetiredPath(destination);
    if (!restored.ok || restored.hash !== expectedHash || restored.kind !== kind) {
        throw makeRetiredError('Restored bytes did not verify. Existing files were kept.', 409);
    }
}

function reconcileRetiredRecords(directories, index, catalog) {
    const records = [];
    const attention = new Set();
    let changed = false;
    for (const original of index.records) {
        let record = original;
        const item = catalog.find(item => item.stableName === record.itemId);
        const payload = isRetiredRecordPayloadValid(directories, record);
        if (record.status === 'attention') {
            attention.add(record.id);
        } else if (record.status === 'pending') {
            const source = getRetiredTargetPath(directories, item, record.name);
            const sourceState = source ? inspectRetiredPath(source) : { ok: false, present: true };
            if (!payload.inspection.present && sourceState.ok && sourceState.hash === record.hash && sourceState.kind === record.kind) {
                changed = true;
                continue;
            }
            if (!payload.ok) {
                attention.add(record.id);
            } else if (sourceState.ok && sourceState.hash === record.hash && sourceState.kind === record.kind) {
                record = { ...record, status: 'restored', restoredName: record.name, restoredAt: record.restoredAt || new Date().toISOString() };
            } else if (item.action !== 'replace' && !sourceState.present) {
                record = { ...record, status: 'archived', archivedAt: record.archivedAt || new Date().toISOString() };
            } else if (item.action === 'replace') {
                if (!sourceState.present) {
                    try {
                        publishRetiredFile(payload.payload, source, record.hash);
                        record = { ...record, status: 'restored', restoredName: record.name, restoredAt: new Date().toISOString() };
                    } catch { attention.add(record.id); }
                } else if (sourceState.ok && sourceState.kind === 'file' && sourceState.hash === item.replacementHash) {
                    record = { ...record, status: 'archived', archivedAt: record.archivedAt || new Date().toISOString() };
                } else attention.add(record.id);
            } else attention.add(record.id);
        } else if (!payload.ok) {
            attention.add(record.id);
        } else if (record.status === 'restoring') {
            const directory = getRetiredTargetDirectory(directories, item.type);
            if (!directory || !hasSafePhysicalAncestors(index.paths.root, directory)) {
                attention.add(record.id);
            } else {
                const destination = inspectRetiredPath(path.join(directory, record.restoredName));
                if (destination.ok && destination.hash === record.hash && destination.kind === record.kind) {
                    record = { ...record, status: 'restored', restoredAt: new Date().toISOString() };
                }
            }
        }
        records.push(record);
        if (record !== original) invalidateRetiredThumbnail(directories, item, record.restoredName || record.name);
        changed ||= record !== original;
    }
    if (changed) writeRetiredArchiveIndex(index.paths, records);
    return { ...index, records, attention };
}

function loadRetiredArchiveIndex(directories, catalog) {
    return reconcileRetiredRecords(directories, readRetiredArchiveIndex(directories, catalog), catalog);
}

function toPublicRetiredRecord(record, attention = false) {
    return {
        id: record.id, itemId: record.itemId, type: record.type, name: record.name, kind: record.kind,
        status: attention ? 'attention' : record.status,
        archivedAt: record.archivedAt, restoredName: record.restoredName, restoredAt: record.restoredAt,
        reason: attention ? 'This archive could not be verified. Check the archived files before restoring.' : '',
    };
}

function getFreshRetiredCandidates(directories, catalog) {
    const logResult = readRetiredContentLog(directories);
    const candidates = getRetiredContentCandidates(directories, logResult.log, catalog).flatMap(candidate => {
        const inspection = inspectRetiredPath(candidate.targetPath);
        return inspection.ok && inspection.hash === candidate.hash ? [{ ...candidate, kind: inspection.kind }] : [];
    });
    return { candidates, warnings: logResult.warning ? [logResult.warning] : [] };
}

export function inspectRetiredContent(directories, catalog = RETIRED_CONTENT_ITEMS) {
    try {
        const index = loadRetiredArchiveIndex(directories, catalog);
        const fresh = getFreshRetiredCandidates(directories, catalog);
        const references = getRetiredReferenceMap(directories, fresh.candidates);
        const blockedItems = new Set(index.records.filter(record => index.attention.has(record.id)).map(record => record.itemId));
        return {
            candidates: fresh.candidates.map(candidate => {
                const { item } = candidate;
                const reasons = [...references.references.get(item.stableName)];
                if (blockedItems.has(item.stableName)) reasons.unshift('An earlier archive needs attention. No files were changed.');
                return {
                    id: item.stableName, itemId: item.stableName, type: item.type, name: path.basename(item.filename), kind: candidate.kind,
                    action: item.action === 'replace' ? 'replace' : 'archive',
                    state: blockedItems.has(item.stableName) || (reasons.length && item.action !== 'replace') ? 'in-use' : 'ready',
                    reason: reasons[0] || (item.action === 'replace' ? 'Archive the old avatar and use the Neconyan avatar.' : ''),
                    reasons, dependencies: item.dependsOn || [],
                };
            }),
            archived: index.records.map(record => toPublicRetiredRecord(record, index.attention.has(record.id))),
            warnings: [...new Set([...fresh.warnings, ...references.warnings])],
        };
    } catch (error) {
        return { candidates: [], archived: [], warnings: [error.publicMessage || 'The recovery files could not be inspected safely.'] };
    }
}

function makeRetiredError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.publicMessage = message;
    return error;
}

function invalidateRetiredThumbnail(directories, item, name) {
    const type = item.type === CONTENT_TYPES.BACKGROUND ? 'bg'
        : item.type === CONTENT_TYPES.CHARACTER ? 'avatar' : item.type === CONTENT_TYPES.AVATAR ? 'persona' : null;
    if (type) {
        const keys = type === 'bg' ? ['thumbnailsBg', 'thumbnailsBgMobile']
            : type === 'avatar' ? ['thumbnailsAvatar', 'thumbnailsAvatarMobile'] : ['thumbnailsPersona', 'thumbnailsPersonaMobile'];
        if (keys.some(key => !directories[key] || !hasSafePhysicalAncestors(getRetiredProfileRoot(directories),
            path.join(resolveRetiredProfileDirectory(directories, directories[key]), name)))) return;
        try { invalidateThumbnail(directories, type, name); } catch { /* A cache failure must not undo a verified archive. */ }
    }
}

export function archiveRetiredContent(directories, ids, catalog = RETIRED_CONTENT_ITEMS) {
    if (!Array.isArray(ids) || !ids.length || ids.length > catalog.length
        || ids.some(id => typeof id !== 'string' || !RETIRED_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
        throw makeRetiredError('Choose valid retired files to archive.');
    }
    const byId = new Map(catalog.map(item => [item.stableName, item]));
    if (ids.some(id => !byId.has(id))) throw makeRetiredError('The selected retired file is not available.');
    const index = loadRetiredArchiveIndex(directories, catalog);
    let records = index.records;
    const initial = getFreshRetiredCandidates(directories, catalog);
    getRetiredReferenceMap(directories, initial.candidates);
    const dependencies = new Map(initial.candidates.map(candidate => [candidate.item.stableName, candidate.item.dependsOn]));
    const ordered = [...ids].sort((a, b) => Number(byId.get(b).type === CONTENT_TYPES.CHARACTER) - Number(byId.get(a).type === CONTENT_TYPES.CHARACTER));
    const succeeded = new Set();
    const results = [];
    // ponytail: the fixed 39-item catalog is synchronous; use a queued worker if profile scans become too large.
    for (const id of ordered) {
        const item = byId.get(id);
        let pending;
        let source;
        let payload;
        let pendingCommitted = false;
        let moveAttempted = false;
        try {
            if (index.records.some(record => record.itemId === id && index.attention.has(record.id))) throw makeRetiredError('An earlier archive needs attention.', 409);
            if ((dependencies.get(id) || []).some(dependency => ids.includes(dependency) && !succeeded.has(dependency))) {
                throw makeRetiredError('A required selected character could not be archived.', 409);
            }
            const fresh = getFreshRetiredCandidates(directories, catalog);
            const references = getRetiredReferenceMap(directories, fresh.candidates);
            const candidate = fresh.candidates.find(candidate => candidate.item.stableName === id);
            if (!candidate) {
                const previous = [...records].reverse().find(record => record.itemId === id && ['archived', 'restored'].includes(record.status));
                const original = previous && getRetiredTargetPath(directories, item, previous.name);
                const originalState = original ? inspectRetiredPath(original) : null;
                const replaced = item.action === 'replace' && originalState?.ok && originalState.kind === 'file'
                    && originalState.hash === item.replacementHash;
                if (previous && originalState && (!originalState.present || replaced) && isRetiredRecordPayloadValid(directories, previous).ok) {
                    results.push({ id, ok: true, status: previous.status, name: previous.name, replaced: Boolean(replaced) });
                    succeeded.add(id);
                    continue;
                }
                throw makeRetiredError('The file is missing, edited, linked, or changed.', 409);
            }
            const reasons = [...references.references.get(id)];
            if (item.action !== 'replace' && reasons.length) throw makeRetiredError(reasons[0], 409);
            if (candidate.item.dependsOn.length) throw makeRetiredError('Select the linked character first. Its files must be archived before this item.', 409);
            source = getRetiredTargetPath(directories, item, candidate.item.filename);
            const sourceState = source ? inspectRetiredPath(source) : { ok: false };
            if (!sourceState.ok || sourceState.hash !== candidate.hash || sourceState.kind !== candidate.kind) throw makeRetiredError('The file changed before archiving.', 409);
            const bundle = item.action === 'replace' ? path.join(contentDirectory, path.basename(candidate.item.filename)) : null;
            if (bundle && getRetiredContentHash(bundle) !== item.replacementHash) throw makeRetiredError('The bundled replacement avatar could not be verified.', 409);
            const recordId = crypto.randomUUID();
            pending = {
                id: recordId, itemId: id, type: item.type, name: path.basename(candidate.item.filename), kind: candidate.kind, hash: candidate.hash,
                payload: `records/${recordId}/payload`, status: 'pending', archivedAt: null, restoredName: null, restoredAt: null,
            };
            payload = path.join(index.paths.records, recordId, 'payload');
            if (!hasSafePhysicalAncestors(index.paths.root, payload)) throw makeRetiredError('The archive path is unsafe.', 409);
            fs.mkdirSync(index.paths.records, { recursive: true });
            fs.mkdirSync(path.dirname(payload));
            if (!hasSafePhysicalAncestors(index.paths.root, payload)) throw makeRetiredError('The archive path is unsafe.', 409);
            const staged = [...records, pending];
            writeRetiredArchiveIndex(index.paths, staged);
            records = staged;
            pendingCommitted = true;
            const finalCandidate = getFreshRetiredCandidates(directories, [item]).candidates[0];
            if (!finalCandidate || finalCandidate.hash !== candidate.hash || finalCandidate.kind !== candidate.kind) {
                throw makeRetiredError('The file changed before archiving.', 409);
            }
            const finalReasons = getRetiredReferenceMap(directories, [finalCandidate]).references.get(id);
            if (item.action !== 'replace' && finalReasons.size) throw makeRetiredError([...finalReasons][0], 409);
            moveAttempted = true;
            const account = item.type === CONTENT_TYPES.CHARACTER && candidate.kind === 'file' ? roleplayAccountBase(directories) : null;
            if (account) {
                // Copy first: a crash leaves both copies, which reconciliation records as restored.
                publishRetiredFile(source, payload, pending.hash);
                retireProtectedCard(account, source, pending.hash);
            } else {
                fs.renameSync(source, payload);
            }
            const moved = inspectRetiredPath(payload);
            if (!moved.ok || moved.hash !== pending.hash || moved.kind !== pending.kind) throw makeRetiredError('The archived bytes did not verify. The recovery record was kept.', 409);
            if (bundle) {
                publishRetiredFile(bundle, source, item.replacementHash);
                if (getRetiredContentHash(source) !== item.replacementHash) throw makeRetiredError('The replacement avatar changed during installation.', 409);
            }
            const archived = { ...pending, status: 'archived', archivedAt: new Date().toISOString() };
            const completed = records.map(record => record.id === pending.id ? archived : record);
            writeRetiredArchiveIndex(index.paths, completed);
            records = completed;
            invalidateRetiredThumbnail(directories, item, pending.name);
            succeeded.add(id);
            results.push({ id, ok: true, status: 'archived', name: pending.name, replaced: Boolean(bundle) });
        } catch (error) {
            // The on-disk pending record must survive every failure after the move.
            if (pendingCommitted && !moveAttempted) {
                const unused = records.filter(record => record.id !== pending.id);
                try { writeRetiredArchiveIndex(index.paths, unused); records = unused; } catch { /* The unused pending record remains recoverable. */ }
            }
            if (pendingCommitted && moveAttempted && source && hasSafePhysicalAncestors(index.paths.root, source)
                && !inspectRetiredPath(source).present) {
                try {
                    const recovery = isRetiredRecordPayloadValid(directories, pending);
                    if (recovery.inspection.ok && recovery.inspection.kind === pending.kind) {
                        // A concurrent edit must return to its original path even when it no longer matches the catalog.
                        publishRetiredPayload(recovery.payload, source, pending.kind, recovery.inspection.hash);
                        const rolledBack = { ...pending, status: recovery.ok ? 'restored' : 'attention',
                            restoredName: pending.name, restoredAt: new Date().toISOString() };
                        const restored = records.map(record => record.id === pending.id ? rolledBack : record);
                        writeRetiredArchiveIndex(index.paths, restored);
                        records = restored;
                        invalidateRetiredThumbnail(directories, item, pending.name);
                    }
                } catch { /* Preserve racing files and the indexed payload if rollback cannot finish. */ }
            }
            results.push({ id, ok: false, status: 'blocked', reason: error.publicMessage || 'The file could not be archived safely. Check old defaults and retry.' });
        }
    }
    return { results, archived: results.filter(result => result.ok), warnings: initial.warnings };
}

function getAvailableRetiredRestoreName(directory, originalName, reserved = new Set()) {
    const extension = path.extname(originalName);
    const stem = extension ? path.basename(originalName, extension) : originalName;
    for (let index = 0; index < 1000; index++) {
        const name = `${stem} (restored${index ? ` ${index + 1}` : ''})${extension}`;
        if (!isRetiredBasename(name) || reserved.has(name)) continue;
        const target = inspectRetiredPath(path.join(directory, name));
        if (!target.present) return name;
    }
    throw makeRetiredError('No safe restore name is available.', 409);
}

export function restoreRetiredContent(directories, id, catalog = RETIRED_CONTENT_ITEMS) {
    if (typeof id !== 'string' || !RETIRED_ID_PATTERN.test(id)) throw makeRetiredError('Choose a valid archived file.');
    const index = loadRetiredArchiveIndex(directories, catalog);
    let record = index.records.find(record => record.id === id);
    if (!record) throw makeRetiredError('The archived file was not found.', 404);
    if (index.attention.has(id) || record.status === 'pending') throw makeRetiredError('This archive needs attention before it can be restored.', 409);
    const payload = isRetiredRecordPayloadValid(directories, record);
    if (!payload.ok) throw makeRetiredError('The archived bytes could not be verified.', 409);
    const item = catalog.find(item => item.stableName === record.itemId);
    const directory = getRetiredTargetDirectory(directories, item.type);
    if (!directory || !hasSafePhysicalAncestors(index.paths.root, directory)) throw makeRetiredError('The restore directory is unsafe.', 409);
    fs.mkdirSync(directory, { recursive: true });
    const reserved = new Set(index.records.filter(other => other.id !== id && other.type === record.type && other.restoredName).map(other => other.restoredName));
    let name = record.restoredName || record.name;
    let destination = path.join(directory, name);
    const previous = inspectRetiredPath(destination);
    if (record.restoredName && previous.ok && previous.kind === record.kind && previous.hash === record.hash) {
        return { ok: true, status: 'restored', name, record: toPublicRetiredRecord(record) };
    }
    if (previous.present || reserved.has(name)) {
        name = getAvailableRetiredRestoreName(directory, record.name, reserved);
        destination = path.join(directory, name);
    }
    record = { ...record, status: 'restoring', restoredName: name, restoredAt: null };
    const staged = index.records.map(entry => entry.id === id ? record : entry);
    writeRetiredArchiveIndex(index.paths, staged);
    try {
        if (!hasSafePhysicalAncestors(index.paths.root, destination)) throw makeRetiredError('The restore destination is unsafe.', 409);
        const account = item.type === CONTENT_TYPES.CHARACTER && record.kind === 'file' ? roleplayAccountBase(directories) : null;
        if (account) {
            const bytes = readRetiredFile(payload.payload);
            if (getSha256(bytes) !== record.hash) throw makeRetiredError('The archived bytes could not be verified.', 409);
            publishProtectedCard(account, bytes, destination, 'character-restore',
                () => publishRetiredPayload(payload.payload, destination, record.kind, record.hash));
        } else {
            publishRetiredPayload(payload.payload, destination, record.kind, record.hash);
        }
    } catch (error) {
        throw makeRetiredError(error.publicMessage || 'The file could not be restored safely. Existing files were kept; retry to use another name.', 409);
    }
    record = { ...record, status: 'restored', restoredAt: new Date().toISOString() };
    writeRetiredArchiveIndex(index.paths, staged.map(entry => entry.id === id ? record : entry));
    invalidateRetiredThumbnail(directories, item, name);
    return { ok: true, status: 'restored', name, record: toPublicRetiredRecord(record) };
}

function getJsonFilesRecursive(directory) {
    const files = [];

    try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                files.push(...getJsonFilesRecursive(entryPath));
                continue;
            }

            if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
                files.push(entryPath);
            }
        }
    } catch (error) {
        console.warn(`Failed to scan quick replies directory ${directory}`, error);
    }

    return files;
}

/**
 * Reconciles managed bundled quick replies without touching user-modified files.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 */
export function reconcileManagedBundledQuickReplies(directories) {
    const quickRepliesDirectory = getUserTargetByType(CONTENT_TYPES.QUICK_REPLIES, directories);

    if (!quickRepliesDirectory || !fs.existsSync(quickRepliesDirectory)) {
        return;
    }

    for (const managedQuickReply of MANAGED_BUNDLED_QUICK_REPLIES) {
        const bundledPath = path.join(contentDirectory, managedQuickReply.bundledPath);
        let bundledContent;

        try {
            bundledContent = fs.readFileSync(bundledPath);
        } catch (error) {
            console.warn(`Failed to read bundled quick reply ${managedQuickReply.bundledPath}`, error);
            continue;
        }

        const currentHash = getSha256(bundledContent);
        const staleHashes = new Set(managedQuickReply.staleHashes);
        const currentMatches = [];
        const staleMatches = [];

        for (const filePath of getJsonFilesRecursive(quickRepliesDirectory)) {
            try {
                const fileHash = getSha256(fs.readFileSync(filePath));

                if (fileHash === currentHash) {
                    currentMatches.push(filePath);
                } else if (staleHashes.has(fileHash)) {
                    staleMatches.push(filePath);
                }
            } catch (error) {
                console.warn(`Failed to inspect quick reply file ${filePath}`, error);
            }
        }

        if (currentMatches.length === 0 && staleMatches.length === 0) {
            continue;
        }

        for (const filePath of staleMatches) {
            try {
                fs.rmSync(filePath, { force: true });
                console.info(`Stale bundled quick reply removed from ${filePath}`);
            } catch (error) {
                console.warn(`Failed to remove stale bundled quick reply ${filePath}`, error);
            }
        }

        const bundledName = path.parse(managedQuickReply.bundledPath).name;
        const canonicalPath = path.join(quickRepliesDirectory, `${sanitize(bundledName)}.json`);

        if (currentMatches.length >= 2) {
            const keepPath = currentMatches.includes(canonicalPath) ? canonicalPath : currentMatches[0];

            for (const filePath of currentMatches) {
                if (filePath === keepPath) {
                    continue;
                }

                try {
                    fs.rmSync(filePath, { force: true });
                    console.info(`Duplicate bundled quick reply removed from ${filePath}`);
                } catch (error) {
                    console.warn(`Failed to remove duplicate bundled quick reply ${filePath}`, error);
                }
            }
        }

        if (currentMatches.length === 0 && staleMatches.length > 0) {
            try {
                fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
                writeFileAtomicSync(canonicalPath, bundledContent);
                setPermissionsSync(canonicalPath);
                console.info(`Bundled quick reply restored to ${canonicalPath}`);
            } catch (error) {
                console.warn(`Failed to restore bundled quick reply ${canonicalPath}`, error);
            }
        }
    }
}

/**
 * Seeds content for a user.
 * @param {ContentItem[]} contentIndex Content index
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @returns {Promise<boolean>} Whether any content was added
 */
async function seedContentForUser(contentIndex, directories, forceCategories) {
    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }

    const contentLogPath = path.join(directories.root, 'content.log');
    const contentLog = getContentLog(contentLogPath);
    writeFileAtomicSync(contentLogPath, contentLog.join('\n'));
    reconcileManagedBundledQuickReplies(directories);
    const filteredContentIndex = contentIndex.filter(contentItem => {
        if (!isPresetContentType(contentItem.type)) {
            return true;
        }

        return !isDefaultPresetDeleted(directories, contentItem);
    });

    return seedContent(filteredContentIndex, contentLogPath, (type) => getUserTargetByType(type, directories), forceCategories, directories);
}

/**
 * Seeds global content that is not user-specific, such as error pages.
 * @param {ContentItem[]} contentIndex Content index
 * @returns {Promise<boolean>} Whether any content was added
 */
async function seedGlobalContent(contentIndex) {
    const contentLogPath = path.join(globalThis.DATA_ROOT, 'content.log');
    return seedContent(contentIndex, contentLogPath, getGlobalTargetByType);
}

/**
 * Checks for new content and seeds it for all users.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @returns {Promise<void>}
 */
export async function checkForNewContent(directoriesList, forceCategories = []) {
    try {
        const contentCheckSkip = getConfigValue('skipContentCheck', false, 'boolean');
        if (contentCheckSkip && forceCategories?.length === 0) {
            return;
        }

        const userContentIndex = getContentIndex(CONTENT_SCOPE.USER);
        const globalContentIndex = getContentIndex(CONTENT_SCOPE.GLOBAL);
        let anyContentAdded = false;

        const globalSeedResult = await seedGlobalContent(globalContentIndex);
        if (globalSeedResult) {
            anyContentAdded = true;
        }

        for (const directories of directoriesList) {
            const userSeedResult = await seedContentForUser(userContentIndex, directories, forceCategories);

            if (userSeedResult) {
                anyContentAdded = true;
            }
        }

        if (anyContentAdded && !contentCheckSkip && forceCategories?.length === 0) {
            console.info();
            console.info(`${color.blue('If you don\'t want to receive content updates in the future, set')} ${color.yellow('skipContentCheck')} ${color.blue('to true in the config.yaml file.')}`);
            console.info();
        }
    } catch (err) {
        console.error('Content check failed', err);
    }
}

/** Freeze the same user-scoped defaults for a reset, without changing global content or the user's current files. */
export function captureUserResetContent(directories) {
    const files = new Map();
    const folders = new Set(Object.values(USER_DIRECTORY_TEMPLATE).filter(Boolean));
    const log = [];
    const add = (source, relative) => {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error('A bundled reset source is a symbolic link.');
        if (stat.isDirectory()) {
            folders.add(relative);
            for (const name of fs.readdirSync(source).sort()) add(path.join(source, name), `${relative}/${name}`);
        } else {
            if (files.has(relative)) return;
            const file = readRoleplayFile(source, 32 * 1024 * 1024);
            if (!file) throw new Error('A bundled reset source is missing.');
            files.set(relative, { relative, data: file.bytes.toString('base64') });
        }
    };
    if (!getConfigValue('skipContentCheck', false, 'boolean')) {
        for (const item of getContentIndex(CONTENT_SCOPE.USER)) {
            const target = getUserTargetByType(item.type, directories);
            if (!target || !item.folder) throw new Error('A bundled reset target is unavailable.');
            const relative = path.relative(directories.root, path.join(target, path.basename(item.filename)));
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A bundled reset target is outside the account.');
            add(path.join(item.folder, item.filename), relative.split(path.sep).join('/'));
            log.push(item.filename);
        }
        files.set('content.log', { relative: 'content.log', data: Buffer.from(log.join('\n')).toString('base64') });
    }
    return { version: 1, directories: [...folders].map(name => name.split(path.sep).join('/')), files: [...files.values()] };
}

/**
 * Gets combined content index from the content and scaffold directories.
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {ContentItem[]} Array of content index
 */
function getContentIndex(scope = CONTENT_SCOPE.USER) {
    const result = [];

    if (fs.existsSync(scaffoldIndexPath)) {
        const scaffoldIndexText = fs.readFileSync(scaffoldIndexPath, 'utf8');
        const scaffoldIndex = JSON.parse(scaffoldIndexText);
        if (Array.isArray(scaffoldIndex)) {
            scaffoldIndex.forEach((item) => {
                item.folder = scaffoldDirectory;
                item.scope = getScopeByType(item.type);
            });
            result.push(...scaffoldIndex);
        }
    }

    if (fs.existsSync(contentIndexPath)) {
        const contentIndexText = fs.readFileSync(contentIndexPath, 'utf8');
        const contentIndex = JSON.parse(contentIndexText);
        if (Array.isArray(contentIndex)) {
            contentIndex.forEach((item) => {
                item.folder = contentDirectory;
                item.scope = getScopeByType(item.type);
            });
            result.push(...contentIndex);
        }
    }

    return result.filter((item) => item.scope === scope);
}

/**
 * Gets content by type and format.
 * @param {string} type Type of content
 * @param {'json'|'string'|'raw'} format Format of content
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {string[]|Buffer[]} Array of content
 */
export function getContentOfType(type, format, scope = CONTENT_SCOPE.USER) {
    const contentIndex = getContentIndex(scope);
    const indexItems = contentIndex.filter((item) => item.type === type && item.folder);
    const files = [];
    for (const item of indexItems) {
        if (!item.folder) {
            continue;
        }
        try {
            const filePath = path.join(item.folder, item.filename);
            if (item.type === CONTENT_TYPES.CHARACTER && path.extname(filePath).toLowerCase() === '.png') {
                recoverFileWriteSync(filePath);
            }
            const fileContent = fs.readFileSync(filePath);
            switch (format) {
                case 'json':
                    files.push(JSON.parse(fileContent.toString()));
                    break;
                case 'string':
                    files.push(fileContent.toString());
                    break;
                case 'raw':
                    files.push(fileContent);
                    break;
            }
        } catch {
            // Ignore errors
        }
    }
    return files;
}

/**
 * Gets the target directory for the specified asset type.
 * @param {ContentType} type Asset type
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string | null} Target directory
 */
export function getUserTargetByType(type, directories) {
    switch (type) {
        case CONTENT_TYPES.SETTINGS:
            return directories.root;
        case CONTENT_TYPES.CHARACTER:
            return directories.characters;
        case CONTENT_TYPES.SPRITES:
            return directories.characters;
        case CONTENT_TYPES.BACKGROUND:
            return directories.backgrounds;
        case CONTENT_TYPES.WORLD:
            return directories.worlds;
        case CONTENT_TYPES.AVATAR:
            return directories.avatars;
        case CONTENT_TYPES.THEME:
            return directories.themes;
        case CONTENT_TYPES.WORKFLOW:
            return directories.comfyWorkflows;
        case CONTENT_TYPES.KOBOLD_PRESET:
            return directories.koboldAI_Settings;
        case CONTENT_TYPES.OPENAI_PRESET:
            return directories.openAI_Settings;
        case CONTENT_TYPES.NOVEL_PRESET:
            return directories.novelAI_Settings;
        case CONTENT_TYPES.TEXTGEN_PRESET:
            return directories.textGen_Settings;
        case CONTENT_TYPES.INSTRUCT:
            return directories.instruct;
        case CONTENT_TYPES.CONTEXT:
            return directories.context;
        case CONTENT_TYPES.MOVING_UI:
            return directories.movingUI;
        case CONTENT_TYPES.QUICK_REPLIES:
            return directories.quickreplies;
        case CONTENT_TYPES.SYSPROMPT:
            return directories.sysprompt;
        case CONTENT_TYPES.REASONING:
            return directories.reasoning;
        default:
            return null;
    }
}

/**
 * Gets the target directory for global content types.
 * @param {CONTENT_TYPES} type Content type
 * @returns {string | null} Target directory
 */
export function getGlobalTargetByType(type) {
    switch (type) {
        case CONTENT_TYPES.ERROR_PAGE:
            return path.join(globalThis.DATA_ROOT, '_errors');
        case CONTENT_TYPES.STYLESHEET:
            return path.join(globalThis.DATA_ROOT, '_css');
        default:
            return null;
    }
}

/**
 * Gets the content log from the content log file.
 * @param {string} contentLogPath Path to the content log file
 * @returns {string[]} Array of content log lines
 */
function getContentLog(contentLogPath) {
    if (!fs.existsSync(contentLogPath)) {
        return [];
    }

    const contentLogText = fs.readFileSync(contentLogPath, 'utf8');
    return contentLogText.split('\n');
}

async function downloadChubLorebook(id) {
    const [lorebooks, creatorName, projectName] = id.split('/');
    const result = await fetch(`https://api.chub.ai/api/${lorebooks}/${creatorName}/${projectName}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.statusText, text);
        throw new Error('Failed to fetch lorebook metadata');
    }

    /** @type {any} */
    const metadata = await result.json();
    const projectId = metadata.node?.id;

    if (!projectId) {
        throw new Error('Project ID not found in lorebook metadata');
    }

    const downloadUrl = `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fsillytavern_raw.json/raw`;
    const downloadResult = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!downloadResult.ok) {
        const text = await downloadResult.text();
        console.error('Chub returned error', downloadResult.statusText, text);
        throw new Error('Failed to download lorebook');
    }

    const name = projectName;
    const buffer = Buffer.from(await downloadResult.arrayBuffer());
    const fileName = `${sanitize(name)}.json`;
    const fileType = downloadResult.headers.get('content-type');

    return { buffer, fileName, fileType };
}

/**
 * @param {string} url URL of a Chub character card PNG
 * @param {string} name Base name for the returned file
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string} | null>}
 */
async function tryDownloadChubCharacterCard(url, name) {
    try {
        const downloadResult = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
        });

        if (downloadResult.ok) {
            const buffer = Buffer.from(await downloadResult.arrayBuffer());

            if (isPngBuffer(buffer)) {
                const fileName = `${sanitize(name)}.png`;
                const fileType = 'image/png';

                return { buffer, fileName, fileType };
            }

            console.error('Chub returned non-PNG character card', downloadResult.headers.get('content-type'), url);
        } else {
            const text = await downloadResult.text();
            console.error('Chub returned error', downloadResult.status, downloadResult.statusText, text, url);
        }
    } catch (error) {
        console.error('Failed to download Chub character card', url, getErrorMessage(error));
    }

    return null;
}

async function downloadChubCharacter(id) {
    const [creatorName, projectName] = id.split('/');

    const directCardUrl = `https://avatars.charhub.io/avatars/${[creatorName, projectName].map(encodeURIComponent).join('/')}/chara_card_v2.png`;
    const directCard = await tryDownloadChubCharacterCard(directCardUrl, projectName);
    if (directCard) {
        return directCard;
    }

    const result = await fetch(`https://api.chub.ai/api/characters/${creatorName}/${projectName}?full=true`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.status, result.statusText, text);
        throw new Error(`Failed to fetch Chub character metadata: ${result.status} ${result.statusText}`.trim());
    }

    /** @type {any} */
    const metadata = await result.json();
    const node = metadata.node;

    if (!node || typeof node !== 'object') {
        throw new Error('Chub returned invalid character metadata');
    }

    const imageUrl = node?.max_res_url;

    if (imageUrl && imageUrl !== directCardUrl) {
        const card = await tryDownloadChubCharacterCard(imageUrl, node?.name || projectName);
        if (card) {
            return card;
        }
    }

    const { definition, topics } = node;

    if (!definition || typeof definition !== 'object') {
        throw new Error('Chub returned character metadata without definition');
    }

    // Chub does not always include definition.name; fall back to the project/card name.
    const characterName = definition.name || node?.name || projectName;

    /** @type {TavernCardV2} */
    const characterCard = {
        data: {
            name: characterName,
            description: definition.personality,
            personality: definition.tavern_personality,
            scenario: definition.scenario,
            first_mes: definition.first_message,
            mes_example: definition.example_dialogs,
            creator_notes: definition.description,
            system_prompt: definition.system_prompt,
            post_history_instructions: definition.post_history_instructions,
            alternate_greetings: definition.alternate_greetings,
            tags: topics,
            creator: creatorName,
            character_version: '',
            character_book: definition.embedded_lorebook,
            extensions: definition.extensions,
        },
        spec: 'chara_card_v2',
        spec_version: '2.0',
    };

    const defaultAvatarPath = path.join(serverDirectory, DEFAULT_AVATAR_PATH);
    const defaultAvatarBuffer = fs.readFileSync(defaultAvatarPath);

    let imageBuffer = defaultAvatarBuffer;

    const avatarUrl = node?.avatar_url;

    if (avatarUrl) {
        const downloadResult = await fetch(avatarUrl, {
            method: 'GET',
            headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
        });
        if (downloadResult.ok) {
            const avatarBuffer = Buffer.from(await downloadResult.arrayBuffer());
            if (isPngBuffer(avatarBuffer)) {
                imageBuffer = avatarBuffer;
            } else {
                console.warn('Chub avatar is not a PNG, using default avatar for fallback card', downloadResult.headers.get('content-type'));
            }
        }
    }

    const buffer = write(imageBuffer, JSON.stringify(characterCard));
    const fileName = `${sanitize(characterCard.data.name)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

// Neconyan divergence: support Botbooru's SillyTavern import URLs as external character imports.

/**
 * @typedef {Object} BotbooruParsedUrl
 * @property {string} [downloadPath] Path to the PNG download endpoint
 * @property {string} [slug] Botbooru short-link slug
 * @property {string} fallbackName Fallback file name
 * @property {string} [search] Query string to preserve for download URLs
 */

/**
 * @param {string} url Botbooru URL
 * @returns {BotbooruParsedUrl | null} Parsed Botbooru import target
 */
function parseBotbooruUrl(url) {
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/').filter(Boolean);
        const idPattern = /^\d+(?:-\d+)?$/;

        if (parts.length === 3 && parts[0] === 'download' && parts[1] === 'png' && idPattern.test(parts[2])) {
            return {
                downloadPath: `/download/png/${parts[2]}`,
                fallbackName: `botbooru-${parts[2]}`,
                search: urlObj.search,
            };
        }

        if (parts.length === 2 && parts[0] === 'character' && /^\d+$/.test(parts[1])) {
            return {
                downloadPath: `/download/png/${parts[1]}`,
                fallbackName: `botbooru-${parts[1]}`,
            };
        }

        if (parts.length === 3 && parts[0] === 'mini-gallery' && /^\d+$/.test(parts[1]) && parts[2] === 'download.png') {
            return {
                downloadPath: `/mini-gallery/${parts[1]}/download.png`,
                fallbackName: `botbooru-${parts[1]}`,
                search: urlObj.search,
            };
        }

        if (parts.length === 2 && parts[0] === 'q' && parts[1]) {
            return {
                slug: decodeURIComponent(parts[1]),
                fallbackName: `botbooru-${parts[1]}`,
            };
        }
    } catch (error) {
        console.error('Error parsing Botbooru URL:', error);
    }

    return null;
}

/**
 * @param {string} slug Botbooru short-link slug
 * @returns {Promise<BotbooruParsedUrl>} Resolved Botbooru import target
 */
async function resolveBotbooruShortLink(slug) {
    const result = await fetch(`https://botbooru.com/api/q/${encodeURIComponent(slug)}/resolve`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Botbooru returned error', result.status, result.statusText, text);
        throw new Error(`Failed to resolve Botbooru short link: ${result.status} ${result.statusText}`.trim());
    }

    /** @type {any} */
    const resolved = await result.json();

    if (resolved.kind === 'lorebook') {
        throw new Error('Botbooru lorebook imports are not supported');
    }

    const postId = resolved.post_id || resolved.post?.id;

    if (!postId) {
        throw new Error('Botbooru short link did not resolve to a character');
    }

    return {
        downloadPath: `/download/png/${encodeURIComponent(String(postId))}`,
        fallbackName: resolved.character_name || resolved.name || `botbooru-${postId}`,
    };
}

/**
 * @param {BotbooruParsedUrl} parsed Parsed Botbooru import target
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadBotbooruCharacter(parsed) {
    const target = parsed.slug ? await resolveBotbooruShortLink(parsed.slug) : parsed;

    if (!target.downloadPath) {
        throw new Error('Botbooru URL did not include a character download path');
    }

    const downloadUrl = new URL(target.downloadPath, 'https://botbooru.com');
    if (target.search) {
        downloadUrl.search = target.search;
    }

    const result = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Botbooru returned error', result.status, result.statusText, text, downloadUrl.toString());
        throw new Error(`Failed to download Botbooru character: ${result.status} ${result.statusText}`.trim());
    }

    const buffer = Buffer.from(await result.arrayBuffer());

    if (!isPngBuffer(buffer)) {
        console.error('Botbooru returned non-PNG character card', result.headers.get('content-type'), downloadUrl.toString());
        throw new Error('Botbooru returned a non-PNG character card');
    }

    const fileName = getPngFileName(getFileNameFromContentDisposition(result.headers.get('content-disposition')), target.fallbackName);
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/**
 * Downloads a character card from the Pygsite.
 * @param {string} id UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadPygmalionCharacter(id) {
    const result = await fetch(`https://server.pygmalion.chat/api/export/character/${id}/v2`);

    if (!result.ok) {
        const text = await result.text();
        console.error('Pygsite returned error', result.status, text);
        throw new Error('Failed to download character');
    }

    /** @type {any} */
    const jsonData = await result.json();
    const characterData = jsonData?.character;

    if (!characterData || typeof characterData !== 'object') {
        console.error('Pygsite returned invalid character data', jsonData);
        throw new Error('Failed to download character');
    }

    try {
        const avatarUrl = characterData?.data?.avatar;

        if (!avatarUrl) {
            console.error('Pygsite character does not have an avatar', characterData);
            throw new Error('Failed to download avatar');
        }

        const avatarResult = await fetch(avatarUrl);
        const avatarBuffer = Buffer.from(await avatarResult.arrayBuffer());

        const cardBuffer = write(avatarBuffer, JSON.stringify(characterData));

        return {
            buffer: cardBuffer,
            fileName: `${sanitize(id)}.png`,
            fileType: 'image/png',
        };
    } catch (e) {
        console.error('Failed to download avatar, using JSON instead', e);
        return {
            buffer: Buffer.from(JSON.stringify(jsonData)),
            fileName: `${sanitize(id)}.json`,
            fileType: 'application/json',
        };
    }
}

/**
 *
 * @param {String} str
 * @returns { { id: string, type: "character" | "lorebook" } | null }
 */
function parseChubUrl(str) {
    const splitStr = str.split('/');
    let domainIndex = -1;

    splitStr.forEach((part, index) => {
        if (part === 'www.chub.ai' || part === 'chub.ai' || part === 'www.characterhub.org' || part === 'characterhub.org') {
            domainIndex = index;
        }
    });

    const lastTwo = domainIndex !== -1 ? splitStr.slice(domainIndex + 1) : splitStr;
    const length = lastTwo.length;

    if (length < 2) {
        return null;
    }

    const firstPart = lastTwo[0].toLowerCase();

    if (firstPart === 'characters' || firstPart === 'lorebooks') {
        const type = firstPart === 'characters' ? 'character' : 'lorebook';
        const id = type === 'character' ? lastTwo.slice(1).join('/') : lastTwo.join('/');
        return {
            id: id,
            type: type,
        };
    } else if (length === 2) {
        return {
            id: lastTwo.join('/'),
            type: 'character',
        };
    }

    return null;
}

// Warning: Some characters might not exist in JannyAI.me
async function downloadJannyCharacter(uuid) {
    // This endpoint is being guarded behind Bot Fight Mode of Cloudflare
    // So hosted ST on Azure/AWS/GCP/Collab might get blocked by IP
    // Should work normally on self-host PC/Android
    const result = await fetch('https://api.jannyai.com/api/v1/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'characterId': uuid,
        }),
    });

    if (result.ok) {
        /** @type {any} */
        const downloadResult = await result.json();
        if (downloadResult.status === 'ok') {
            const imageResult = await fetch(downloadResult.downloadUrl);
            const buffer = Buffer.from(await imageResult.arrayBuffer());
            const fileName = `${sanitize(uuid)}.png`;
            const fileType = imageResult.headers.get('content-type');

            return { buffer, fileName, fileType };
        } else {
            console.error('Janny failed to download', downloadResult);
        }
    } else {
        console.error('Janny returned error', result.statusText, await result.text());
    }

    throw new Error('Failed to download character');
}

//Download Character Cards from AICharactersCards.com (AICC) API.
async function downloadAICCCharacter(id) {
    const apiURL = `https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`;
    try {
        const response = await fetch(apiURL);
        if (!response.ok) {
            throw new Error(`Failed to download character: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || 'image/png'; // Default to 'image/png' if header is missing
        const buffer = Buffer.from(await response.arrayBuffer());
        const fileName = `${sanitize(id)}.png`; // Assuming PNG, but adjust based on actual content or headers

        return {
            buffer: buffer,
            fileName: fileName,
            fileType: contentType,
        };
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
}

/**
 * Parses an aicharactercards URL to extract the path.
 * @param {string} url URL to parse
 * @returns {string | null} AICC path
 */
function parseAICC(url) {
    try {
        if (isValidUrl(url)) {
            const urlObj = new URL(url);
            // Split the path and remove empty strings caused by trailing slashes
            const parts = urlObj.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                // Always grab the last two segments (author/character)
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        } else {
            // Fallback for relative paths or raw "author/character" strings
            const parts = url.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        }
    } catch (e) {
        console.error('Error parsing AICC URL:', e);
    }
    return null;
}

/**
 * Download character card from generic url.
 * @param {String} url
 */
async function downloadGenericPng(url) {
    try {
        const result = await fetch(url);

        if (result.ok) {
            const buffer = Buffer.from(await result.arrayBuffer());
            let fileName = sanitize(result.url.split('?')[0].split('/').reverse()[0]);
            const contentType = result.headers.get('content-type') || 'image/png'; //yoink it from AICC function lol

            // The `importCharacter()` function detects the MIME (content-type) of the file
            // using its file extension. The problem is that not all third-party APIs serve
            // their cards with a `.png` extension. To support more third-party sites,
            // dynamically append the `.png` extension to the filename if it doesn't
            // already have a file extension.
            if (contentType === 'image/png') {
                const ext = fileName.match(/\.(\w+)$/); // Same regex used by `importCharacter()`
                if (!ext) {
                    fileName += '.png';
                }
            }

            return {
                buffer: buffer,
                fileName: fileName,
                fileType: contentType,
            };
        }
    } catch (error) {
        console.error('Error downloading file: ', error);
        throw error;
    }
    return null;
}

/**
 * Parse Risu Realm URL to extract the UUID.
 * @param {string} url Risu Realm URL
 * @returns {string | null} UUID of the character
 */
function parseRisuUrl(url) {
    // Example: https://realm.risuai.net/character/7adb0ed8d81855c820b3506980fb40f054ceef010ff0c4bab73730c0ebe92279
    // or https://realm.risuai.net/character/7adb0ed8-d818-55c8-20b3-506980fb40f0
    const pattern = /^https?:\/\/realm\.risuai\.net\/character\/([a-f0-9-]+)\/?$/i;
    const match = url.match(pattern);
    return match ? match[1] : null;
}

/**
 * Download RisuAI character card
 * @param {string} uuid UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadRisuCharacter(uuid) {
    const result = await fetch(`https://realm.risuai.net/api/v1/download/png-v3/${uuid}?non_commercial=true`);

    if (!result.ok) {
        const text = await result.text();
        console.error('RisuAI returned error', result.statusText, text);
        throw new Error('Failed to download character');
    }

    const buffer = Buffer.from(await result.arrayBuffer());
    const fileName = `${sanitize(uuid)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/** * Check if the given string is a valid Perchance UUID.
 * @param {string} uuid UUID string to check
 * @returns {boolean} True if the UUID is valid, false otherwise
 */
function isPerchanceUUID(uuid) {
    if (!uuid) {
        return false;
    }

    //example: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    //charactername~uuid.gz

    const uuidRegex = /^\w+~[a-f0-9]{32}\.gz$/;
    return uuidRegex.test(uuid);
}

/**
 * Parse Perchance URL to extract the character slug.
 * @param {string} url Perchance character URL
 * @returns {string} Slug of the character
 */
function parsePerchanceSlug(url) {
    // Example: https://perchance.org/ai-character-chat?data=Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    // or: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    return url?.split('~')[1] || '';
}

/**
 * Download Perchance character card
 * @param {string} slug Slug of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string} | null>}
 */
async function downloadPerchanceCharacter(slug) {
    // example of slug
    // 6903e991c90fd1dba52c036d917e99c6.gz
    const perchanceBaseURL = 'https://user.uploads.dev/file';

    try {
        const charURL = `${perchanceBaseURL}/${slug}`;
        console.log('Downloading Perchance character from URL:', charURL);
        const result = await fetch(charURL, {
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        });

        //decompress gzipped content
        if (result.ok) {
            const perchanceChar = await extractPerchanceCharacterFromGz(result);

            const avatarUrl = perchanceChar.avatar?.url;

            //check if avatarURL is a base64 of any image type
            const isAvatarBase64 = avatarUrl && avatarUrl.startsWith('data:image/');

            const charData = {
                name: perchanceChar.name || 'Unnamed Perchance Character',
                first_mes: '',
                tags: [],
                description: perchanceChar.roleInstruction || '',
                creator: perchanceChar.metaTitle || '',
                creator_notes: perchanceChar.metaDescription || '',
                alternate_greetings: [],
                character_version: '',
                mes_example: '',
                post_history_instructions: '',
                system_prompt: '',
                scenario: '',
                personality: perchanceChar.reminderMessage || '',
                extensions: {
                    perchance_data: {
                        slug: slug,
                        char_url: charURL,
                        uuid: perchanceChar.uuid || null,
                        avatar_url: isAvatarBase64 ? null : (avatarUrl || null),
                        folder_path: perchanceChar.folderPath || null,
                        folder_name: perchanceChar.folderName || null,
                        custom_data: perchanceChar.customData || {},
                    },
                },
            };

            const avatarBuffer = await fetchPerchanceAvatar(avatarUrl, isAvatarBase64);

            // Character card
            const buffer = write(avatarBuffer, JSON.stringify({
                'spec': 'chara_card_v2',
                'spec_version': '2.0',
                'data': charData,
            }));

            const fileName = `${charData.name}.png`;
            const fileType = 'image/png';

            return { buffer, fileName, fileType };
        }
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
    return null;
}

/**
 * Extracts Perchance character data from a gzipped response.
 * @param {import('node-fetch').Response} result Fetch response containing gzipped character data
 * @returns {Promise<Object>} Parsed Perchance character data
 * @throws {Error} If the character data is invalid or missing required fields
 */
async function extractPerchanceCharacterFromGz(result) {
    const compressedBuffer = await result.arrayBuffer();
    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);

    // inside the gz file, there is a file of the same name without extensions, but it is a json file

    if (!decompressedBuffer || decompressedBuffer.length === 0) {
        console.error('Perchance character data is empty or invalid');
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    // Parse the decompressed JSON
    const perchanceCharData = JSON.parse(decompressedBuffer.toString());

    if (!perchanceCharData?.addCharacter) {
        console.error('Perchance character data is missing addCharacter field', perchanceCharData);
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    return perchanceCharData.addCharacter;
}

/** * Fetches the avatar from Perchance URL or uses a default avatar if not available.
 * @param {string} avatarUrl URL of the avatar
 * @param {boolean} isAvatarBase64 Flag indicating if the avatar URL is a base64 string
 * @returns {Promise<Buffer>} Buffer containing the avatar image
 */
async function fetchPerchanceAvatar(avatarUrl, isAvatarBase64) {
    const defaultAvatarPath = path.join(serverDirectory, DEFAULT_AVATAR_PATH);
    const defaultAvatarBuffer = fs.readFileSync(defaultAvatarPath);

    if (!avatarUrl || (!isAvatarBase64 && !isValidUrl(avatarUrl))) {
        console.warn('Perchance character does not have an avatar, it is not base64, or it is an invalid url, using default avatar');
        return defaultAvatarBuffer;
    }

    if (isAvatarBase64) {
        // check if avatarUrl is a png
        const isPng = avatarUrl.startsWith('data:image/png;base64,');
        const base64 = avatarUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');

        if (isPng) {
            return buffer;
        } else {
            // use jimp to convert the base64 to PNG if it's not PNG
            console.debug('Perchance character avatar is not PNG, converting to PNG...');
            return await Jimp.read(buffer).then(image => image.getBuffer(JimpMime.png));
        }
    }

    // Fetch avatar from URL
    console.log('Fetching Perchance avatar from URL:', avatarUrl);
    const avatarResponse = await fetch(avatarUrl, { headers: { 'User-Agent': USER_AGENT } });

    if (avatarResponse.ok) {
        const avatarContentType = avatarResponse.headers.get('content-type');
        const avatarBuffer = Buffer.from(await avatarResponse.arrayBuffer());

        if (avatarContentType === 'image/png') {
            return avatarBuffer;
        } else {
            console.debug(`Perchance character avatar is not PNG: ${avatarContentType}. Converting to PNG...`);

            // use jimp to convert the image to PNG if it's not PNG
            return await Jimp.read(avatarBuffer)
                .then(image => image.getBuffer(JimpMime.png));
        }
    }

    console.error('Failed to fetch Perchance avatar:', avatarResponse.statusText);
    const isPerchanceOrgFileUploader = avatarUrl.includes('https://user-uploads.perchance.org');

    if (isPerchanceOrgFileUploader) {
        console.warn('Files from https://user-uploads.perchance.org are sometimes blocked by CloudFlare, try reuploading it in https://perchance.org/upload to get the new link from https://user-uploads.dev instead.');
    }

    console.warn('You can also download the avatar manually and assign it to the character:', avatarUrl);
    return defaultAvatarBuffer;
}

/**
* @param {String} url
* @returns {String | null } UUID of the character
*/
function getUuidFromUrl(url) {
    // Extract UUID from URL
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;
    const matches = url.match(uuidRegex);

    // Check if UUID is found
    const uuid = matches ? matches[0] : null;
    return uuid;
}

/**
 * Filter to get the domain host of a url instead of a blanket string search.
 * @param {String} url URL to strip
 * @returns {String} Domain name
 */
export function getHostFromUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    } catch {
        return '';
    }
}

/**
 * Checks if host is part of generic download source whitelist.
 * @param {String} host Host to check
 * @returns {boolean} If the host is on the whitelist.
 */
export function isHostWhitelisted(host) {
    return WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES.includes(host);
}

export const router = express.Router();

function getRetiredAuthenticatedUser(request, response) {
    if (!request.user?.profile?.handle || !request.user.directories) {
        response.sendStatus(401);
        return null;
    }
    return request.user;
}

function checkRetiredRequestHandle(request, response) {
    const user = getRetiredAuthenticatedUser(request, response);
    if (!user) return null;
    if (typeof request.body?.handle !== 'string' || request.body.handle !== user.profile.handle) {
        response.status(409).json({ error: 'This retirement view belongs to another account.' });
        return null;
    }
    return user;
}

router.post('/retired/list', (request, response) => {
    const user = getRetiredAuthenticatedUser(request, response);
    if (!user) return;
    try {
        const inventory = inspectRetiredContent(user.directories);
        return response.json({
            version: RETIRED_ARCHIVE_VERSION,
            handle: user.profile.handle,
            candidates: inventory.candidates,
            archived: inventory.archived,
            warnings: inventory.warnings,
        });
    } catch (error) {
        console.error('Failed to inspect retired content', error);
        return response.status(error?.status || 500).json({ error: error?.publicMessage || 'Retired content could not be inspected.' });
    }
});

router.post('/retired/archive', (request, response) => {
    const user = checkRetiredRequestHandle(request, response);
    if (!user) return;
    try {
        const report = archiveRetiredContent(user.directories, request.body?.ids, RETIRED_CONTENT_ITEMS);
        return response.json(report);
    } catch (error) {
        console.error('Failed to archive retired content', error);
        return response.status(error?.status || 500).json({ error: error?.publicMessage || 'Retired content could not be archived.' });
    }
});

router.post('/retired/restore', (request, response) => {
    const user = checkRetiredRequestHandle(request, response);
    if (!user) return;
    try {
        const report = restoreRetiredContent(user.directories, request.body?.id, RETIRED_CONTENT_ITEMS);
        return response.json(report);
    } catch (error) {
        console.error('Failed to restore retired content', error);
        return response.status(error?.status || 500).json({ error: error?.publicMessage || 'Retired content could not be restored.' });
    }
});

router.post('/importURL', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const url = request.body.url;
        const host = getHostFromUrl(url);
        let result;
        let type;

        const isChub = host.includes('chub.ai') || host.includes('characterhub.org');
        const isBotbooru = host === 'botbooru.com' || host === 'www.botbooru.com';
        const isJannnyContent = host.includes('janitorai');
        const isPygmalionContent = host.includes('pygmalion.chat');
        const isAICharacterCardsContent = host.includes('aicharactercards.com');
        const isRisu = host.includes('realm.risuai.net');
        const isPerchance = host.includes('perchance.org');
        const isGeneric = isHostWhitelisted(host);

        if (isPygmalionContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannnyContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadJannyCharacter(uuid);
        } else if (isAICharacterCardsContent) {
            const AICCParsed = parseAICC(url);
            if (!AICCParsed) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadAICCCharacter(AICCParsed);
        } else if (isBotbooru) {
            const botbooruParsed = parseBotbooruUrl(url);
            if (!botbooruParsed) {
                return response.sendStatus(404);
            }

            type = 'character';
            console.info('Downloading Botbooru character:', botbooruParsed.slug || botbooruParsed.downloadPath);
            result = await downloadBotbooruCharacter(botbooruParsed);
        } else if (isChub) {
            const chubParsed = parseChubUrl(url);
            type = chubParsed?.type;

            if (chubParsed?.type === 'character') {
                console.info('Downloading chub character:', chubParsed.id);
                result = await downloadChubCharacter(chubParsed.id);
            } else if (chubParsed?.type === 'lorebook') {
                console.info('Downloading chub lorebook:', chubParsed.id);
                result = await downloadChubLorebook(chubParsed.id);
            } else {
                return response.sendStatus(404);
            }
        } else if (isRisu) {
            const uuid = parseRisuUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadRisuCharacter(uuid);
        } else if (isPerchance) {
            const perchanceSlug = parsePerchanceSlug(url);
            if (!perchanceSlug) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadPerchanceCharacter(perchanceSlug);
        } else if (isGeneric) {
            console.info('Downloading from generic url:', url);
            type = 'character';
            result = await downloadGenericPng(url);
        } else {
            console.error(`Received an import for "${getHostFromUrl(url)}", but site is not whitelisted. This domain must be added to the config key "whitelistImportDomains" to allow import from this source.`);
            return response.sendStatus(404);
        }

        if (!result) {
            return response.sendStatus(404);
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${encodeURI(result.fileName)}"`);
        response.set('X-Custom-Content-Type', type);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.status(500).type('text/plain').send(getErrorMessage(error));
    }
});

router.post('/importUUID', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const uuid = request.body.url;
        let result;

        const isJannny = uuid.includes('_character');
        const isPygmalion = (!isJannny && uuid.length == 36);
        const isAICC = uuid.startsWith('AICC/');
        const isPerchance = isPerchanceUUID(uuid);
        const uuidType = uuid.includes('lorebook') ? 'lorebook' : 'character';

        if (isPygmalion) {
            console.info('Downloading Pygmalion character:', uuid);
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannny) {
            console.info('Downloading Janitor character:', uuid.split('_')[0]);
            result = await downloadJannyCharacter(uuid.split('_')[0]);
        } else if (isAICC) {
            const [, author, card] = uuid.split('/');
            console.info('Downloading AICC character:', `${author}/${card}`);
            result = await downloadAICCCharacter(`${author}/${card}`);
        } else if (isPerchance) {
            console.info('Downloading Perchance character:', uuid);
            const parsedUuid = parsePerchanceSlug(uuid);
            result = await downloadPerchanceCharacter(parsedUuid);
        } else {
            if (uuidType === 'character') {
                console.info('Downloading chub character:', uuid);
                result = await downloadChubCharacter(uuid);
            } else if (uuidType === 'lorebook') {
                console.info('Downloading chub lorebook:', uuid);
                result = await downloadChubLorebook(uuid);
            } else {
                return response.sendStatus(404);
            }
        }

        if (!result) {
            throw new Error('Failed to download content');
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${result.fileName}"`);
        response.set('X-Custom-Content-Type', uuidType);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.sendStatus(500);
    }
});
