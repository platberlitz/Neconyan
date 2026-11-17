/**
 * Presets and protocol helpers for Jev and Jev-like System One decision models,
 * message-window batching, and memory extraction focus in Mewmory.
 */

export const DECISION_ROLES = Object.freeze(['selector', 'fallback']);
export const DECISION_MODES = Object.freeze(['auto', 'chat', 'decision']);
export const EXTRACTION_FOCUS_MODES = Object.freeze(['every', 'balanced', 'compact']);

// Nano-GPT's decision catalogue is separate from its chat model list. All
// entries accept named noul questions through the System One endpoint.
export const NANOGPT_DECISION_PRESETS = Object.freeze([
    ['d3', 'd3 (Decision Large)', 'vllm-sr/decision-large', 64],
    ['d3-flash', 'd3 Flash (Decision Medium)', 'vllm-sr/decision-medium', 64],
    ['d3-mini', 'd3 Mini (Decision Small)', 'vllm-sr/decision-small', 64],
    ['kev-9b', 'Kev 9B', 'jaredpalmer/kev-9b', 128],
    ['kev-4b', 'Kev 4B TEE', 'jaredpalmer/kev-4b', 128],
    ['pplx-decider-v1.2', 'PPLX Decider v1.2', 'perplexity/pplx-decider-v1.2', 128],
    ['clef', 'Clef', 'cloudflare/clef', 128],
    ['clef-omni', 'Clef Omni', 'cloudflare/clef-omni', 128],
    ['clef-flash', 'Clef Flash', 'cloudflare/clef-flash', 128],
    ['gpt-6-luna-decisions', 'GPT-6 Luna Decisions', 'openai/gpt-6-luna-decisions', 128],
    ['eu-jeff-1.0.0', 'eu/jev Jeff 1.0.0', 'eu-jev/eu-jeff-1.0.0', 8],
    ['eu-jeff-latest', 'eu/jev Jeff Latest', 'eu-jev/eu-jeff-latest', 8],
    ['rune-26b-a4b', 'Rune 26B-A4B', 'surogate/rune-26b-a4b', 256],
    ['subq-snap-1.1', 'SubQ Snap 1.1', 'subq/subq-snap-1.1', 128],
    ['subq-snap-preview', 'SubQ Snap Preview', 'subq/subq-snap-preview', 128],
    ['liquid-d1', 'Liquid D1', 'liquid/d1', 128],
    ['jev-1.13', 'Jev 1.13', 'typesafe/jev-1.13', 128],
    ['jev-1.14', 'Jev 1.14', 'typesafe/jev-1.14', 128],
    ['jev-latest', 'Jev Latest', 'typesafe/jev-latest', 128],
    ['drex-max-finance', 'Drex Max Finance', 'nace-ai/drex-max-finance', 64],
].map(([id, shortLabel, model, maxQuestions]) => Object.freeze({
    id: 'nanogpt-' + id,
    label: 'Nano-GPT: ' + shortLabel + ' (' + model + ')',
    shortLabel,
    model,
    endpoint: 'https://api.nano-gpt.com/api/v1/systemone',
    threshold: 0.5,
    family: 'Nano-GPT',
    maxQuestions,
})));

