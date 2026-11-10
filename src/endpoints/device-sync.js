import express from 'express';
import { randomUUID } from 'node:crypto';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { operationAccount } from '../operations/jobs.js';
import { withRoleplayAccount } from '../roleplay-store.js';
import { getAllEnabledUsers, getUserDirectories } from '../users.js';
import { authoriseGrant, configureSync, conflictCopy, createGrant, exportEnvelope, importEnvelope, manualSync,
    readSyncState, recoverSync, resolveConflict, revokeGrant, forgetConflict } from '../device-sync/service.js';
import { gistSync, pairingSync, validateConfig, webdavSync } from '../device-sync/transports.js';
import { encrypt, fail, LIMITS } from '../device-sync/protocol.js';
import { withSync } from '../device-sync/store.js';
import { validateData } from '../device-sync/data.js';

export const router = express.Router();
export const pairingRouter = express.Router();
const limiter = new RateLimiterMemory({ points: 30, duration: 60 });

const errorResponse = (response, error) => response.status(error.status || 409).json({ error: error.syncSafe ? error.message : 'Sync could not finish safely. Your saved data was kept. Check for an interrupted operation and retry.' });
const route = handler => async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { const { base, account } = operationAccount(request); await handler(request, response, base, account); } catch (error) { if (!response.headersSent) errorResponse(response, error); }
};

router.get('/status', route((_request, response, base, account) => response.json(readSyncState(base, account))));
router.post('/configure', route((request, response, base, account) => {
    const input = request.body;
    response.json(configureSync(base, account, { ...input, ...(input.config !== undefined ? { config: validateConfig(input.method, input.config) } : {}) }));
}));
router.post('/export', route(async (_request, response, base, account) => {
    const result = await manualSync(base, account, 'file', async context => ({ envelope: await exportEnvelope(context), exported: true }));
    // Do not put a whole encrypted package in last-result settings/state responses.
    response.set('Content-Disposition', 'attachment; filename="neconyan-device-sync.json"').json(result.envelope);
}));
router.post('/import', route(async (request, response, base, account) => {
    response.json(await manualSync(base, account, 'file', context => importEnvelope(context, request.body.envelope, 'file')));
}));
router.post('/now', route(async (request, response, base, account) => {
    const method = request.body.method;
    if (!['webdav', 'gist', 'pairing'].includes(method)) throw fail('Choose a network sync method.');
    response.json(await manualSync(base, account, method, context => method === 'webdav' ? webdavSync(context)
        : method === 'gist' ? gistSync(context, { create: request.body.create === true }) : pairingSync(context)));
}));
router.post('/recover', route((request, response, base, account) => response.json(recoverSync(base, account, request.body.method))));
router.post('/resolve', route((request, response, base, account) => response.json(resolveConflict(base, account, request.body.id, request.body.choice))));
router.post('/forget-conflict', route((request, response, base, account) => response.json(forgetConflict(base, account, request.body.id))));
router.post('/conflict-copy', route(async (request, response, base, account) => {
    const preserved = conflictCopy(base, account, request.body.id, request.body.side);
    const method = readSyncState(base, account).conflicts.find(item => item.id === request.body.id)?.method;
    const result = await manualSync(base, account, method, async context => {
        const snapshot = withSync(base, account, ({ state, save }) => {
            const entries = [...preserved.companions, preserved.entry];
            const value = { format: 'neconyan-device-sync', version: 1, deviceId: state.deviceId, sequence: ++state.sequence,
                recovery: { id: randomUUID(), sourceDeviceId: state.deviceId }, categories: [...new Set(entries.map(item => item.category))], entries };
            validateData(value);
            save(); return value;
        });
        return { envelope: await encrypt(snapshot, context.passphrase), exported: true };
    });
    response.set('Content-Disposition', 'attachment; filename="neconyan-conflict-copy.json"').json(result.envelope);
}));
router.post('/grant', route((_request, response, base, account) => response.json(createGrant(base, account))));
router.post('/revoke', route((request, response, base, account) => response.json(revokeGrant(base, account, request.body.id))));

// This exact POST is the only pairing admission before browser auth/CSRF. It never
// sets a browser session and cannot serve settings, files, or another account API.
pairingRouter.post('/:owner/:id', async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    try {
        await limiter.consume(request.ip || 'unknown');
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.params.owner) || !/^[a-f0-9]{32}$/.test(request.params.id)
            || request.get('Origin') || request.get('Sec-Fetch-Mode')) throw fail('Pairing admission refused.', 403);
        const profile = (await getAllEnabledUsers()).find(user => user.handle === request.params.owner);
        if (!profile) throw fail('Pairing admission refused.', 403);
        const base = { owner: profile.handle, directories: getUserDirectories(profile.handle) };
        const account = withRoleplayAccount(base, null, (_lease, stamp) => stamp);
        const authorization = request.get('Authorization') || '';
        if (!authorization.startsWith('NeconyanPair ')) throw fail('Pairing admission refused.', 403);
        const token = authorization.slice(13);
        authoriseGrant(base, account, request.params.id, token);
        request.deviceSyncPairing = { base, account, token };
        next();
    } catch (error) { errorResponse(response, error.status ? error : fail('Pairing admission refused or rate limited.', 403)); }
}, express.json({ limit: LIMITS.envelope, inflate: false }), async (request, response) => {
    try {
        const { base, account, token } = request.deviceSyncPairing;
        authoriseGrant(base, account, request.params.id, token);
        const result = await manualSync(base, account, 'pairing', async context => {
            const originalGuard = context.guard;
            context.guard = () => { originalGuard(); authoriseGrant(base, account, request.params.id, token); };
            const imported = await importEnvelope(context, request.body.envelope, 'pair-grant:' + request.params.id);
            const envelope = await exportEnvelope(context);
            context.guard(); return { ...imported, envelope };
        });
        response.json(result);
    } catch (error) { if (!response.headersSent) errorResponse(response, error); }
});
