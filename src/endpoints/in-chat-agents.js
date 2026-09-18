import path from 'node:path';
import express from 'express';
import { readAgentCollection, writeAgentRecord } from '../in-chat-agent-storage.js';
import { normalizeAgentGroup, normalizeAgentSetupPreset } from '../../public/scripts/extensions/in-chat-agents/setup-presets.js';

export const router = express.Router();

const collections = [
    { prefix: '', kind: 'agent', directory: user => user.directories.inChatAgents, normalize: value => value },
    { prefix: '/groups', kind: 'group', directory: user => user.directories.inChatAgentGroups, normalize: normalizeAgentGroup },
    { prefix: '/presets', kind: 'preset', directory: user => path.join(user.directories.inChatAgents, 'presets'), normalize: normalizeAgentSetupPreset },
];

for (const { prefix, kind, directory, normalize } of collections) {
    router.post(`${prefix}/list`, (request, response) => {
        try {
            const result = readAgentCollection(directory(request.user), kind);
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