export const JEV_DECISION_PRESETS = Object.freeze([
    {
        id: 'jev-latest',
        label: 'TypeSafe direct: Jev Latest (jev-latest)',
        shortLabel: 'Jev Latest',
        model: 'jev-latest',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        threshold: 0.5,
        family: 'TypeSafe direct',
    },
    {
        id: 'jev-1.14',
        label: 'OpenRouter: Jev 1.14 (typesafe/jev-1.14)',
        shortLabel: 'Jev 1.14',
        model: 'typesafe/jev-1.14',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'jev-1.13',
        label: 'OpenRouter: Jev 1.13 (typesafe/jev-1.13)',
        shortLabel: 'Jev 1.13',
        model: 'typesafe/jev-1.13',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'openrouter-jev-latest',
        label: 'OpenRouter: Jev Latest (~typesafe/jev-latest)',
        shortLabel: 'Jev Latest',
        model: '~typesafe/jev-latest',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'gpt-6-luna-decisions',
        label: 'GPT-6 Luna Decisions (openai/gpt-6-luna-decisions)',
        shortLabel: 'GPT-6 Luna Decisions',
        model: 'openai/gpt-6-luna-decisions',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'pplx-decider-v1.2',
        label: 'Perplexity Decider 1.2 (perplexity/pplx-decider-v1.2)',
        shortLabel: 'Perplexity Decider 1.2',
        model: 'perplexity/pplx-decider-v1.2',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'pplx-decider-flash-v1.2',
        label: 'Perplexity Decider Flash 1.2 (perplexity/pplx-decider-flash-v1.2)',
        shortLabel: 'Perplexity Decider Flash',
        model: 'perplexity/pplx-decider-flash-v1.2',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'cloudflare-clef',
        label: 'Cloudflare Clef (cloudflare/clef)',
        shortLabel: 'Cloudflare Clef',
        model: 'cloudflare/clef',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'cloudflare-clef-flash',
        label: 'Cloudflare Clef Flash (cloudflare/clef-flash)',
        shortLabel: 'Cloudflare Clef Flash',
        model: 'cloudflare/clef-flash',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'liquid-d1',
        label: 'Liquid D1 (liquid/d1)',
        shortLabel: 'Liquid D1',
        model: 'liquid/d1',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'mercury-decide',
        label: 'Inception Mercury Decide (inception/mercury-decide)',
        shortLabel: 'Mercury Decide',
        model: 'inception/mercury-decide',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'solar-decide',
        label: 'Upstage Solar Decide (upstage/solar-decide)',
        shortLabel: 'Solar Decide',
        model: 'upstage/solar-decide',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'microsoft-decision-1',
        label: 'Microsoft Decision 1 (microsoft/microsoft-decision-1)',
        shortLabel: 'Microsoft Decision 1',
        model: 'microsoft/microsoft-decision-1',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        threshold: 0.5,
        family: 'Hosted System One',
    },
    {
        id: 'open-jev-9b',
        label: 'Open-Jev 9B (ZefanCai/Open-Jev-9B)',
        shortLabel: 'Open-Jev 9B',
        model: 'ZefanCai/Open-Jev-9B',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        threshold: 0.1,
        family: 'Self-hosted / Open-weights',
    },
    {
        id: 'open-jev-2b',
        label: 'Open-Jev 2B (ZefanCai/Open-Jev-2B)',
        shortLabel: 'Open-Jev 2B',
        model: 'ZefanCai/Open-Jev-2B',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        threshold: 0.1,
        family: 'Self-hosted / Open-weights',
    },
    {
        id: 'autotrust-jev-27b',
        label: 'AutoTrust JEV 27B (autotrust/JEV-27B)',
        shortLabel: 'AutoTrust JEV 27B',
        model: 'autotrust/JEV-27B',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        threshold: 0.5,
        family: 'Self-hosted / Open-weights',
    },
    {
        id: 'strands-decider-2b',
        label: 'Strands Decider 2B (StrandsAgents/strands-decider-2B-hobson-v19)',
        shortLabel: 'Strands Decider 2B',
        model: 'StrandsAgents/strands-decider-2B-hobson-v19',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        threshold: 0.5,
        family: 'Self-hosted / Open-weights',
    },
    ...NANOGPT_DECISION_PRESETS,
]);

export const MESSAGE_WINDOW_PRESETS = Object.freeze([
    {
        id: 'jev-recommended',
        label: 'Jev recommended (keep 10, summarise every 5)',
        shortLabel: 'Jev 10 + 5',
        historyMode: 'messages',
        recentMessages: 10,
        historyBatchMessages: 5,
        batchMessages: 5,
        extractionFocus: 'every',
        description: 'Keep 10 recent messages in chat and summarise older chat in groups of 5, recording every memory.',
    },
    {
        id: 'jev-tight',
        label: 'Tight window (keep 6, summarise every 3)',
        shortLabel: 'Tight 6 + 3',
        historyMode: 'messages',
        recentMessages: 6,
        historyBatchMessages: 3,
        batchMessages: 3,
        extractionFocus: 'every',
        description: 'Keep 6 recent messages in chat and summarise older chat in groups of 3, recording every memory.',
    },
    {
        id: 'jev-deep',
        label: 'Long scene window (keep 20, summarise every 10)',
        shortLabel: 'Deep 20 + 10',
        historyMode: 'messages',
        recentMessages: 20,
        historyBatchMessages: 10,
        batchMessages: 10,
        extractionFocus: 'every',
        description: 'Keep 20 recent messages in chat and summarise older chat in groups of 10, recording every memory.',
    },
    {
        id: 'token-window',
        label: 'Token window (30,000 tokens)',
        shortLabel: 'Tokens (30k)',
        historyMode: 'tokens',
        historyWindow: 30000,
        batchMessages: 12,
        extractionFocus: 'balanced',
        description: 'Measure recent chat by token allowance instead of message count.',
    },
]);

