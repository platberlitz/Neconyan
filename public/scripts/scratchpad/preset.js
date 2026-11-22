import { amount_gen, main_api, max_context } from '../../script.js';
import { getChatCompletionModel, getChatCompletionSamplerCapabilitiesForSettings, model_list, oai_settings, promptManager } from '../openai.js';
import { INJECTION_POSITION } from '../PromptManager.js';
import { power_user } from '../power-user.js';
import { getPresetManager } from '../preset-manager.js';
import { textgenerationwebui_settings } from '../textgen-settings.js';
import { PRESET_FIELDS } from './preset-fields.js';

const API_LABELS = {
    openai: 'Chat Completion',
    textgenerationwebui: 'Text Completion',
    kobold: 'KoboldAI',
    koboldhorde: 'AI Horde',
    novel: 'NovelAI',
};

const CHAT_SAMPLERS = [
    ['temperature', 'Temperature', 'temp_openai'],
    ['top_p', 'Top P', 'top_p_openai'],
    ['frequency_penalty', 'Frequency penalty', 'freq_pen_openai'],
    ['presence_penalty', 'Presence penalty', 'pres_pen_openai'],
    ['top_k', 'Top K', 'top_k_openai'],
    ['min_p', 'Min P', 'min_p_openai'],
    ['top_a', 'Top A', 'top_a_openai'],
    ['typical_p', 'Typical P', 'typical_p_openai'],
    ['repetition_penalty', 'Repetition penalty', 'repetition_penalty_openai'],
    ['seed', 'Seed', 'seed_openai'],
];

const TEXT_SAMPLERS = [
    ['temperature', 'Temperature', 'temperature'],
    ['top_p', 'Top P', 'top_p'],
    ['top_k', 'Top K', 'top_k'],
    ['min_p', 'Min P', 'min_p'],
    ['top_a', 'Top A', 'top_a'],
    ['typical_p', 'Typical P', 'typical_p'],
    ['tfs', 'Tail-free sampling', 'tfs'],
    ['frequency_penalty', 'Frequency penalty', 'freq_pen'],
    ['presence_penalty', 'Presence penalty', 'presence_pen'],
    ['repetition_penalty', 'Repetition penalty', 'rep_pen'],
    ['repetition_penalty_range', 'Repetition penalty range', 'rep_pen_range'],
    ['repetition_penalty_slope', 'Repetition penalty slope', 'rep_pen_slope'],
    ['encoder_repetition_penalty', 'Encoder repetition penalty', 'encoder_rep_pen'],
];

const CHAT_SOURCE_LABELS = {
    openai: 'OpenAI',
    openai_responses: 'OpenAI Responses',
    claude: 'Claude',
    makersuite: 'Google AI Studio',
    vertexai: 'Vertex AI',
    openrouter: 'OpenRouter',
    ai21: 'AI21',
    mistralai: 'MistralAI',
    custom: 'Custom (OpenAI-compatible)',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    groq: 'Groq',
    siliconflow: 'SiliconFlow',
    minimax: 'MiniMax',
    electronhub: 'Electron Hub',
    chutes: 'Chutes',
    nanogpt: 'NanoGPT',
    deepseek: 'DeepSeek',
    aimlapi: 'AIMLAPI',
    xai: 'xAI',
    pollinations: 'Pollinations',
    cometapi: 'CometAPI',
    moonshot: 'Moonshot',
    fireworks: 'Fireworks',
    azure_openai: 'Azure OpenAI',
    zai: 'Z.ai',
    workers_ai: 'Workers AI',
    linkapi: 'LinkAPI',
};

const TEXT_SOURCE_LABELS = {
    ooba: 'Text generation web UI',
    tabby: 'TabbyAPI',
    koboldcpp: 'KoboldCpp',
    vllm: 'vLLM',
    aphrodite: 'Aphrodite',
    llamacpp: 'llama.cpp',
    ollama: 'Ollama',
    infermatic: 'InfermaticAI',
    dreamgen: 'DreamGen',
    generic: 'Generic',
};

function sourceLabel(source, labels) {
    const key = text(source);
    if (!key) return 'Not selected';
    return labels[key] || key;
}

function chatSamplers() {
    let supported = null;
    try {
        supported = getChatCompletionSamplerCapabilitiesForSettings(oai_settings)?.supportedParameters;
    } catch {
        supported = null;
    }
    const keys = Array.isArray(supported) && supported.length ? supported : CHAT_SAMPLERS.map(([key]) => key);
    return CHAT_SAMPLERS.filter(([key]) => keys.includes(key)).map(([key, label, setting]) => ({
        key,
        label,
        value: oai_settings?.[setting] ?? '',
    }));
}

function chatContextSize(model) {
    const record = Array.isArray(model_list) ? model_list.find(item => item?.id === model) : null;
    const reported = Number(record?.context_length || record?.context_window || record?.max_model_len || record?.max_context_length || 0);
    return reported > 0 ? reported : 0;
}

