import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { thumbnailDimensions, readMetadataIndex, renameMetadata, removeMetadata, getOrGenerateMetadataBatch } from './image-metadata.js';
import { getImages } from '../util.js';
import { MEDIA_EXTENSIONS, MEDIA_REQUEST_TYPE } from '../constants.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { serverDirectory } from '../server-directory.js';

export const router = express.Router();

const mobileBackgroundDirectory = path.join(serverDirectory, 'default/content/backgrounds-mobile');
const mobileBackgroundManifest = path.join(mobileBackgroundDirectory, 'artwork-provenance.json');

function isAllowedBackgroundFileName(filename) {
    if (typeof filename !== 'string' || !filename || filename !== sanitize(filename)) {
        return false;
    }
    const ext = path.extname(filename).toLowerCase().replace(/^\./, '');
    if (!ext || !MEDIA_EXTENSIONS.includes(ext)) {
        return false;
    }
    const mimeType = String(mime.lookup(filename) || '');
    return (mimeType.startsWith('image/') || mimeType.startsWith('video/')) && mimeType !== 'image/svg+xml';
}

/** Finds a phone composition only when this account still has the exact bundled original. */
export async function findMobileBackground(directories, filename, manifestFile = mobileBackgroundManifest) {
    if (!isAllowedBackgroundFileName(filename) || path.basename(filename) !== filename || filename.includes('\\')) return null;
    try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
        const item = manifest.backgrounds?.find(entry => entry.filename === filename);
        if (!item || !isAllowedBackgroundFileName(item.mobileFile)
            || path.basename(item.mobileFile) !== item.mobileFile || item.mobileFile.includes('\\')
            || !Number.isSafeInteger(item.originalBytes) || item.originalBytes < 1
            || !/^[a-f0-9]{64}$/.test(item.originalSha256)) return null;

        const original = path.join(directories.backgrounds, filename);
        const stat = await fs.promises.lstat(original);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.originalBytes) return null;
        const handle = await fs.promises.open(original, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const openedStat = await handle.stat();
            if (!openedStat.isFile() || openedStat.size !== item.originalBytes) return null;
            const bytes = await handle.readFile();
            if (createHash('sha256').update(bytes).digest('hex') !== item.originalSha256) return null;
        } finally {
            await handle.close();
        }

        const portrait = path.join(path.dirname(manifestFile), item.mobileFile);
        const portraitStat = await fs.promises.lstat(portrait);
        return portraitStat.isFile() && !portraitStat.isSymbolicLink() ? portrait : null;
    } catch {
        // Missing or changed files keep the ordinary background behaviour.
        return null;
    }
}

router.get('/mobile/:filename', async function (request, response) {
    const filename = request.params.filename;
    if (!isAllowedBackgroundFileName(filename) || path.basename(filename) !== filename || filename.includes('\\')) {
        return response.sendStatus(400);
    }
    response.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'default-src \'none\'; media-src \'self\'; img-src \'self\'; style-src \'unsafe-inline\'; sandbox',
    });
    const originalUrl = `/backgrounds/${encodeURIComponent(filename)}`;
    const portrait = await findMobileBackground(request.user.directories, filename);
    if (!portrait) return response.redirect(originalUrl);
    return response.sendFile(portrait, error => {
        if (error && !response.headersSent) response.redirect(originalUrl);
    });
});

/** Restores missing indexed backgrounds without replacing existing files. */
export async function restoreBundledBackgrounds(directories, sources = [
    { directory: path.join(serverDirectory, 'default/scaffold'), optional: true },
    { directory: path.join(serverDirectory, 'default/content'), optional: false },
]) {
    const restored = [];
    const failed = [];
    const seen = new Set();

    for (const source of sources) {
        let index;
        try {
            index = JSON.parse(await fs.promises.readFile(path.join(source.directory, 'index.json'), 'utf8'));
            if (!Array.isArray(index)) throw new Error('Invalid content index');
        } catch (error) {
            if (source.optional && error.code === 'ENOENT') continue;
            throw error;
        }

        for (const item of index) {
            if (item?.type !== 'background') continue;
            const relative = item.filename;
            const filename = typeof relative === 'string' && relative.startsWith('backgrounds/') ? relative.slice('backgrounds/'.length) : '';
            if (!filename || !isAllowedBackgroundFileName(filename) || path.basename(filename) !== filename || filename.includes('\\')) {
                failed.push(String(relative || '(invalid background)'));
                continue;
            }
            if (seen.has(filename)) continue;
            seen.add(filename);

            try {
                await fs.promises.copyFile(path.join(source.directory, 'backgrounds', filename), path.join(directories.backgrounds, filename), fs.constants.COPYFILE_EXCL);
                restored.push(filename);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    console.warn('[Backgrounds] Could not restore background:', filename, error.message);
                    failed.push(filename);
                }
                continue;
            }
            try {
                invalidateThumbnail(directories, 'bg', filename);
            } catch (error) {
                console.warn('[Backgrounds] Could not clear restored thumbnail:', filename, error.message);
            }
        }
    }
    return { restored, failed };
}

router.post('/restore-defaults', async function (request, response) {
    try {
        response.json(await restoreBundledBackgrounds(request.user.directories));
    } catch (error) {
        console.error('[Backgrounds] Could not read bundled backgrounds:', error);
        response.status(500).json({ error: 'Could not restore the default backgrounds. Try again.' });
    }
});

