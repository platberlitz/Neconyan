import path from 'node:path';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { fail } from './core.js';
import { readJson } from './store.js';
import { getTokenizerModel } from './tokens.js';

const aliases = { oai: 'openai', google: 'makersuite' };
const sources = new Set(Object.values(CHAT_COMPLETION_SOURCES));

export function listModelProfiles(directories) {
    const settings = readJson(path.join(directories.root, 'settings.json'), {});
    const profiles = settings.extension_settings?.connectionManager?.profiles || [];
    return profiles.filter(profile => sources.has(aliases[profile.api] || profile.api)).map(profile => {
        const model = profile.model || (profile.api === 'custom'
            ? settings.custom_endpoint_presets?.find(preset => preset.name === profile['custom-endpoint-profile'])?.model : '') || '';
        return { id: profile.id, name: profile.name, model, autoTokenizer: model ? getTokenizerModel(model) : '',
            embeddings: ['custom', 'openai', 'oai'].includes(profile.api) };
    });
}

/** Read the saved profile on the server; no API keys travel through the settings form. */
export function resolveModelProfile(directories, id, embedding = false, modelOverride = '') {
    const settings = readJson(path.join(directories.root, 'settings.json'), {});
    const profile = settings.extension_settings?.connectionManager?.profiles?.find(profile => profile.id === id);
    if (!profile) fail('The selected connection profile no longer exists. Choose another profile.', 409);
    const api = aliases[profile.api] || profile.api;
    if (!sources.has(api)) fail('Mewmory requires a Chat Completion connection profile.', 400);
    if (embedding && !['custom', 'openai'].includes(api)) fail('Embeddings require an OpenAI or OpenAI-compatible connection profile.', 400);
    const preset = settings.custom_endpoint_presets?.find(preset => preset.name === profile['custom-endpoint-profile']);
    const endpoint = api === 'custom' ? String(profile['api-url'] || preset?.url || '') : '';
    const model = String(modelOverride || profile.model || (api === 'custom' ? preset?.model : '') || '').trim();
    if (!model) fail('The selected connection profile has no saved model. Enter a Model in Mewmory settings, or save one in the connection profile.', 409);
    const secretId = String(profile['secret-id'] || (api === 'custom' ? preset?.secretId : '') || '');
    const payload = { chat_completion_source: api, model, secret_id: secretId, stream: false };
    const urlField = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint', siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint' }[api];
    if (urlField) payload[urlField] = endpoint || profile['api-url'];
    return { api, endpoint, model, secretId, payload };
}
