import { usesImageResponsesApi } from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { getCustomBackendCapabilities } from '../../public/scripts/extensions/quick-image-gen/lib/custom-backend.js';
import { getNanoGptModelCapabilities } from '../../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { proxyImageEndpoint } from './quick-image-gen-proxy.js';

/** Only routes that actually send source pixels may offer image editing. */
export function supportsQuickImageEditing(settings) {
    switch (settings.provider) {
        case 'gptimage': return usesImageResponsesApi(settings.gptImageProxyUrl, settings.gptImageModel)
            || /(?:^|\/)gpt-image-[\w.-]+$/.test(settings.gptImageModel || 'gpt-image-2');
        case 'nanobanana': return true;
        // NanoGPT discovers the model's current limits before any paid request.
        case 'nanogpt': return settings.__qigNanoGptModelMetadata
            ? getNanoGptModelCapabilities(settings.nanogptModel, settings.__qigNanoGptModelMetadata).referenceImages
            : Boolean(settings.nanogptModel && settings.nanogptModel !== 'flux-schnell');
        case 'local': return (settings.localType || 'a1111') === 'a1111';
        case 'custom': return getCustomBackendCapabilities(settings.customApiRequestTemplate).referenceImages;
        case 'proxy': {
            const endpoint = proxyImageEndpoint(settings);
            return endpoint.mode !== 'comfy' && endpoint.refMode !== 'url_only'
                && (endpoint.mode !== 'images_generations' || endpoint.payloadMode !== 'openai_strict');
        }
        default: return false;
    }
}

/** Per-request source selection never changes the owner's saved reference settings. */
export function withQuickImageEdit(settings, reference) {
    if (reference === undefined) return settings;
    if (!supportsQuickImageEditing(settings)) throw Object.assign(new Error('This Quick Image Gen provider or model does not support Scratchpad image editing. Choose a provider with image input.'), { status: 409, code: 'QIG_EDIT_UNSUPPORTED' });
    const fields = {
        gptimage: { __qigEditReference: reference },
        nanobanana: { nanobananaRefImages: [reference] },
        nanogpt: { nanogptRefImages: [reference] },
        local: { localRefImage: reference, a1111IpAdapter: false },
        custom: { customApiRefImages: [reference] },
        proxy: { proxyRefImages: [reference], __qigProxyReferences: [] },
    };
    return { ...settings, ...fields[settings.provider] };
}
