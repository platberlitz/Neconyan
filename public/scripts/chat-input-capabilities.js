/** Shared saved-connection input capabilities; no browser state is read here. */
export function bindChatInputSettings(settings, source, model) {
    const result = { ...settings, chat_completion_source: source ?? settings.chat_completion_source };
    if (typeof model === 'string') {
        for (const key of Object.keys(result)) if (key.endsWith('_model')) result[key] = model;
        result[`${result.chat_completion_source}_model`] = model;
        if (result.chat_completion_source === 'openai_responses') result.openai_model = model;
        if (result.chat_completion_source === 'makersuite') result.google_model = model;
    }
    return result;
}

export function supportsChatSignatures(settings) {
    return ['vertexai', 'makersuite'].includes(settings.chat_completion_source)
        || settings.chat_completion_source === 'openrouter' && /google\/gemini/i.test(settings.openrouter_model);
}

export function validFunctionTools(tools) {
    return Array.isArray(tools) && tools.length <= 128 && new Set(tools.map(tool => tool?.function?.name)).size === tools.length
        && tools.every(tool => tool?.type === 'function' && tool.function && typeof tool.function === 'object'
            && typeof tool.function.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)
            && (tool.function.description === undefined || typeof tool.function.description === 'string')
            && (tool.function.strict === undefined || typeof tool.function.strict === 'boolean')
            && tool.function.parameters?.type === 'object' && !Array.isArray(tool.function.parameters)
            && Object.keys(tool).every(key => ['type', 'function'].includes(key))
            && Object.keys(tool.function).every(key => ['name', 'description', 'parameters', 'strict'].includes(key)));
}

/** Select only reasoning belonging to the active tool chain or latest user turn. */
export function selectToolHistoryReasoning(messages, index, lastUser, mode) {
    if (!['active_chain', 'since_last_user'].includes(mode) || index <= lastUser) return '';
    for (let previous = index - 1; previous > lastUser; previous--) {
        const message = messages[previous];
        if (mode === 'active_chain' && (message?.role === 'tool'
            || message?.role === 'assistant' && Array.isArray(message.invocations))) continue;
        const assistant = message?.role === 'assistant' && !Array.isArray(message.invocations)
            && typeof message.content === 'string' && message.content.trim();
        if (mode === 'active_chain') return assistant ? String(message.reasoning ?? '') : '';
        if (assistant && message.reasoning) return String(message.reasoning);
    }
    return '';
}

export function supportsChatImages(oai_settings, { main_api = 'openai', model_list = [] } = {}) {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    // gultra just isn't being offered as multimodal, thanks google.
    const visionSupportedModels = [
        // OpenAI
        'chatgpt-4o-latest',
        'gpt-4-turbo',
        'gpt-4-vision',
        'gpt-4.1',
        'gpt-4.5-preview',
        'gpt-4o',
        'gpt-5',
        'gpt-6-astra', // Neconyan: Astra supports image input in both native OpenAI API modes.
        'o1',
        'o3',
        'o4-mini',
        // Claude
        'claude-3',
        'claude-fable', // Neconyan: claude-fable-5 vision support
        'claude-opus-5', // Neconyan: claude-opus-5 vision support
        'claude-sonnet-5', // Neconyan: claude-sonnet-5 vision support
        'claude-opus-4',
        'claude-sonnet-4',
        'claude-haiku-4',
        // Cohere
        'c4ai-aya-vision',
        'command-a-vision',
        // Google AI Studio
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'learnlm',
        'gemini-robotics',
        // MistralAI
        'mistral-small-2503',
        'mistral-small-2506',
        'mistral-small-latest',
        'mistral-medium-latest',
        'mistral-medium-2505',
        'mistral-medium-2508',
        'pixtral',
        // xAI (Grok)
        'grok-4',
        'grok-2-vision',
        // Moonshot
        'moonshot-v1-8k-vision-preview',
        'moonshot-v1-32k-vision-preview',
        'moonshot-v1-128k-vision-preview',
        'kimi-k2.5',
        'kimi-latest',
        // Z.AI (GLM)
        'glm-5.3-flash',
        'glm-5v-turbo',
        'glm-4.5v',
        'glm-4.6v',
        'autoglm-phone',
        // SiliconFlow
        'Qwen/Qwen3-VL-32B-Instruct',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'zai-org/GLM-4.5V',
    ];

    switch (oai_settings.chat_completion_source) {
        case 'openai':
        case 'openai_responses':
        case 'azure_openai': {
            const modelToCheck = oai_settings.chat_completion_source === 'azure_openai'
                ? oai_settings.azure_openai_model
                : oai_settings.openai_model;
            return visionSupportedModels.some(model =>
                modelToCheck.includes(model)
                && ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some(x => !modelToCheck.includes(x)),
            );
        }
        case 'makersuite':
            return visionSupportedModels.some(model => oai_settings.google_model.includes(model));
        case 'vertexai':
            return visionSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case 'claude':
            return visionSupportedModels.some(model => oai_settings.claude_model.includes(model));
        case 'openrouter':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('image'));
        case 'custom':
            return true;
        case 'mistralai':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.mistralai_model)?.capabilities?.vision);
        case 'cohere':
            return visionSupportedModels.some(model => oai_settings.cohere_model.includes(model));
        case 'minimax':
            return oai_settings.minimax_model === 'MiniMax-M3';
        case 'xai':
            // TODO: xAI's /models endpoint doesn't return modality info
            return visionSupportedModels.some(model => oai_settings.xai_model.includes(model));
        case 'aimlapi':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.aimlapi_model)?.features?.includes('openai/chat-completion.vision'));
        case 'chutes':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.chutes_model)?.input_modalities?.includes('image'));
        case 'electronhub':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.electronhub_model)?.metadata?.vision);
        case 'pollinations':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.pollinations_model)?.input_modalities?.includes('image'));
        case 'cometapi':
            return true;
        case 'moonshot':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.moonshot_model)?.supports_image_in);
        case 'nanogpt':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.nanogpt_model)?.capabilities?.vision);
        case 'zai':
            return visionSupportedModels.some(model => oai_settings.zai_model.includes(model));
        case 'linkapi':
            return visionSupportedModels.some(model => oai_settings.linkapi_model.includes(model));
        case 'siliconflow':
            return visionSupportedModels.some(model => oai_settings.siliconflow_model.includes(model));
        case 'workers_ai': {
            const waiModel = Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.workers_ai_model);
            return Boolean(waiModel && Array.isArray(waiModel.properties) && waiModel.properties.some(p => p.property_id === 'vision' && p.value === 'true'));
        }
        default:
            return false;
    }
}

