import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import archiver from 'archiver';
import { getImageBuffers } from '../util.js';
import { deleteSpriteFiles, exportSpriteFiles, listSpriteFiles, saveSpriteFiles } from '../generation/sprite-storage.js';
import { roleplayAccountBase, roleplayAccountStamp } from '../roleplay-store.js';
import { installSpriteModel, processSpriteModel, spriteModelStatus } from '../generation/sprite-models.js';

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

router.get('/models', async (_request, response) => {
    try { response.json(await spriteModelStatus()); } catch (error) { response.status(error.status ?? 500).json({ error: error.message }); }
});

router.post('/models/install', async (request, response) => {
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
        await installSpriteModel(request.body?.kind, { signal: controller.signal });
        response.json({ ok: true });
    } catch (error) { if (!response.destroyed) response.status(error.status ?? 500).json({ error: error.message }); }
});

router.post('/process', express.raw({ type: 'application/octet-stream', limit: '16mb' }), async (request, response) => {
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
        const result = await processSpriteModel(request.query.kind, { data: request.body,
            width: Number(request.query.width), height: Number(request.query.height), scale: Number(request.query.scale || 2),
        }, { signal: controller.signal });
        response.type('application/octet-stream').send(Buffer.from(result.data));
    } catch (error) { if (!response.destroyed) response.status(error.status ?? 500).json({ error: error.message }); }
});

router.get('/get', (request, response) => {
    try { return response.send(listSpriteFiles(request.user.directories, request.query.name)); } catch (error) {
        return response.sendStatus(error.status ?? 500);
    }
});

router.post('/export', async (request, response) => {
    try {
        const files = exportSpriteFiles(request.user.directories, request.body.name);
        if (!files.length) return response.sendStatus(404);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', error => response.destroy(error));
        response.on('close', () => archive.abort());
        response.attachment(`${request.body.name.replaceAll('/', '-')}-expressions.zip`);
        archive.pipe(response);
        for (const file of files) archive.append(file.bytes, { name: file.filename });
        await archive.finalize();
    } catch (error) {
        if (response.headersSent) response.destroy(error);
        else response.sendStatus(error.status ?? 500);
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
