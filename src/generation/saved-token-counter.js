import { resolveChatTokenizerModel } from '../../public/scripts/chat-prompt-tokens.js';
import { countOpenAIChatTokens, getTokenizerModel, encodeGenerationText } from '../endpoints/tokenizers.js';
import { captureGenerationBinding, resolveGenerationProfile } from './profiles.js';
import { createRoleplayTextCounter } from './roleplay-budget.js';
import { getSettingsRevision } from '../settings-version.js';
import { getCounter } from '../mewmory/tokens.js';

/** Capture the saved token-counting choice without dispatching model generation. */
export function captureSavedTokenizer(base, saved) {
    if (saved.main_api === 'openai') {
        const model = resolveChatTokenizerModel(saved.oai_settings ?? {}, { main_api: 'openai' });
        if (typeof model !== 'string' || !model) throw Object.assign(new Error('Save a model selection before counting tokens.'), { status: 409 });
        return { kind: 'chat', model, tokenizer: getTokenizerModel(model) };
    }
    if (saved.main_api === 'novel') {
        const model = saved.nai_settings?.model_novel || '';
        return { kind: 'local', model, tokenizer: model.includes('erato') ? 'llama3' : model.includes('kayra') ? 'nerdstash_v2' : 'nerdstash' };
    }
    return { kind: 'binding', binding: captureGenerationBinding(base.directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(saved) }) };
}

export async function savedTokenCounter(context, tokenizer) {
    if (tokenizer.kind === 'chat') {
        await getCounter(tokenizer.tokenizer);
        return async text => text ? await countOpenAIChatTokens(tokenizer.tokenizer, tokenizer.model,
            [{ role: 'system', content: text }], { strict: true }) - 1 : 0;
    }
    if (tokenizer.kind === 'local') return async text => (await encodeGenerationText(tokenizer.tokenizer, text, tokenizer.model, context.signal)).length;
    return createRoleplayTextCounter(context, resolveGenerationProfile(context.directories, tokenizer.binding), { signal: context.signal });
}