export const EXTRACTION_FOCUS_OPTIONS = Object.freeze([
    {
        value: 'every',
        label: 'Every memory (recommended for Jev)',
        shortLabel: 'Every memory',
        description: 'Record every distinct fact, event, state change, relationship shift, promise, item, and detail so nothing is lost when messages leave chat.',
    },
    {
        value: 'balanced',
        label: 'Balanced story detail',
        shortLabel: 'Balanced',
        description: 'Record full story facts, events, states, relationships, and commitments while skipping minor filler.',
    },
    {
        value: 'compact',
        label: 'Key milestones only',
        shortLabel: 'Milestones only',
        description: 'Record only high-significance plot turns, enduring character facts, and explicit commitments.',
    },
]);

const DECISION_MODEL_PATTERN = /(?:^|\/)(?:~?typesafe\/jev|jev(?:[-_]|$)|gpt-6-luna-decisions|pplx-decider|clef(?:-flash|-omni)?$|d1(?:-ultra)?$|mercury-decide|solar-decide|microsoft-decision|open-jev|strands-decider|autojev)/i;
const DECISION_ENDPOINT_PATTERN = /\/(?:systemone|decisions|decide)(?:\/|$)/i;

export function isDecisionModel(model = '', endpoint = '') {
    const modelText = String(model || '').trim();
    const endpointText = String(endpoint || '').trim();
    return DECISION_MODEL_PATTERN.test(modelText) || DECISION_ENDPOINT_PATTERN.test(endpointText)
        || NANOGPT_DECISION_PRESETS.some(preset => preset.model.toLowerCase() === modelText.toLowerCase());
}

export function defaultDecisionThreshold(model = '') {
    return /open-jev/i.test(String(model || '')) ? 0.1 : 0.5;
}

export function effectiveDecisionMode(role = {}) {
    if (role?.decisionMode === 'decision') return 'decision';
    if (role?.decisionMode === 'chat') return 'chat';
    return isDecisionModel(role?.model || role?.modelOverride || '', role?.endpoint || '') ? 'decision' : 'chat';
}

export function findDecisionPreset(modelOrId = '', endpoint = '') {
    const trimmed = String(modelOrId || '').trim().toLowerCase();
    if (!trimmed) return null;
    const byId = JEV_DECISION_PRESETS.find(preset => preset.id.toLowerCase() === trimmed);
    if (byId) return byId;
    const matches = JEV_DECISION_PRESETS.filter(preset => preset.model.toLowerCase() === trimmed);
    if (endpoint) {
        try {
            const host = new URL(endpoint).host.toLowerCase().replace(/^api\.nano-gpt\.com$/, 'nano-gpt.com');
            const match = matches.find(preset => new URL(preset.endpoint).host.toLowerCase().replace(/^api\.nano-gpt\.com$/, 'nano-gpt.com') === host);
            if (match) return match;
        } catch {
            // Unfinished manual URLs keep the existing model-only match.
        }
    }
    return matches[0] || null;
}

export function detectMessageWindowPreset(config = {}) {
    if (!config || typeof config !== 'object') return 'custom';
    for (const preset of MESSAGE_WINDOW_PRESETS) {
        if (preset.historyMode === 'messages') {
            if (config.historyMode === 'messages'
                && Number(config.recentMessages) === preset.recentMessages
                && Number(config.historyBatchMessages) === preset.historyBatchMessages
                && Number(config.batchMessages ?? preset.batchMessages) === preset.batchMessages) {
                return preset.id;
            }
        } else if (config.historyMode === 'tokens'
            && Number(config.historyWindow) === preset.historyWindow
            && Number(config.batchMessages ?? preset.batchMessages) === preset.batchMessages) {
            return preset.id;
        }
    }
    return 'custom';
}
