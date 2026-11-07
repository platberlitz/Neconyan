/** Native Structured Prefill. This module has no browser or server dependencies. */
export const STRUCTURED_PREFILL_DEFAULTS = Object.freeze({
    enabled: false, output_method: 'schema', hide_prefill_in_display: true, newline_token: '<NL>', min_chars_after_prefix: 80,
    continue_overlap_chars: 14, anti_slop_ban_list: '', override_prefill_enabled: false, override_prefill_text: '',
    prefill_gen_enabled: false, prefill_gen_profile_id: '', prefill_gen_extra_prompt: '',
    prefill_gen_extra_prompt_role: 'system', prefill_gen_max_tokens: 15, prefill_gen_stop: '',
    prefill_gen_keep_matched_stop_string: false, prefill_gen_timeout_ms: 120000,
});

const SOURCES = new Set(['openai', 'openai_responses', 'claude', 'makersuite', 'vertexai', 'cohere', 'ai21', 'deepseek',
    'custom', 'openrouter', 'nanogpt', 'groq', 'fireworks', 'mistralai', 'xai', 'chutes', 'aimlapi', 'electronhub', 'azure_openai',
    'perplexity', 'pollinations', 'moonshot', 'cometapi', 'zai', 'siliconflow', 'minimax', 'workers_ai', 'linkapi']);
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalise = value => String(value ?? '').replace(/\r\n?/g, '\n');

export function structuredPrefillSettings(value = {}) {
    const result = { ...STRUCTURED_PREFILL_DEFAULTS };
    for (const [key, fallback] of Object.entries(result)) {
        if (typeof value?.[key] === typeof fallback) result[key] = value[key];
    }
    for (const [key, min, max] of [['min_chars_after_prefix', 0, 100000], ['continue_overlap_chars', 0, 1000],
        ['prefill_gen_max_tokens', 1, 4096], ['prefill_gen_timeout_ms', 500, 120000]]) {
        result[key] = Math.min(max, Math.max(min, Math.floor(Number.isFinite(result[key]) ? result[key] : STRUCTURED_PREFILL_DEFAULTS[key])));
    }
    result.output_method = result.output_method === 'instructions' ? 'instructions' : 'schema';
    return result;
}

export function supportsStructuredPrefill(source) { return SOURCES.has(source); }

/** Keep quiet/agent/schema/tool requests independent of the main reply preference. */
export function structuredPrefillRequest(payload, settings, type, substitute = value => value) {
    const config = structuredPrefillSettings(settings);
    if (!config.enabled || !['normal', 'swipe', 'regenerate', 'continue'].includes(type)
        || !supportsStructuredPrefill(payload.chat_completion_source) || payload.json_schema || payload.responseSchema
        || payload.tools?.length || payload.request_images || payload.enable_web_search || payload.use_web_search) return null;
    if (config.override_prefill_enabled) config.override_prefill_text = substitute(config.override_prefill_text);
    config.prefill_gen_extra_prompt = substitute(config.prefill_gen_extra_prompt);
    return { ...config, type, original_prefill: typeof settings?.original_prefill === 'string' ? settings.original_prefill : '' };
}

function range(value, maximum) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(value);
    if (!match) throw new Error('Use a whole number or a range such as 2-5 in this prefill slot.');
    const low = Number(match[1]);
    const high = Number(match[2] ?? match[1]);
    if (low < 1 || high < low || high > maximum) throw new Error(`Prefill slot counts must be between 1 and ${maximum}.`);
    return [low, high];
}

function slotPattern(slot, names, newline) {
    const clean = slot.replace(/\|hint:[\s\S]*$/i, '').trim();
    const colon = clean.indexOf(':');
    const kind = (colon < 0 ? clean : clean.slice(0, colon)).toLowerCase();
    const value = colon < 0 ? '' : clean.slice(colon + 1);
    const words = (low, high, word = '[^\\s,<>]+') => `${word}(?:[ \\t]+${word}){${low - 1},${high - 1}}`;
    switch (kind) {
        case 'w': case 'words': return words(...range(value, 2000));
        case 'opt': case 'options': {
            const options = [...new Set(value.split(/[|,]/).map(value => value.trim()).filter(Boolean))];
            if (!options.length || options.length > 50) throw new Error('An options slot needs between 1 and 50 choices.');
            return `(?:${options.map(escape).join('|')})`;
        }
        case 're': case 'regex': {
            const pattern = value.replace(/^\/(.*)\/[a-z]*$/, '$1').replace(/^\^|\$$/g, '');
            if (!pattern || pattern.length > 1000) throw new Error('A regex slot needs a pattern of at most 1,000 characters.');
            // Local display matching is bounded by a server-side execution timeout.
            new RegExp(pattern);
            return `(?:${pattern})`;
        }
        case 'free': return '[\\s\\S]+?';
        case 'name': return names.length ? `(?:${names.map(escape).join('|')})` : '[A-Z][a-zA-Z-]*';
        case 'action': return words(1, 6, '[^\\s"<>]+');
        case 'thought': return words(1, 10, '[^\\s"<>]+');
        case 'emotion': case 'mood': return '(?:happy|sad|angry|afraid|nervous|excited|scared|confused|amused|annoyed|anxious|bored|calm|curious|desperate|disgusted|embarrassed|frustrated|grateful|guilty|hopeful|hurt|jealous|lonely|nostalgic|panicked|playful|proud|relieved|shy|smug|surprised|suspicious|tender|terrified|thoughtful|tired|uncomfortable|worried|flustered|melancholic|determined|fearful|content|bitter|affectionate|giddy|resigned|defiant|wistful|somber)';
        case 'line': case 'lines': {
            const [low, high] = range(value, 50);
            const line = `(?:(?!${newline})[^\\r\\n])+?`;
            return `${line}(?:${newline}${line}){${low - 1},${high - 1}}`;
        }
        case 'num': case 'number': {
            if (!value) return '-?[0-9]+';
            const match = /^(-?\d+)-(-?\d+)$/.exec(value);
            const low = Number(match?.[1]); const high = Number(match?.[2]);
            if (!match || !Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high < low || high - low > 1000) {
                throw new Error('A number slot needs a range containing at most 1,001 integers.');
            }
            return `(?:${Array.from({ length: high - low + 1 }, (_, index) => low + index).join('|')})`;
        }
        case 'keep': case 'end': case 'stop': case 'eos': return '';
        case 'pg': throw new Error('Enable the starter model and choose a connection profile to use [[pg]].');
        default: throw new Error(`Unknown prefill slot: ${kind}.`);
    }
}

