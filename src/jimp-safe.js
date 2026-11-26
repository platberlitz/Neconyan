import fs from 'node:fs';
import { ResizeStrategy } from '@jimp/plugin-resize';
import { imageSize } from 'image-size';
import { Jimp } from './jimp.js';

export const IMAGE_MAX_PIXELS = 64 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 16384;
const IMAGE_MAX_FRAMES = 256;

function imageBoundsError(message, status) {
    const error = new Error(message);
    error.status = status;
    error.code = status === 413 ? 'IMAGE_TOO_LARGE' : 'IMAGE_UNREADABLE';
    return error;
}

/**
 * True for errors thrown by readBoundedJimp/assertBoundedImage.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isImageBoundsError(error) {
    return error instanceof Error && (error.code === 'IMAGE_TOO_LARGE' || error.code === 'IMAGE_UNREADABLE');
}

/**
 * Reads image dimensions from the header and rejects pictures that would decode into a huge bitmap.
 * @param {Uint8Array} bytes
 * @param {{maxPixels?: number, maxDimension?: number}} [limits]
 * @returns {{width: number, height: number}}
 */
export function assertBoundedImage(bytes, { maxPixels = IMAGE_MAX_PIXELS, maxDimension = IMAGE_MAX_DIMENSION } = {}) {
    let dimensions;
    try {
        dimensions = imageSize(bytes);
    } catch {
        throw imageBoundsError('The image could not be read.', 400);
    }
    const frames = Array.isArray(dimensions.images) && dimensions.images.length ? dimensions.images : [dimensions];
    if (frames.length > IMAGE_MAX_FRAMES) throw imageBoundsError('The image has too many frames.', 413);
    for (const frame of [dimensions, ...frames]) {
        const width = Number(frame?.width);
        const height = Number(frame?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw imageBoundsError('The image could not be read.', 400);
        if (width > maxDimension || height > maxDimension || width * height > maxPixels) throw imageBoundsError('The image is too large.', 413);
    }
    return { width: Number(dimensions.width), height: Number(dimensions.height) };
}

/**
 * Jimp.read with a header-based size check before any pixels are decoded.
 * @param {string|Buffer|ArrayBuffer|Uint8Array} input File path or image bytes.
 * @param {{maxPixels?: number, maxDimension?: number}} [limits]
 * @returns {Promise<import('./jimp.js').Jimp>}
 */
export async function readBoundedJimp(input, { maxPixels = IMAGE_MAX_PIXELS, maxDimension = IMAGE_MAX_DIMENSION } = {}) {
    let bytes;
    if (typeof input === 'string') bytes = await fs.promises.readFile(input);
    else if (Buffer.isBuffer(input)) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = Buffer.from(input);
    else if (ArrayBuffer.isView(input)) bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    else throw imageBoundsError('The image could not be read.', 400);
    assertBoundedImage(bytes, { maxPixels, maxDimension });
    try {
        return await Jimp.read(bytes);
    } catch (cause) {
        const error = imageBoundsError('The image could not be read.', 400);
        error.cause = cause;
        throw error;
    }
}

function assertJimpLikeImage(image) {
    if (!image?.bitmap || typeof image.bitmap.width !== 'number' || typeof image.bitmap.height !== 'number') {
        throw new TypeError('Expected a Jimp-like image instance');
    }
}

function clampCropRegion(image, { x = 0, y = 0, w = image.bitmap.width, h = image.bitmap.height } = {}) {
    const sourceWidth = Math.max(1, Math.round(image.bitmap.width));
    const sourceHeight = Math.max(1, Math.round(image.bitmap.height));

    let cropX = Number.isFinite(x) ? Math.round(x) : 0;
    let cropY = Number.isFinite(y) ? Math.round(y) : 0;
    let cropWidth = Number.isFinite(w) ? Math.round(w) : sourceWidth;
    let cropHeight = Number.isFinite(h) ? Math.round(h) : sourceHeight;

    cropWidth = Math.max(1, cropWidth);
    cropHeight = Math.max(1, cropHeight);
    cropX = Math.max(0, Math.min(cropX, sourceWidth - 1));
    cropY = Math.max(0, Math.min(cropY, sourceHeight - 1));
    cropWidth = Math.max(1, Math.min(cropWidth, sourceWidth - cropX));
    cropHeight = Math.max(1, Math.min(cropHeight, sourceHeight - cropY));

    return { x: cropX, y: cropY, w: cropWidth, h: cropHeight };
}

function ensureBitmapBuffer(image) {
    if (!Buffer.isBuffer(image.bitmap.data)) {
        image.bitmap.data = Buffer.from(image.bitmap.data);
    }

    return image.bitmap.data;
}

/**
 * Bun currently throws inside Buffer.writeUInt32BE(), which breaks Jimp's crop/cover plugins.
 * Copy rows directly so image processing stays stable on Bun.
 * @param {import('./jimp.js').Jimp} image
 * @param {{x?: number, y?: number, w?: number, h?: number}} options
 * @returns {import('./jimp.js').Jimp}
 */
export function safeCrop(image, options = {}) {
    assertJimpLikeImage(image);

    const { x, y, w, h } = clampCropRegion(image, options);
    const sourceData = ensureBitmapBuffer(image);
    const sourceWidth = image.bitmap.width;
    const rowBytes = w * 4;
    const bitmap = Buffer.allocUnsafe(rowBytes * h);

    for (let row = 0; row < h; row++) {
        const sourceStart = (((y + row) * sourceWidth) + x) * 4;
        sourceData.copy(bitmap, row * rowBytes, sourceStart, sourceStart + rowBytes);
    }

    image.bitmap.data = bitmap;
    image.bitmap.width = w;
    image.bitmap.height = h;
    return image;
}

/**
 * Resizes to fill the target box, then crops the overflow.
 * Mirrors Jimp's cover behavior without relying on the broken crop plugin.
 * @param {import('./jimp.js').Jimp} image
 * @param {{w: number, h: number, mode?: ResizeStrategy}} options
 * @returns {import('./jimp.js').Jimp}
 */
export function safeCover(image, { w, h, mode = ResizeStrategy.BILINEAR }) {
    assertJimpLikeImage(image);

    const targetWidth = Math.max(1, Math.round(Number(w) || 0));
    const targetHeight = Math.max(1, Math.round(Number(h) || 0));
    const sourceWidth = Math.max(1, image.bitmap.width);
    const sourceHeight = Math.max(1, image.bitmap.height);
    const scale = targetWidth / targetHeight > sourceWidth / sourceHeight
        ? targetWidth / sourceWidth
        : targetHeight / sourceHeight;

    image.resize({
        w: Math.max(targetWidth, Math.round(sourceWidth * scale)),
        h: Math.max(targetHeight, Math.round(sourceHeight * scale)),
        mode,
    });

    return safeCrop(image, {
        x: Math.round((image.bitmap.width - targetWidth) / 2),
        y: Math.round((image.bitmap.height - targetHeight) / 2),
        w: targetWidth,
        h: targetHeight,
    });
}
