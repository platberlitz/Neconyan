import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { bindChatInputSettings } from '../../public/scripts/chat-input-capabilities.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { fetchChatProfileModels } from './service.js';

const catalogued = new Set(['openrouter', 'mistralai', 'aimlapi', 'chutes', 'electronhub', 'pollinations', 'moonshot', 'nanogpt', 'workers_ai']);

/** Save only the selected model's public input capabilities, never the account's catalogue credentials. */
export async function prepareRoleplayCapabilities(context, material, binding, { modelOverride = '', fetchModels = fetchChatProfileModels,
    artifactName = 'roleplay-model-capabilities' } = {}) {
    const settings = bindChatInputSettings(mergeChatPresetSettings(material.active, material.preset),
        material.source, modelOverride || material.profile?.model);
    settings.custom_prompt_post_processing ??= '';
    if (!catalogued.has(material.source)) return { settings, models: [] };
    const model = modelOverride || material.profile?.model;
    const identity = roleplayHash({ binding, model });
    let saved = readArtifact(context.directories, context.job.id, artifactName);
    if (saved === undefined) {
        const models = await fetchModels({ context: { owner: context.owner, directories: context.directories }, material, signal: context.signal });
        const found = models.find(item => item?.id === model);
        if (!found) throw roleplayError('ROLEPLAY_INVALID', 'The saved model is absent from its input capability catalogue.', 409);
        const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 128) : [];
        const flags = (value, keys) => Object.fromEntries(keys.filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));
        const record = { id: found.id, ...flags(found, ['tools', 'supports_tools', 'supports_image_in']),
            architecture: { input_modalities: strings(found.architecture?.input_modalities),
                ...(typeof found.architecture?.tokenizer === 'string' ? { tokenizer: found.architecture.tokenizer } : {}) },
            capabilities: flags(found.capabilities, ['vision', 'function_calling']), metadata: flags(found.metadata, ['vision', 'function_call']),
            ...Object.fromEntries(['features', 'supported_features', 'supported_parameters', 'input_modalities'].map(key => [key, strings(found[key])])),
            properties: Array.isArray(found.properties) ? found.properties.filter(item => ['vision', 'function_calling'].includes(item?.property_id))
                .map(item => ({ property_id: item.property_id, value: item.value === 'true' ? 'true' : 'false' })) : [],
        };
        if (Buffer.byteLength(JSON.stringify(record)) > 64 * 1024) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved model capability record is too large.', 409);
        }
        saved = { identity, record, hash: roleplayHash(record) };
        writeArtifact(context.directories, context.job.id, artifactName, saved);
    }
    if (!saved || saved.identity !== identity || saved.record?.id !== model || saved.hash !== roleplayHash(saved.record)) {
        throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved model input capabilities need recovery.', 503);
    }
    return { settings, models: [saved.record] };
}
