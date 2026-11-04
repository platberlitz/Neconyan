import path from 'node:path';
import express from 'express';
import { readPathfinderActivity } from '../generation/pathfinder-activity.js';
import { pathfinderKey, resolvePathfinderModel, requestPathfinderModel } from '../generation/pathfinder-model.js';
import { readAgentCollection, writeAgentRecord } from '../in-chat-agent-storage.js';
import { normalizeAgentGroup, normalizeAgentSetupPreset } from '../../public/scripts/extensions/in-chat-agents/setup-presets.js';

export const router = express.Router();

router.post('/pathfinder/activity', (request, response) => {
    try {
        const owner = request.user.profile.handle;
        const expected = request.get('X-Neconyan-Account');
        if (expected !== undefined && expected !== owner) return response.status(409).json({ error: 'account_changed' });
        response.json({ activity: readPathfinderActivity({ owner, directories: request.user.directories }, request.body) });
    } catch (error) { response.status(error.status ?? 500).json({ error: error.message }); }
});

router.post('/pathfinder/key', (request, response) => {
    try { response.json(pathfinderKey(request.user.directories, request.body)); } catch (error) { response.status(error.status ?? 500).json({ error: error.message }); }
});

router.post('/pathfinder/retrieve', async (request, response) => {
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', abort);
    try {
        const { settings, agentId, profileId, ...input } = request.body;
        const model = resolvePathfinderModel(request.user.directories, settings, { agentId, profileId });
        response.json(model ? await requestPathfinderModel(model, { ...input, signal: controller.signal }) : { protocol: 'chat', useExistingConnection: true });
    } catch (error) {
        if (!controller.signal.aborted) response.status(error.status >= 400 && error.status <= 599 ? error.status : 500).json({ error: error.message });
    } finally { response.off('close', abort); }
});

const collections = [
    { prefix: '', kind: 'agent', directory: user => user.directories.inChatAgents, normalize: value => value },
    { prefix: '/groups', kind: 'group', directory: user => user.directories.inChatAgentGroups, normalize: normalizeAgentGroup },
    { prefix: '/presets', kind: 'preset', directory: user => path.join(user.directories.inChatAgents, 'presets'), normalize: normalizeAgentSetupPreset },
];

for (const { prefix, kind, directory, normalize } of collections) {
    router.post(`${prefix}/list`, (request, response) => {
        try {
            const result = readAgentCollection(directory(request.user), kind,
                { owner: request.user.profile.handle, directories: request.user.directories });
            response.set('X-Neconyan-Account', request.user.profile.handle);
            return response.json(request.body?.withDiagnostics ? result : result.records);
        } catch (error) {
            return response.status(error.status ?? 500).json({ error: error.message });
        }
    });
    for (const action of ['save', 'delete']) {
        router.post(`${prefix}/${action}`, (request, response) => {
            try {
                const record = action === 'save' ? normalize(request.body) : request.body;
                if (!record) return response.status(400).json({ error: 'Invalid record.' });
                const revision = writeAgentRecord(request, directory(request.user), kind, record, { remove: action === 'delete' });
                response.set('X-Neconyan-Revision', revision);
                response.set('X-Neconyan-Account', request.user.profile.handle);
                return response.json(action === 'save' && kind === 'preset' ? record : { ok: true });
            } catch (error) {
                return response.status(error.status ?? 500).json({ error: error.message });
            }
        });
    }
}
