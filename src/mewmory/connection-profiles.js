import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { fail } from './core.js';
import { readJsonShared } from './store.js';
import { getTokenizerModel } from './tokens.js';

const aliases = { oai: 'openai', google: 'makersuite' };
const sources = new Set(Object.values(CHAT_COMPLETION_SOURCES));
const proxySources = new Set(['openai', 'openai_responses', 'claude', 'makersuite', 'vertexai', 'mistralai', 'deepseek', 'xai', 'moonshot', 'zai']);

export function listModelProfiles(directories) {
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
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
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
    const profile = settings.extension_settings?.connectionManager?.profiles?.find(profile => profile.id === id);
    if (!profile) fail('The selected connection profile no longer exists. Choose another profile.', 409);
    const api = aliases[profile.api] || profile.api;
    if (!sources.has(api)) fail('Mewmory requires a Chat Completion connection profile.', 400);
    if (embedding && !['custom', 'openai'].includes(api)) fail('Embeddings require an OpenAI or OpenAI-compatible connection profile.', 400);
    const preset = settings.custom_endpoint_presets?.find(preset => preset.name === profile['custom-endpoint-profile']);
    let endpoint = api === 'custom' ? String(profile['api-url'] || preset?.url || '') : '';
    const model = String(modelOverride || profile.model || (api === 'custom' ? preset?.model : '') || '').trim();
    if (!model) fail('The selected connection profile has no saved model. Enter a Model in Mewmory settings, or save one in the connection profile.', 409);
    const secretId = String(Object.hasOwn(profile, 'secret-id') ? profile['secret-id'] || '' : (api === 'custom' ? preset?.secretId : '') || '');
    const payload = { chat_completion_source: api, model, secret_id: secretId, stream: false };
    const urlField = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint', siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', linkapi: 'linkapi_endpoint' }[api];
    if (urlField) payload[urlField] = endpoint || profile['api-url'];
    const presetName = typeof profile.preset === 'string' && sanitize(profile.preset) === profile.preset ? profile.preset : '';
    const saved = presetName && directories.openAI_Settings ? readJsonShared(path.join(directories.openAI_Settings, presetName + '.json'), {}) : {};
    const fields = { azure_openai: ['azure_base_url', 'azure_deployment_name', 'azure_api_version'], workers_ai: ['workers_ai_account_id'],
        vertexai: ['vertexai_auth_mode', 'vertexai_express_project_id'] }[api] || [];
    for (const field of fields) {
        const value = String(profile[field] ?? saved[field] ?? '').trim();
        if (value) payload[field] = value;
        else if (api !== 'vertexai') fail('The selected profile needs ' + field.replaceAll('_', ' ') + ' saved in its connection preset.', 409);
    }
    if (api === 'azure_openai') endpoint = payload.azure_base_url;
    if (profile.proxy && profile.proxy !== 'None') {
        const proxy = settings.proxies?.find(proxy => proxy.name === profile.proxy);
        if (!proxy?.url) fail('The profile’s selected proxy no longer exists. Save a valid proxy selection.', 409);
        if (!proxySources.has(api)) fail('This provider cannot use the profile’s selected proxy. Choose a supported connection.', 409);
        endpoint = String(proxy.url);
        Object.assign(payload, { reverse_proxy: endpoint, proxy_password: String(proxy.password || '') });
    }
    const secretType = api === 'openai_responses' ? SECRET_KEYS.OPENAI
        : api === 'vertexai' && payload.vertexai_auth_mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS[api.toUpperCase()];
    if (!payload.reverse_proxy && (secretId || api !== 'custom') && (!secretId || !readSecret(directories, secretType, secretId))) {
        fail('The selected profile needs its own saved API key. Select a key in that profile and save it again.', 409);
    }
    return { api, endpoint, model, secretId, secretType, payload };
}