export function supportsChatVideo(oai_settings, { main_api = 'openai', model_list = [] } = {}) {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const videoSupportedModels = [
        // Gemini
        'gemini-2.0',
        'gemini-2.5',
        'gemini-exp-1206',
        'gemini-3',
        // Z.AI (GLM)
        'glm-5.3-flash',
        'glm-5v-turbo',
        'glm-4.5v',
        'glm-4.6v',
    ];

    switch (oai_settings.chat_completion_source) {
        case 'makersuite':
            return videoSupportedModels.some(model => oai_settings.google_model.includes(model));
        case 'vertexai':
            return videoSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case 'minimax':
            return oai_settings.minimax_model === 'MiniMax-M3';
        case 'openrouter':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('video'));
        case 'zai':
            return videoSupportedModels.some(model => oai_settings.zai_model.includes(model));
        case 'linkapi':
            return videoSupportedModels.some(model => oai_settings.linkapi_model.includes(model));
        default:
            return false;
    }
}

export function supportsChatAudio(oai_settings, { main_api = 'openai', model_list = [] } = {}) {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const audioSupportedModels = [
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'gpt-4o-audio',
        'gpt-4o-realtime',
        'gpt-4o-mini-audio',
        'gpt-4o-mini-realtime',
        'gpt-audio',
        'gpt-realtime',
    ];

    switch (oai_settings.chat_completion_source) {
        case 'openai':
        case 'openai_responses':
            return audioSupportedModels.some(model => oai_settings.openai_model.includes(model));
        case 'makersuite':
            return audioSupportedModels.some(model => oai_settings.google_model.includes(model));
        case 'vertexai':
            return audioSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case 'openrouter':
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('audio'));
        case 'custom':
            return true;
        default:
            return false;
    }
}

export function supportsChatTools(settings, model, { main_api = 'openai', model_list = [] } = {}) {
    if (main_api !== 'openai' || !settings.function_calling) {
        return false;
    }

    // Neconyan: Astra supports tool calls only through the Responses API.
    if (settings.chat_completion_source === 'openai' && model === 'gpt-6-astra') {
        return false;
    }

    // Post-processing will forcefully remove past tool calls from the prompt, making them useless
    const allowedPromptPostProcessing = ['', 'merge_tools', 'semi_tools', 'strict_tools'];
    if (!allowedPromptPostProcessing.includes(settings.custom_prompt_post_processing)) {
        return false;
    }

    const currentModel = Array.isArray(model_list) ? model_list.find(m => m.id === model) : null;
    if (currentModel) {
        switch (settings.chat_completion_source) {
            case 'pollinations':
                return currentModel.tools;
            case 'fireworks':
                return currentModel.supports_tools;
            case 'openrouter':
                return currentModel.supported_parameters?.includes('tools');
            case 'mistralai':
                return currentModel.capabilities?.function_calling;
            case 'aimlapi':
                return currentModel.features?.includes('openai/chat-completion.function');
            case 'chutes':
                return currentModel.supported_features?.includes('tools');
            case 'electronhub':
                return currentModel.metadata?.function_call;
            case 'workers_ai':
                return Array.isArray(currentModel.properties) && currentModel.properties.some(p => p.property_id === 'function_calling' && p.value === 'true');
        }
    }

    const supportedSources = [
        'openai',
        'custom',
        'mistralai',
        'claude',
        'openrouter',
        'aimlapi',
        'groq',
        'cohere',
        'deepseek',
        'makersuite',
        'vertexai',
        'ai21',
        'xai',
        'pollinations',
        'moonshot',
        'fireworks',
        'cometapi',
        'chutes',
        'electronhub',
        'azure_openai',
        'zai',
        'siliconflow',
        'nanogpt',
        'workers_ai',
        'minimax',
        'linkapi',
    ];
    return supportedSources.includes(settings.chat_completion_source);
}
