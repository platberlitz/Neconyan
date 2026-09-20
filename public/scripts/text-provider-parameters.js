/** Text-provider payloads shared by saved server requests and the browser. */
export const textgen_types = {
    OOBA: 'ooba', MANCER: 'mancer', VLLM: 'vllm', APHRODITE: 'aphrodite', TABBY: 'tabby',
    KOBOLDCPP: 'koboldcpp', TOGETHERAI: 'togetherai', LLAMACPP: 'llamacpp', OLLAMA: 'ollama',
    INFERMATICAI: 'infermaticai', DREAMGEN: 'dreamgen', OPENROUTER: 'openrouter',
    FEATHERLESS: 'featherless', HUGGINGFACE: 'huggingface', GENERIC: 'generic',
};
const { OOBA, MANCER, VLLM, APHRODITE, TABBY, KOBOLDCPP, LLAMACPP, OLLAMA, INFERMATICAI, DREAMGEN, OPENROUTER, HUGGINGFACE } = textgen_types;
export const APHRODITE_DEFAULT_ORDER = ['dry', 'penalties', 'no_repeat_ngram', 'temperature', 'top_nsigma', 'top_p_top_k', 'top_a', 'min_p', 'tfs', 'eta_cutoff', 'epsilon_cutoff', 'typical_p', 'quadratic', 'xtc'];

export function isDynamicTemperatureSupported(settings) {
    return settings.dynatemp && [OOBA, MANCER, KOBOLDCPP, TABBY, LLAMACPP, APHRODITE].includes(settings.type);
}

export function replaceMacrosInList(str, substitute) {
    if (!str || typeof str !== 'string') return str;
    try {
        const array = JSON.parse(str);
        if (!Array.isArray(array)) throw new Error('Not an array');
        return JSON.stringify(array.map(value => substitute(value)));
    } catch {
        return str.split(',').map(value => substitute(value)).join(',');
    }
}

function toIntArray(string) {
    return string ? string.split(',').map(x => parseInt(x)).filter(x => !isNaN(x)) : [];
}

