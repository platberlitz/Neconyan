import { fail } from '../mewmory/core.js';
import { encodeGenerationText, handleTextGenerationEncode } from '../endpoints/tokenizers.js';
import { runBackendRequest } from '../endpoints/conversation-generation.js';
import { createTextProviderParameters } from '../../public/scripts/text-provider-parameters.js';
import { constructScopedTextPrompt, normalizeContentText } from '../../public/scripts/generation-format.js';
import { getInstructStoppingSequences } from '../../public/scripts/instruct-format.js';
import { resolveCustomStoppingStrings } from '../../public/scripts/chat-request-controls.js';
import { applyGenerationRequestControls } from '../../public/scripts/generation-request-controls.js';
import { isLikelyLocalServerUrl } from '../../public/scripts/local-url-utils.js';

const localTokenizers = { 1: 'gpt2', 2: 'openai', 3: 'llama', 4: 'nerdstash', 5: 'nerdstash_v2', 7: 'mistral', 8: 'yi', 11: 'claude', 12: 'llama3', 13: 'gemma', 14: 'jamba', 15: 'qwen2', 16: 'command-r', 17: 'nemo', 18: 'deepseek', 19: 'command-a' };
const remoteTokenizers = new Set(['ooba', 'tabby', 'koboldcpp', 'llamacpp', 'vllm', 'aphrodite']);

export function resolveTextTokenizer(choice, source, model) {
    const key = String(choice ?? 'best_match').toLowerCase();
    const name = localTokenizers[key] || ({ nerd: 'nerdstash', nerd2: 'nerdstash_v2', command_r: 'command-r', command_a: 'command-a' })[key] || key;
    if (Object.values(localTokenizers).includes(name)) return name;
    if (['6', '9', '10', 'api_current', 'api_textgenerationwebui', 'api_kobold'].includes(name)) {
        if (remoteTokenizers.has(source)) return 'remote';
    } else if (['99', 'best_match'].includes(name)) {
        if (remoteTokenizers.has(source)) return 'remote';
        const lower = String(model || '').toLowerCase();
        if (source === 'dreamgen' && lower.startsWith('lucid-v1-')) return /extra-large|max/.test(lower) ? 'llama3' : 'mistral';
        const named = [['llama3', 'llama3'], ['llama-3', 'llama3'], ['llama2', 'llama'], ['llama-2', 'llama'],
            ['nemo', 'nemo'], ['pixtral', 'nemo'], ['mistral', 'mistral'], ['mixtral', 'mistral'], ['gemma', 'gemma'],
            ['deepseek', 'deepseek'], ['yi', 'yi'], ['jamba', 'jamba'], ['command-r', 'command-r'], ['command-a', 'command-a'], ['qwen2', 'qwen2'], ['claude', 'claude']];
        const matched = named.find(([fragment]) => lower.includes(fragment));
        if (matched) return matched[1];
        if (/^(?:openai\/)?(?:gpt-|o[134](?:-|$))/.test(lower)) return 'openai';
    }
    fail('Choose an available saved tokenizer before using text token bans or bias.', 409);
}

