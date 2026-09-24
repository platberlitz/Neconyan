import { resolveChatTokenizerModel, getChatImageTokenCost } from '../../public/scripts/chat-prompt-tokens.js';
import { countOpenAIChatTokens, encodeGenerationText, getTokenizerModel } from '../endpoints/tokenizers.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError } from '../roleplay-store.js';
import { encodeTextProfilePrompt } from './text-request.js';

export async function createRoleplayTextCounter(context, material, { tokenizer, signal, modelOverride = '' } = {}) {
    if (material.backend === 'text' && material.profile && material.power) {
        return async text => (await encodeTextProfilePrompt(context, material, text, { signal, modelOverride })).length;
    }
    if (material.backend === 'novel' && material.active?.model_novel) {
        const model = material.active.model_novel;
        const choice = model.includes('clio') ? 'nerdstash' : model.includes('kayra') ? 'nerdstash_v2'
            : model.includes('erato') ? 'llama3' : tokenizer;
        return async text => (await encodeGenerationText(choice, text, model, signal)).length;
    }
    return (await getCounter(tokenizer)).count;
}

/** Count the same provider-specific message representation used by the browser. */
export async function createRoleplayChatCounter(material, { images = [], fallbackTokenizer = 'o200k_base' } = {}) {
    const settings = { ...(material.preset ?? material.active), chat_completion_source: material.source };
    const selectedModel = material.profile?.model;
    if (selectedModel) {
        for (const key of Object.keys(settings)) if (key.endsWith('_model')) settings[key] = selectedModel;
        settings[`${material.source}_model`] = selectedModel;
        if (material.source === 'openai_responses') settings.openai_model = selectedModel;
    }
    const queryModel = (material.source && resolveChatTokenizerModel(settings))
        || ({ o200k_base: 'gpt-4o', cl100k_base: 'gpt-4' }[fallbackTokenizer] ?? fallbackTokenizer);
    const model = getTokenizerModel(queryModel);
    // Verify availability before using the endpoint counter, which otherwise permits estimates.
    await getCounter(model);
    return async messages => {
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
        return mediaTokens + await countOpenAIChatTokens(model, queryModel, text, { strict: true });
    };
}
