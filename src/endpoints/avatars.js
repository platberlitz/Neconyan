import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getImages, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { applyAvatarCropResize } from './characters.js';
import { invalidateThumbnail } from './thumbnails.js';
import { createPersonaCard, decodePersonaImport, encodePersonaCard, MAX_PERSONA_CARD_BYTES } from '../persona-card.js';
import { retireNavigationPersona } from './chat-navigation.js';

export const router = express.Router();

router.post('/get', function (request, response) {
    const images = getImages(request.user.directories.avatars);
    response.send(images);
});

router.post('/export-persona', async (request, response) => {
    const { avatar, name, descriptor, format } = request.body ?? {};
    if (typeof avatar !== 'string' || !avatar || avatar !== sanitize(avatar) || !['png', 'json'].includes(format)) {
        return response.sendStatus(400);
    }
    try {
        const card = createPersonaCard(name, descriptor);
        const avatarPath = path.join(request.user.directories.avatars, avatar);
        if (!fs.existsSync(avatarPath)) return response.sendStatus(404);
        // Re-encode to PNG so JPEG/WebP avatars and old image metadata are handled consistently.
        const image = await (await Jimp.read(avatarPath)).getBuffer('image/png');
        const output = encodePersonaCard(card, image, format);
        if (output.length > MAX_PERSONA_CARD_BYTES) return response.sendStatus(413);
        response.attachment(`${sanitize(card.data.name) || 'persona'}.persona.${format}`);
        return response.type(format === 'png' ? 'image/png' : 'application/json').send(output);
    } catch (error) {
        console.warn('Could not export persona card:', error.message);
        return response.sendStatus(400);
    }
});

router.post('/import-persona', async (request, response) => {
    if (!request.file) return response.sendStatus(400);
    const uploadPath = path.join(request.file.destination, request.file.filename);
    const created = [];
    try {
        if (fs.statSync(uploadPath).size > MAX_PERSONA_CARD_BYTES) return response.sendStatus(413);
        const format = path.extname(request.file.originalname).slice(1).toLowerCase();
        const { cards, backup } = decodePersonaImport(fs.readFileSync(uploadPath), format);
        const fallback = backup ? fs.readFileSync(new URL('../../public/img/user-default.png', import.meta.url)) : null;
        const personas = [];
        for (const { card, image } of cards) {
            // Validate and strip card metadata, preserving the full image without another crop.
            const avatarImage = image ? await (await Jimp.read(image)).getBuffer('image/png') : fallback;
            const avatar = `persona-${randomUUID()}.png`;
            const filename = path.join(request.user.directories.avatars, avatar);
            writeFileAtomicSync(filename, avatarImage);
            created.push(filename);
            personas.push({ avatar, ...card.data });
        }
        return response.send(backup ? { personas, missingAvatars: personas.length } : personas[0]);
    } catch (error) {
        for (const filename of created) fs.rmSync(filename, { force: true });
        console.warn('Could not import persona card:', error.message);
        return response.sendStatus(400);
    } finally {
        fs.rmSync(uploadPath, { force: true });
    }
});

router.post('/delete', getFileNameValidationFunction('avatar'), function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.avatar !== sanitize(request.body.avatar)) {
        console.error('Malicious avatar name prevented');
        return response.sendStatus(403);
    }

    const fileName = path.join(request.user.directories.avatars, sanitize(request.body.avatar));

    if (fs.existsSync(fileName)) {
        retireNavigationPersona(request, request.body.avatar, () => fs.unlinkSync(fileName));
        invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.avatar));
        return response.send({ result: 'ok' });
    }

    return response.sendStatus(404);
});

router.post('/upload', async (request, response) => {
    if (!request.file) return response.sendStatus(400);
    const pathToUpload = path.join(request.file.destination, request.file.filename);
    try {
        const overwrite = request.body.overwrite_name;
        if (overwrite && (typeof overwrite !== 'string' || overwrite !== sanitize(overwrite))) return response.sendStatus(400);
        const crop = tryParse(request.query.crop);
        const rawImg = await Jimp.read(pathToUpload);
        const image = await applyAvatarCropResize(rawImg, crop);

        // Remove previous thumbnail if overwriting
        if (request.body.overwrite_name) {
            invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.overwrite_name));
        }

        const filename = sanitize(request.body.overwrite_name || `${randomUUID()}.png`);
        const pathToNewFile = path.join(request.user.directories.avatars, filename);
        writeFileAtomicSync(pathToNewFile, image);
        return response.send({ path: filename });
    } catch (err) {
        console.error('Error uploading user avatar:', err);
        return response.status(400).send('Is not a valid image');
    } finally {
        fs.rmSync(pathToUpload, { force: true });
    }
});