/** Prepare a named text request with saved settings and request-local dependencies. */
export async function buildTextProfileRequest(context, material, messages, maxTokens, {
    macroEnvironment, userName = 'User', characterName = 'Character', groupNames = [],
    ephemeralStops = [], signal, fetch: fetchImpl, modelOverride = '', overridePayload = {},
} = {}) {
    if ((!Array.isArray(messages) && typeof messages !== 'string') || !Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('The generation input is invalid.', 400);
    const { active: settings, instruct, power, source, profile, secretId, contextLimit } = material;
    const substitute = value => {
        if (macroEnvironment?.evaluate) return macroEnvironment.evaluate(value);
        if (String(value).includes('{{')) fail('This profile requires the captured chat macro context.', 400);
        return value;
    };
    const model = modelOverride.trim() || profile.model || '';
    if (macroEnvironment?.extra) {
        macroEnvironment.extra.mainApi = 'textgenerationwebui';
        macroEnvironment.extra.powerUser = { ...macroEnvironment.extra.powerUser, instruct: structuredClone(instruct), context: structuredClone(material.context) };
    }
    const format = { name1: userName, name2: characterName, selectedGroup: groupNames.length > 0, substitute };
    const prompt = typeof messages === 'string' ? messages : instruct.enabled
        ? constructScopedTextPrompt(structuredClone(messages), instruct, format)
        : messages.map(message => normalizeContentText(message.content)).join('\n\n');
    const tokenize = async text => {
        signal?.throwIfAborted();
        const tokenizer = resolveTextTokenizer(power.tokenizer, source, model);
        if (tokenizer !== 'remote') return encodeGenerationText(tokenizer, text, model, signal);
        const result = await runBackendRequest({ user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} }, handleTextGenerationEncode,
            { text, url: settings.api_server, model, api_type: source, secret_id: secretId }, { signal, fetch: fetchImpl, anonymousCustom: !secretId, boundProfile: true });
        if (!Array.isArray(result.ids) || !result.ids.every(Number.isInteger) || (text && !result.ids.length)) fail('The saved connection could not tokenise this text.', 409);
        return result.ids;
    };
    const ids = [];
    const strings = [];
    if (settings.send_banned_tokens) {
        const words = macroEnvironment?.extra?.bannedWords?.splice(0) || [];
        const lines = [...new Set([...`${settings.banned_tokens || ''}\n${settings.global_banned_tokens || ''}`.split('\n'), ...words].filter(Boolean))].map(substitute);
        for (const line of lines) {
            if (line.startsWith('[') && line.endsWith(']')) {
                let tokens;
                try { tokens = JSON.parse(line); } catch { fail('The saved token-ban list is invalid.', 409); }
                if (!Array.isArray(tokens) || !tokens.every(Number.isInteger)) fail('The saved token-ban list is invalid.', 409);
                ids.push(...tokens);
            } else if (line.startsWith('"') && line.endsWith('"')) strings.push(line.slice(1, -1));
            else ids.push(...await tokenize(line));
        }
    }
    const logitBias = {};
    for (const entry of settings.logit_bias || []) {
        const text = String(entry.text || '').trim();
        if (!text) continue;
        if (!Number.isFinite(entry.value)) fail('The saved token bias is invalid.', 409);
        let tokens;
        if (text.startsWith('[') && text.endsWith(']')) {
            try { tokens = JSON.parse(text); } catch { fail('The saved token-bias list is invalid.', 409); }
        } else tokens = await tokenize(text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : ` ${text}`);
        if (!Array.isArray(tokens) || !tokens.every(Number.isInteger)) fail('The saved token-bias list is invalid.', 409);
        for (const token of tokens) logitBias[String(token)] = entry.value;
    }
    const stops = () => [...new Set([
        ...resolveCustomStoppingStrings(power, substitute, ephemeralStops),
        ...(instruct.enabled ? getInstructStoppingSequences({ customInstruct: instruct, context: material.context, name1: userName, name2: characterName, substitute }) : []),
    ].filter(value => value !== ''))];
    const payload = createTextProviderParameters(settings, model, prompt, maxTokens, {
        contextLimit, apiServer: settings.api_server, requestTokenProbabilities: power.request_token_probabilities,
        resolveStoppingStrings: stops, tokenBans: { banned_tokens: [...new Set(ids)].join(','), banned_strings: strings },
        logitBias, substitute, cachePrompt: isLikelyLocalServerUrl(settings.api_server) ? false : undefined,
    });
    return applyGenerationRequestControls({ ...payload, ...overridePayload,
        prompt, model, api_type: source, api_server: settings.api_server, secret_id: secretId,
        stream: false,
    }, { responseLength: maxTokens, reasoning: false });
}
