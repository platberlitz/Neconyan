import { resolveChatTokenizerModel, getChatImageTokenCost } from '../../public/scripts/chat-prompt-tokens.js';
import { countOpenAIChatTokens, encodeGenerationText, getTokenizerModel } from '../endpoints/tokenizers.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError } from '../roleplay-store.js';
import { encodeTextProfilePrompt, resolveTextTokenizer } from './text-request.js';
import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { bindChatInputSettings } from '../../public/scripts/chat-input-capabilities.js';
import { createTextTokenCache } from './token-count-cache.js';

export async function createRoleplayTextCounter(context, material, { tokenizer, signal, modelOverride = '' } = {}) {
    if (material.backend === 'text' && material.profile && material.power) {
        const model = modelOverride || material.profile.model;
        return Object.assign(async text => (await encodeTextProfilePrompt(context, material, text, { signal, modelOverride })).length,
            { tokenizer: { tokenizerKey: resolveTextTokenizer(material.power.tokenizer, material.source, model), tokenizerName: model } });
    }
    if (material.backend === 'novel' && material.active?.model_novel) {
        const model = material.active.model_novel;
        const choice = model.includes('clio') ? 'nerdstash' : model.includes('kayra') ? 'nerdstash_v2'
            : model.includes('erato') ? 'llama3' : tokenizer;
        return Object.assign(async text => (await encodeGenerationText(choice, text, model, signal)).length, { tokenizer: { tokenizerKey: choice } });
    }
    return Object.assign((await getCounter(tokenizer)).count, { tokenizer: { tokenizerKey: tokenizer } });
}

/** Count the same provider-specific message representation used by the browser. */
export async function createRoleplayChatCounter(material, { images = [], models = [], fallbackTokenizer = 'o200k_base' } = {}) {
    const settings = bindChatInputSettings(mergeChatPresetSettings(material.active, material.preset), material.source, material.profile?.model);
    const queryModel = (material.source && resolveChatTokenizerModel(settings, { model_list: models }))
        || ({ o200k_base: 'gpt-4o', cl100k_base: 'gpt-4' }[fallbackTokenizer] ?? fallbackTokenizer);
    const model = getTokenizerModel(queryModel);
    // Verify availability before using the endpoint counter, which otherwise permits estimates.
    await getCounter(model);
    const countText = createTextTokenCache();
    return Object.assign(async messages => {
        if (!Array.isArray(messages)) throw roleplayError('ROLEPLAY_INVALID', 'The formatted Chat Completion prompt is invalid.', 409);
        let mediaTokens = 0;
        const text = messages.map(message => {
            const result = Object.fromEntries(['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning',
                'reasoning_content', 'reasoning_details', 'signature'].filter(key => message[key] != null).map(key => [key, message[key]]));
            for (const key of ['tool_calls', 'reasoning_details']) if (result[key]) result[key] = JSON.stringify(result[key]);
            if (Array.isArray(message.content)) {
                result.content = message.content.map(part => {
                    if (part.type === 'text') return part.text;
                    const image = images.find(image => part.type === 'image_url' && image.url === part.image_url.url);
                    if (!image) throw roleplayError('ROLEPLAY_INVALID', 'A prompt attachment has no saved token budget.', 409);
                    const detail = part.image_url.detail ?? 'auto';
                    mediaTokens += getChatImageTokenCost(image, detail);
                    return '';
                }).filter(Boolean).join('\n');
            }
            for (const key of Object.keys(result)) if (result[key] == null) delete result[key];
            return result;
        });
        return mediaTokens + await countOpenAIChatTokens(model, queryModel, text, { strict: true, countText });
    }, { tokenizer: { tokenizerKey: model } });
}
