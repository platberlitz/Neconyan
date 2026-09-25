import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getImageBuffers } from '../util.js';
import { deleteSpriteFiles, listSpriteFiles, saveSpriteFiles } from '../generation/sprite-storage.js';
import { roleplayAccountBase, roleplayAccountStamp } from '../roleplay-store.js';

/** Import optional Risu images through the same protected writer as uploaded sprites. */
export function importRisuSprites(directories, data) {
    const name = data?.data?.name;
    const risu = data?.data?.extensions?.risuai;
    if (!risu || !name) return;
    const images = [...(Array.isArray(risu.additionalAssets) ? risu.additionalAssets : []),
        ...(Array.isArray(risu.emotions) ? risu.emotions : [])];
    if (!images.length) return;
    const selected = new Map();
    for (const [label, encoded] of images) {
        if (!selected.has(label)) selected.set(label, { filename: `${label}.png`, bytes: Buffer.from(String(encoded), 'base64') });
    }
    saveSpriteFiles(directories, name, [...selected.values()], { overwrite: false });
    delete risu.additionalAssets;
    delete risu.emotions;
}

export const router = express.Router();

router.get('/get', (request, response) => {
    try { return response.send(listSpriteFiles(request.user.directories, request.query.name)); } catch (error) {
        return response.sendStatus(error.status ?? 500);
    }
});

router.post('/delete', (request, response) => {
    if (!request.body.name || !(request.body.spriteName || request.body.label)) return response.sendStatus(400);
    try {
        deleteSpriteFiles(request.user.directories, request.body.name, request.body.spriteName || request.body.label);
        return response.sendStatus(200);
    } catch (error) { return response.sendStatus(error.status ?? 500); }
});

router.post('/upload-zip', async (request, response) => {
    if (!request.file || !request.body.name) return response.sendStatus(400);
    const uploaded = path.join(request.file.destination, request.file.filename);
    try {
        const base = roleplayAccountBase(request.user.directories);
        if (!base) return response.sendStatus(409);
        const account = roleplayAccountStamp(base);
        const images = await getImageBuffers(uploaded);
        const count = images.length ? saveSpriteFiles(request.user.directories, request.body.name,
            images.map(([filename, bytes]) => ({ filename, bytes })), { account }) : 0;
        return response.send({ ok: true, count });
    } catch (error) { return response.sendStatus(error.status ?? 500); } finally { fs.rmSync(uploaded, { force: true }); }
});

router.post('/upload', (request, response) => {
    if (!request.file || !request.body.label || !request.body.name) return response.sendStatus(400);
    const uploaded = path.join(request.file.destination, request.file.filename);
    try {
        const spriteName = request.body.spriteName || request.body.label;
        if (fs.statSync(uploaded).size > 25 * 1024 * 1024) return response.sendStatus(413);
        saveSpriteFiles(request.user.directories, request.body.name,
            [{ filename: spriteName + path.extname(request.file.originalname), bytes: fs.readFileSync(uploaded) }]);
        return response.send({ ok: true });
    } catch (error) { return response.sendStatus(error.status ?? 500); } finally { fs.rmSync(uploaded, { force: true }); }
});