/** Samplers and limits the current API uses, with no connection secrets. */
function presetValues(kind) {
    if (kind === 'chat') {
        return {
            contextSize: Number(oai_settings?.openai_max_context) || 0,
            replyLength: Number(oai_settings?.openai_max_tokens) || 0,
            samplers: chatSamplers(),
            assistantPrefill: String(oai_settings?.assistant_prefill ?? ''),
            continuePrefill: Boolean(oai_settings?.continue_prefill),
        };
    }
    const settings = textgenerationwebui_settings || {};
    return {
        contextSize: Number(max_context) || 0,
        replyLength: Number(amount_gen) || 0,
        samplers: TEXT_SAMPLERS.map(([key, label, setting]) => ({ key, label, value: settings[setting] ?? '' })),
        instructEnabled: Boolean(power_user?.instruct?.enabled),
        instructPreset: text(power_user?.instruct?.preset),
        contextPreset: text(power_user?.context?.preset),
    };
}

function presetConnection(kind) {
    if (kind === 'chat') {
        const source = text(oai_settings?.chat_completion_source);
        const model = text(getChatCompletionModel(oai_settings));
        return {
            source,
            sourceLabel: sourceLabel(source, CHAT_SOURCE_LABELS),
            ...(model ? { model } : {}),
            modelContext: chatContextSize(model),
        };
    }
    const source = text(textgenerationwebui_settings?.type);
    return {
        source,
        sourceLabel: sourceLabel(source, TEXT_SOURCE_LABELS),
    };
}

function text(value) {
    return String(value ?? '').trim();
}

/** The name of the equipped generation preset, or '' when none is selected. */
export function currentPresetName() {
    if (main_api === 'openai' && text(oai_settings?.preset_settings_openai)) return text(oai_settings.preset_settings_openai);
    try {
        return text(getPresetManager()?.getSelectedPresetName());
    } catch {
        return '';
    }
}

function promptOrder(globalOnly) {
    if (!promptManager?.serviceSettings) return [];
    const dummy = { id: promptManager.configuration?.promptOrder?.dummyId };
    const own = globalOnly ? [] : promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
    return own.length ? own : promptManager.getPromptOrderForCharacter(dummy);
}

function chatModules(globalOnly) {
    return promptOrder(globalOnly).map(entry => {
        const prompt = promptManager.getPromptById(entry.identifier);
        if (!prompt) return null;
        const inChat = Number(prompt.injection_position) === INJECTION_POSITION.ABSOLUTE;
        return {
            id: prompt.identifier,
            name: text(prompt.name) || prompt.identifier,
            enabled: entry.enabled !== false,
            marker: Boolean(prompt.marker),
            role: prompt.marker ? '' : (prompt.role || 'system'),
            depth: inChat ? Number(prompt.injection_depth ?? 4) : null,
            content: prompt.marker ? '' : String(prompt.content ?? ''),
        };
    }).filter(Boolean);
}

function textModules() {
    const sysprompt = power_user?.sysprompt || {};
    const instruct = power_user?.instruct || {};
    const context = power_user?.context || {};
    return [
        {
            id: 'sysprompt',
            name: `System prompt${text(sysprompt.name) ? `: ${text(sysprompt.name)}` : ''}`,
            enabled: Boolean(sysprompt.enabled),
            marker: false,
            role: 'system',
            depth: null,
            content: [text(sysprompt.content), text(sysprompt.post_history) ? `Post-history instructions:\n${text(sysprompt.post_history)}` : ''].filter(Boolean).join('\n\n'),
        },
        {
            id: 'context',
            name: `Context template${text(context.preset) ? `: ${text(context.preset)}` : ''}`,
            enabled: true,
            marker: false,
            role: '',
            depth: null,
            content: text(context.story_string),
        },
        {
            id: 'instruct',
            name: `Instruct template${text(instruct.preset) ? `: ${text(instruct.preset)}` : ''}`,
            enabled: Boolean(instruct.enabled),
            marker: false,
            role: '',
            depth: null,
            content: '',
        },
    ];
}

/** Context and reply limits for the current API, without its preset modules. */
export function currentLimits() {
    const kind = main_api === 'openai' ? 'chat' : 'text';
    const values = presetValues(kind);
    return { contextSize: values.contextSize, replyLength: values.replyLength };
}

/**
 * Reads the active preset and its parts, in prompt order, with what is on and off.
 * Text is returned exactly as saved, so macros and card slots stay unfilled.
 */
export function readCurrentPreset({ globalOnly = false } = {}) {
    const api = main_api || '';
    const kind = api === 'openai' ? 'chat' : 'text';
    return {
        kind,
        api: API_LABELS[api] || api,
        name: currentPresetName(),
        modules: kind === 'chat' ? chatModules(globalOnly) : textModules(),
        values: presetValues(kind),
        connection: presetConnection(kind),
        targets: currentPresetTargets(),
    };
}

/** Only selected presets whose prompt text is explicitly shared. */
export function currentPresetTargets() {
    const apis = main_api === 'openai' ? ['openai'] : ['sysprompt', 'context', 'instruct'];
    return apis.flatMap(api => {
        const manager = getPresetManager(api);
        const name = manager?.getSelectedPresetName();
        if (!name) return [];
        const fields = api === 'openai' ? undefined : Object.fromEntries(PRESET_FIELDS[api]
            .map(field => [field, String(power_user[api]?.[field] ?? '')]));
        return [{ api, name, ...(fields ? { fields } : {}) }];
    });
}

export function currentPromptOrderId() {
    const own = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
    return own.length ? promptManager.activeCharacter.id : promptManager.configuration.promptOrder.dummyId;
}