/** Parse closing markers without eating the final ] in a regex character class. */
export function prefillParts(template) {
    const parts = []; let position = 0;
    while (position < template.length) {
        const start = template.indexOf('[[', position);
        if (start < 0) { parts.push({ text: template.slice(position) }); break; }
        if (start > position) parts.push({ text: template.slice(position, start) });
        let end = template.indexOf(']]', start + 2);
        if (end < 0) throw new Error('Close each prefill slot with ]].');
        while (template[end + 2] === ']') end++;
        parts.push({ slot: template.slice(start + 2, end) }); position = end + 2;
    }
    return parts;
}

export function compileStructuredPrefill(template, settings, names = [], { literal: literalTemplate = false, generated = '' } = {}) {
    const config = structuredPrefillSettings(settings);
    template = normalise(template);
    if (template.length > 16000 || config.anti_slop_ban_list.length > 4000) throw new Error('The prefill template or banned-word list is too long.');
    let token = config.newline_token;
    if (!token || token.includes('\n') || token.includes('\r') || template.includes(token) || generated.includes(token)) {
        token = '<NL>'; let index = 1;
        while (template.includes(token) || generated.includes(token)) token = `<NL${++index}>`;
    }
    if (token.length > 32) throw new Error('The newline marker must be at most 32 characters.');
    const newline = `(?:${escape(token)}|\\n)`;
    const literal = value => value.split('\n').map(escape).join(newline);
    let prefix = ''; let hidden = null; let ended = false;
    for (const part of literalTemplate ? [{ text: template }] : prefillParts(template)) {
        if (part.text !== undefined) prefix += literal(part.text);
        else if (/^(end|stop|eos)$/i.test(part.slot)) {
            ended = true;
            break;
        } else if (/^keep$/i.test(part.slot)) {
            hidden ??= prefix;
        } else if (/^pg$/i.test(part.slot)) {
            prefix += literal(normalise(generated));
        } else prefix += slotPattern(part.slot, names.filter(name => typeof name === 'string' && name), newline);
    }
    const banned = [...new Set(normalise(config.anti_slop_ban_list).split('\n').map(value => value.trim()).filter(Boolean))];
    const folded = value => [...value].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escape(char)).join('');
    const guard = banned.length ? `(?!(?:[\\s\\S])*(?:${banned.map(folded).join('|')}))` : '';
    const pattern = `^${guard}(?:${prefix})${ended ? '\\s*' : `[\\s\\S]{${config.min_chars_after_prefix},}`}$`;
    if (pattern.length > 32000) throw new Error('The compiled prefill pattern is too long.');
    const displayPattern = config.hide_prefill_in_display ? hidden ?? prefix : '';
    const hiddenTemplate = displayPattern ? displayPattern : null;
    return { token, pattern, prefix, hidden: hiddenTemplate, config };
}

export function structuredPrefillSchema(compiled) {
    return { name: 'structured_prefill', strict: true, value: { type: 'object',
        properties: { response: { type: 'string', pattern: compiled.pattern } }, required: ['response'], additionalProperties: false } };
}

/** A reply keeps its original prefix even after preferences or presets change. */
export function structuredPrefillDisplay(text, metadata) {
    if (metadata?.pending) return '';
    const prefix = metadata?.hidden_prefix;
    if (typeof prefix !== 'string' || !prefix) return text;
    if (text.startsWith(prefix)) return text.slice(prefix.length);
    const trimmed = prefix.trimStart();
    return trimmed && text.startsWith(trimmed) ? text.slice(trimmed.length) : text;
}