router.post('/all', async function (request, response) {
    try {
        const files = getImages(request.user.directories.backgrounds, 'name', MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO);
        const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };

        // Only generate metadata for actual image files; video files are handled client-side.
        const imageFiles = files.filter(file => String(mime.lookup(file) || '').startsWith('image/'));
        const relativePaths = imageFiles.map(file => path.join('backgrounds', file));
        const { results: metadataMap } = await getOrGenerateMetadataBatch(request.user.directories.root, relativePaths, 'bg');

        // Build response with metadata for each background file.
        const filesWithMetadata = files.map(file => {
            const relativePath = path.join('backgrounds', file);
            const metadata = metadataMap[relativePath];
            const mimeType = String(mime.lookup(file) || '');
            const mediaType = mimeType.startsWith('video/') ? 'video' : 'image';
            return {
                filename: file,
                isAnimated: metadata?.isAnimated ?? mediaType === 'video',
                mediaType,
            };
        });

        response.json({ images: filesWithMetadata, config });
    } catch (error) {
        console.error('[Backgrounds] Error fetching backgrounds:', error);
        response.status(500).json({ error: 'Could not load the backgrounds. Try again.' });
    }
});

/**
 * POST /api/backgrounds/folders
 * Returns folders and per-image folderIds from the metadata index.
 * Loaded separately from /all to avoid blocking image rendering.
 */
router.post('/folders', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        const folders = index.folders || [];

        // Build a slim map of image → folderIds for the frontend
        /** @type {Object.<string, string[]>} */
        const imageFolderMap = {};
        for (const [relativePath, meta] of Object.entries(index.images)) {
            if (Array.isArray(meta.folderIds) && meta.folderIds.length > 0) {
                // Strip the directory prefix to get just the filename
                const filename = relativePath.split('/').pop() || relativePath;
                imageFolderMap[filename] = meta.folderIds;
            }
        }

        response.json({ folders, imageFolderMap });
    } catch (error) {
        console.error('[Backgrounds] Folders endpoint error:', error);
        response.status(500).json({ error: 'Could not finish that. Try again in a moment.' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        if (request.body.bg !== sanitize(request.body.bg)) {
            console.error('Malicious bg name prevented');
            return response.sendStatus(403);
        }

        const fileName = path.join(request.user.directories.backgrounds, sanitize(request.body.bg));

        if (!fs.existsSync(fileName)) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        fs.unlinkSync(fileName);
        try {
            invalidateThumbnail(request.user.directories, 'bg', request.body.bg);
        } catch (error) {
            console.warn('[Backgrounds] Could not clear deleted thumbnail:', request.body.bg, error.message);
        }

        // Remove metadata for deleted image
        const relativePath = path.join('backgrounds', request.body.bg);
        await removeMetadata(request.user.directories.root, relativePath).catch(err => {
            console.warn('[Backgrounds] Failed to remove metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/rename', async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const oldBg = sanitize(String(request.body.old_bg ?? ''));
        const newBg = sanitize(String(request.body.new_bg ?? ''));
        if (!oldBg || !newBg || !isAllowedBackgroundFileName(oldBg) || !isAllowedBackgroundFileName(newBg)) {
            return response.sendStatus(400);
        }

        const oldFileName = path.join(request.user.directories.backgrounds, oldBg);
        const newFileName = path.join(request.user.directories.backgrounds, newBg);

        if (!fs.existsSync(oldFileName)) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        if (fs.existsSync(newFileName)) {
            console.error('New BG file already exists');
            return response.sendStatus(400);
        }

        fs.copyFileSync(oldFileName, newFileName);
        fs.unlinkSync(oldFileName);
        invalidateThumbnail(request.user.directories, 'bg', oldBg);

        // Update metadata for renamed image
        const oldRelativePath = path.join('backgrounds', oldBg);
        const newRelativePath = path.join('backgrounds', newBg);
        await renameMetadata(request.user.directories.root, oldRelativePath, newRelativePath).catch(err => {
            console.warn('[Backgrounds] Failed to rename metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

// Neconyan: distinct routes keep native overwrites separate from create-only installs.
router.post('/upload', (request, response) => uploadBackground(request, response));
router.post('/upload-new', (request, response) => uploadBackground(request, response, true));

async function uploadBackground(request, response, createOnly = false) {
    let img_path;
    try {
        img_path = request.file && path.join(request.file.destination, request.file.filename);
        if (!request.body || !request.file) return response.sendStatus(400);

        const filename = sanitize(String(request.file.originalname ?? ''));
        if (!isAllowedBackgroundFileName(filename)) {
            return response.sendStatus(400);
        }
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename), createOnly ? fs.constants.COPYFILE_EXCL : 0);
        fs.unlinkSync(img_path);
        img_path = undefined;
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        await getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            console.warn('[Backgrounds] Failed to generate metadata for upload:', err.message);
        });

        response.status(createOnly ? 201 : 200).send(filename);
    } catch (err) {
        if (createOnly && err?.code === 'EEXIST') {
            return response.sendStatus(409);
        }
        console.error(err);
        response.sendStatus(500);
    } finally {
        if (img_path) {
            try {
                fs.rmSync(img_path, { force: true });
            } catch (error) {
                console.error(error);
            }
        }
    }
}
