import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';

import { authoringRoute, deleteAuthoringFileLocked, readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { assertNativeMediaTargetIdle } from '../generation/media-jobs.js';
import {
    clearDefaultPresetDeletion,
    findDefaultPreset,
    getDefaultPresetFile,
    getDefaultPresets,
    recordDefaultPresetDeletion,
    restoreDefaultPresetFiles,
} from './content-manager.js';

/**
 * Gets the folder and extension for the preset settings based on the API source ID.
 * @param {string} apiId API source ID
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{folder: string?, extension: string?}} Object containing the folder and extension for the preset settings
 */
export function getPresetSettingsByAPI(apiId, directories) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return { folder: directories.koboldAI_Settings, extension: '.json' };
        case 'novel':
            return { folder: directories.novelAI_Settings, extension: '.json' };
        case 'textgenerationwebui':
            return { folder: directories.textGen_Settings, extension: '.json' };
        case 'openai':
            return { folder: directories.openAI_Settings, extension: '.json' };
        case 'instruct':
            return { folder: directories.instruct, extension: '.json' };
        case 'context':
            return { folder: directories.context, extension: '.json' };
        case 'sysprompt':
            return { folder: directories.sysprompt, extension: '.json' };
        case 'reasoning':
            return { folder: directories.reasoning, extension: '.json' };
        default:
            return { folder: null, extension: null };
    }
}

function getPresetContentTypeByAPI(apiId) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return 'kobold_preset';
        case 'novel':
            return 'novel_preset';
        case 'textgenerationwebui':
            return 'textgen_preset';
        case 'openai':
            return 'openai_preset';
        case 'instruct':
        case 'context':
        case 'sysprompt':
        case 'reasoning':
            return apiId;
        default:
            return null;
    }
}

export const router = express.Router();

router.post('/save', authoringRoute(function (request, response, lease) {
    const name = sanitize(request.body.name);
    if (!request.body.preset || !name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    assertNativeMediaTargetIdle(lease, { kind: 'preset', id: path.relative(request.user.directories.root, fullpath) });
    // Time Machine compares before asking to restore. Check again under the write
    // lock so a save in another tab cannot be overwritten after that comparison.
    if (Object.hasOwn(request.body, 'expected_preset')) {
        const expected = request.body.expected_preset;
        if (expected !== null && (typeof expected !== 'object' || Array.isArray(expected))) return response.sendStatus(400);
        const current = readAuthoringFileLocked(lease, fullpath);
        let matches = expected === null && !current;
        if (current && expected !== null) {
            try { matches = isDeepStrictEqual(JSON.parse(current.bytes.toString('utf8')), expected); } catch { /* unreadable is not a match */ }
        }
        if (!matches) return response.status(409).send({ error: 'The preset changed after comparison. Compare it again before restoring.' });
    }
    const defaultPreset = findDefaultPreset(request.user.directories, { folder: settings.folder, name });

    writeAuthoringFileLocked(lease, fullpath, JSON.stringify(request.body.preset, null, 4));

    // A save request is always user-initiated (save, save as, rename, import, or restore), so it may
    // claim a deleted bundled default's name. The tombstone only exists to stop the content seeder
    // from recreating the file, and a file now exists at that path, so it is retired here.
    if (defaultPreset) {
        clearDefaultPresetDeletion(request.user.directories, defaultPreset);
    }

    return response.send({ name });
}));

router.post('/delete', authoringRoute(function (request, response, lease) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    assertNativeMediaTargetIdle(lease, { kind: 'preset', id: path.relative(request.user.directories.root, fullpath) });

    const defaultPreset = findDefaultPreset(request.user.directories, { folder: settings.folder, name });

    if (readAuthoringFileLocked(lease, fullpath)) {
        if (defaultPreset) {
            recordDefaultPresetDeletion(request.user.directories, defaultPreset);
        }

        deleteAuthoringFileLocked(lease, fullpath);
        return response.sendStatus(200);
    }

    if (defaultPreset) {
        recordDefaultPresetDeletion(request.user.directories, defaultPreset);
        return response.sendStatus(200);
    }

    return response.sendStatus(404);
}));

router.post('/restore', authoringRoute(function (request, response, lease) {
    try {
        const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);

        const result = { isDefault: false, preset: {}, tombstoneCleared: false };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
            if (request.body.clearTombstone === true) {
                assertNativeMediaTargetIdle(lease, { kind: 'preset', id: path.relative(request.user.directories.root,
                    path.join(settings.folder, name + settings.extension)) });
                result.tombstoneCleared = clearDefaultPresetDeletion(request.user.directories, defaultPreset);
            }
        }

        return response.send(result);
    } catch (error) {
        if (error.code === 'MEDIA_TARGET_BUSY') return response.sendStatus(409);
        console.error(error);
        return response.sendStatus(500);
    }
}));

router.post('/restore-defaults', authoringRoute(function (request, response, lease) {
    try {
        const apiId = request.body.apiId ? String(request.body.apiId) : '';
        const contentType = apiId ? getPresetContentTypeByAPI(apiId) : null;

        if (apiId && !contentType) {
            return response.sendStatus(400);
        }

        const result = restoreDefaultPresetFiles(request.user.directories, contentType ? [contentType] : null, lease);

        return response.send({
            ok: result.failed.length === 0,
            ...result,
        });
    } catch (error) {
        if (error.code === 'MEDIA_TARGET_BUSY') return response.sendStatus(409);
        console.error(error);
        return response.sendStatus(500);
    }
}));