/** All runtime-dependent values are supplied by the caller, including tokenisation. */
export function createTextProviderParameters(settings, model, finalPrompt, maxTokens, {
    isImpersonate = false, isContinue = false, cfgValues = null, type = 'quiet',
    requestTokenProbabilities = false, contextLimit, apiServer, resolveStoppingStrings = () => [],
    tokenBans = { banned_tokens: '', banned_strings: [] }, logitBias,
    cachePrompt, substitute = value => value, random = Math.random,
} = {}) {
    const canMultiSwipe = !isContinue && !isImpersonate && type !== 'quiet';
    const dynatemp = isDynamicTemperatureSupported(settings);
    const { banned_tokens, banned_strings } = tokenBans;
    const jsonSchema = settings.json_schema && typeof settings.json_schema === 'object' && !Array.isArray(settings.json_schema)
        ? settings.json_schema_allow_empty || Object.keys(settings.json_schema).length > 0 ? settings.json_schema : undefined
        : undefined;
    let params = {
        'prompt': finalPrompt,
        'model': model,
        'max_new_tokens': maxTokens,
        'max_tokens': maxTokens,
        'logprobs': requestTokenProbabilities ? ([VLLM, INFERMATICAI].includes(settings.type) ? 5 : 10) : undefined,
        'temperature': dynatemp ? (settings.min_temp + settings.max_temp) / 2 : settings.temp,
        'top_p': settings.top_p,
        'typical_p': settings.typical_p,
        'typical': settings.typical_p,
        'sampler_seed': settings.seed >= 0 ? settings.seed : undefined,
        'min_p': settings.min_p,
        'repetition_penalty': settings.rep_pen,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'top_k': settings.top_k,
        'skew': settings.skew,
        'min_length': settings.type === OOBA ? settings.min_length : undefined,
        'minimum_message_content_tokens': settings.type === DREAMGEN ? settings.min_length : undefined,
        'min_tokens': settings.min_length,
        'num_beams': settings.type === OOBA ? settings.num_beams : undefined,
        'length_penalty': settings.type === OOBA ? settings.length_penalty : undefined,
        'early_stopping': settings.type === OOBA ? settings.early_stopping : undefined,
        'add_bos_token': settings.add_bos_token,
        'dynamic_temperature': dynatemp ? true : undefined,
        'dynatemp_low': dynatemp ? settings.min_temp : undefined,
        'dynatemp_high': dynatemp ? settings.max_temp : undefined,
        'dynatemp_range': dynatemp ? (settings.max_temp - settings.min_temp) / 2 : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'dry_allowed_length': settings.dry_allowed_length,
        'dry_multiplier': settings.dry_multiplier,
        'dry_base': settings.dry_base,
        'dry_sequence_breakers': replaceMacrosInList(settings.dry_sequence_breakers, substitute),
        'dry_penalty_last_n': settings.dry_penalty_last_n,
        'max_tokens_second': settings.max_tokens_second,
        'sampler_priority': settings.type === OOBA ? settings.sampler_priority : undefined,
        'samplers': settings.type === LLAMACPP ? settings.samplers : undefined,
        'stopping_strings': resolveStoppingStrings(),
        'stop': resolveStoppingStrings(),
        'truncation_length': contextLimit,
        'ban_eos_token': settings.ban_eos_token,
        'skip_special_tokens': settings.skip_special_tokens,
        'include_reasoning': settings.include_reasoning,
        'top_a': settings.top_a,
        'tfs': settings.tfs,
        'epsilon_cutoff': [OOBA, MANCER].includes(settings.type) ? settings.epsilon_cutoff : undefined,
        'eta_cutoff': [OOBA, MANCER].includes(settings.type) ? settings.eta_cutoff : undefined,
        'mirostat_mode': settings.mirostat_mode,
        'mirostat_tau': settings.mirostat_tau,
        'mirostat_eta': settings.mirostat_eta,
        'custom_token_bans': [APHRODITE, MANCER].includes(settings.type) ? toIntArray(banned_tokens) : banned_tokens,
        'banned_strings': banned_strings,
        'api_type': settings.type,
        'api_server': apiServer,
        'sampler_order': settings.type === KOBOLDCPP ? settings.sampler_order : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'top_n_sigma': settings.nsigma,
        'min_keep': settings.min_keep,
        'adaptive_target': settings.adaptive_target,
        'adaptive_decay': settings.adaptive_decay,
        parseSequenceBreakers: function () {
            try { return JSON.parse(this.dry_sequence_breakers); } catch {
                return typeof this.dry_sequence_breakers === 'string' ? this.dry_sequence_breakers.split(',') : undefined;
            }
        },
    };
    const nonAphroditeParams = {
        'rep_pen': settings.rep_pen,
        'rep_pen_range': settings.rep_pen_range,
        'repetition_decay': settings.type === TABBY ? settings.rep_pen_decay : undefined,
        'repetition_penalty_range': settings.rep_pen_range,
        'encoder_repetition_penalty': settings.type === OOBA ? settings.encoder_rep_pen : undefined,
        'no_repeat_ngram_size': settings.type === OOBA ? settings.no_repeat_ngram_size : undefined,
        'penalty_alpha': settings.type === OOBA ? settings.penalty_alpha : undefined,
        'temperature_last': [OOBA, APHRODITE, TABBY].includes(settings.type) ? settings.temperature_last : undefined,
        'speculative_ngram': settings.type === TABBY ? settings.speculative_ngram : undefined,
        'do_sample': settings.type === OOBA ? settings.do_sample : undefined,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'guidance_scale': cfgValues?.guidanceScale?.value ?? settings.guidance_scale ?? 1,
        'negative_prompt': cfgValues?.negativePrompt ?? substitute(settings.negative_prompt) ?? '',
        'grammar_string': settings.grammar_string || undefined,
        'json_schema': [TABBY, LLAMACPP].includes(settings.type) ? jsonSchema : undefined,
        'repeat_penalty': settings.rep_pen,
        'repeat_last_n': settings.rep_pen_range,
        'n_predict': maxTokens,
        'num_predict': maxTokens,
        'num_ctx': contextLimit,
        'mirostat': settings.mirostat_mode,
        'ignore_eos': settings.ban_eos_token,
        'n_probs': requestTokenProbabilities ? 10 : undefined,
        'rep_pen_slope': settings.rep_pen_slope,
    };
    const vllmParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'ignore_eos': settings.ignore_eos_token,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
    };
    const aphroditeParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'repetition_penalty': settings.rep_pen,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'stop': resolveStoppingStrings(),
        'temperature': dynatemp ? (settings.min_temp + settings.max_temp) / 2 : settings.temp,
        'temperature_last': settings.temperature_last,
        'top_p': settings.top_p,
        'top_k': settings.top_k,
        'top_a': settings.top_a,
        'min_p': settings.min_p,
        'tfs': settings.tfs,
        'eta_cutoff': settings.eta_cutoff,
        'epsilon_cutoff': settings.epsilon_cutoff,
        'typical_p': settings.typical_p,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'ignore_eos': settings.ignore_eos_token,
        'min_tokens': settings.min_length,
        'skip_special_tokens': settings.skip_special_tokens,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'guided_grammar': settings.grammar_string || undefined,
        'guided_json': jsonSchema || undefined,
        'early_stopping': false,
        'include_stop_str_in_output': false,
        'dynatemp_min': dynatemp ? settings.min_temp : undefined,
        'dynatemp_max': dynatemp ? settings.max_temp : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'custom_token_bans': toIntArray(banned_tokens),
        'no_repeat_ngram_size': settings.no_repeat_ngram_size,
        'sampler_priority': settings.type === APHRODITE && JSON.stringify(settings.samplers_priorities) !== JSON.stringify(APHRODITE_DEFAULT_ORDER) ? settings.samplers_priorities : undefined,
    };
    if (settings.type === OPENROUTER) {
        params.provider = settings.openrouter_providers;
        params.service_tier = settings.openrouter_service_tier || undefined;
        params.quantizations = settings.openrouter_quantizations;
        params.allow_fallbacks = settings.openrouter_allow_fallbacks;
    }
    if (settings.type === KOBOLDCPP) {
        params.grammar = settings.grammar_string || undefined;
        params.grammar_retain_state = settings.grammar_string && !!isContinue ? true : undefined;
        params.trim_stop = true;
        params.dry_sequence_breakers = params.parseSequenceBreakers();
    }
    if (settings.type === HUGGINGFACE) {
        params.top_p = Math.min(Math.max(Number(params.top_p), 0.0), 0.999);
        params.stop = Array.isArray(params.stop) ? params.stop.slice(0, 4) : [];
        nonAphroditeParams.seed = settings.seed >= 0 ? settings.seed : Math.floor(random() * Math.pow(2, 32));
    }
    if (settings.type === MANCER) {
        params.n = canMultiSwipe ? settings.n : 1;
        params.epsilon_cutoff /= 1000;
        params.eta_cutoff /= 1000;
        params.dynatemp_mode = params.dynamic_temperature ? 1 : 0;
        params.dynatemp_min = params.dynatemp_low;
        params.dynatemp_max = params.dynatemp_high;
        delete params.dynatemp_low;
        delete params.dynatemp_high;
        params.dry_sequence_breakers = params.parseSequenceBreakers();
    }
    if ([TABBY, LLAMACPP].includes(settings.type)) params.n = canMultiSwipe ? settings.n : 1;
    switch (settings.type) {
        case VLLM:
        case INFERMATICAI:
            Object.assign(params, vllmParams);
            break;
        case APHRODITE:
            Object.assign(params, aphroditeParams);
            break;
        default:
            Object.assign(params, nonAphroditeParams);
            break;
    }
    if (Array.isArray(settings.logit_bias) && settings.logit_bias.length) params.logit_bias = logitBias;
    if ([LLAMACPP, OLLAMA].includes(settings.type)) {
        const logitBiasArray = params.logit_bias && typeof params.logit_bias === 'object' ? Object.entries(params.logit_bias).map(([key, value]) => [Number(key), value]) : [];
        logitBiasArray.push(...toIntArray(banned_tokens).map(x => [Number(x), false]));
        const sequenceBreakers = params.parseSequenceBreakers();
        Object.assign(params, { logit_bias: logitBiasArray, grammar: settings.grammar_string, dry_sequence_breakers: sequenceBreakers });
        if (!Array.isArray(sequenceBreakers) || sequenceBreakers.length === 0) delete params.dry_sequence_breakers;
    }
    if (cachePrompt !== undefined) params.cache_prompt = cachePrompt;
    if ([LLAMACPP, APHRODITE].includes(settings.type)) {
        if (jsonSchema) {
            delete params.grammar_string;
            delete params.grammar;
            delete params.guided_grammar;
        } else {
            delete params.json_schema;
            delete params.guided_json;
        }
    }
    return params;
}
