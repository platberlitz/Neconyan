import express from 'express';
import { roleplayAccountBase } from '../roleplay-store.js';
import { searchAccount } from '../account-search.js';

export const router = express.Router();
const active = new Map();

router.post('/', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const owner = request.user?.profile?.handle;
    const base = roleplayAccountBase(request.user?.directories);
    if (!owner || !base || base.owner !== owner || (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== owner)) {
        return response.status(409).json({ error: 'The account changed. Reload and search again.' });
    }
    const { query, offset = 0 } = request.body || {};
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 30) {
        return response.status(400).json({ error: 'Choose search text up to 200 characters and a valid result page.' });
    }
    if ((active.get(owner) || 0) >= 2) return response.status(429).json({ error: 'Search is busy. Try again shortly.' });
    active.set(owner, (active.get(owner) || 0) + 1);
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
        response.json(await searchAccount(base, query, { offset, signal: controller.signal }));
    } catch {
        if (!controller.signal.aborted) response.status(503).json({ error: 'Saved content could not be searched. Try again.' });
    } finally {
        const remaining = active.get(owner) - 1;
        if (remaining) active.set(owner, remaining); else active.delete(owner);
    }
});
