import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIRECTORY } from '../constants.js';
import { isPathInside } from '../path-containment.js';

/**
 * Decodes a file name from Latin1 to UTF-8.
 * @param {string} str Input string
 * @returns {string} Decoded file name
 */
function decodeFileName(str) {
    return Buffer.from(str, 'latin1').toString('utf-8');
}

/**
 * Verify that a Multer temporary file record points to a direct regular file inside
 * its own upload destination directory (and inside globalThis.DATA_ROOT/_uploads when set).
 * @param {object} file Multer file object
 * @returns {string|null} Resolved upload file path when owned, or null
 */
export function resolveOwnedUploadPath(file) {
    if (!file || typeof file !== 'object') {
        return null;
    }

    const destination = typeof file.destination === 'string' && file.destination
        ? path.resolve(file.destination)
        : null;
    const filename = typeof file.filename === 'string' && file.filename
        ? file.filename
        : null;

    if (!destination || !filename || path.basename(filename) !== filename || filename === '.' || filename === '..') {
        return null;
    }

    if (typeof globalThis.DATA_ROOT === 'string' && globalThis.DATA_ROOT) {
        const expectedUploadsRoot = path.resolve(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
        if (!isPathInside(expectedUploadsRoot, destination, { allowEqual: true })) {
            return null;
        }
    }

    const candidatePath = typeof file.path === 'string' && file.path
        ? path.resolve(file.path)
        : path.join(destination, filename);

    if (path.dirname(candidatePath) !== destination || !isPathInside(destination, candidatePath)) {
        return null;
    }

    return candidatePath;
}

/**
 * Remove an owned temporary upload file if it still exists on disk.
 * @param {string|null} uploadPath
 */
export function cleanupOwnedUploadPath(uploadPath) {
    if (!uploadPath) {
        return;
    }

    try {
        const stat = fs.lstatSync(uploadPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
            fs.unlinkSync(uploadPath);
        }
    } catch {
        // Already unlinked/moved by the route handler or never created.
    }
}

/**
 * Middleware to decode file names from Latin1 to UTF-8 and ensure temporary
 * Multer uploads are cleaned up once the HTTP response finishes (or when the
 * handler terminates its response on a disconnected socket), without deleting
 * files prematurely on socket close while an async handler is still running.
 * See: https://github.com/expressjs/multer/issues/1104
 * @param {import('express').Request} req Request
 * @param {import('express').Response} res Response
 * @param {import('express').NextFunction} next Next middleware
 */
export default function multerMonkeyPatch(req, res, next) {
    try {
        if (req.file) {
            if (typeof req.file.originalname === 'string') {
                req.file.originalname = decodeFileName(req.file.originalname);
            }

            const ownedUploadPath = resolveOwnedUploadPath(req.file);
            if (ownedUploadPath && res && typeof res.once === 'function') {
                let cleaned = false;
                const cleanup = () => {
                    if (cleaned) {
                        return;
                    }
                    cleaned = true;
                    cleanupOwnedUploadPath(ownedUploadPath);
                };
                res.once('finish', cleanup);

                if (typeof res.end === 'function') {
                    const originalEnd = res.end;
                    res.end = function (...args) {
                        try {
                            return originalEnd.apply(this, args);
                        } finally {
                            queueMicrotask(cleanup);
                        }
                    };
                }
            }
        }

        next();
    } catch (error) {
        console.error('Error in multerMonkeyPatch:', error);
        next();
    }
}
