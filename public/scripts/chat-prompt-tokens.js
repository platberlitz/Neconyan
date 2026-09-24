/** Shared image allowance used by browser and native prompt budgeting. */
export function getChatImageTokenCost({ width, height }, quality = 'auto') {
    if (quality === 'low' || quality === 'auto' && width <= 512 && height <= 512) return 85;
    const scale = 2048 / Math.min(width, height);
    const scaledWidth = Math.round(width * scale);
    const scaledHeight = Math.round(height * scale);
    const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
    return 85 + 170 * Math.ceil(Math.round(scaledWidth * finalScale) / 512)
        * Math.ceil(Math.round(scaledHeight * finalScale) / 512);
}

/** Resolve the configured tokenizer from explicit saved connection settings. */
export function resolveChatTokenizerModel(oai_settings, { main_api = 'openai', textgen_settings = {}, model_list = [], openRouterModels = [] } = {}) {
    // Neconyan: both native OpenAI API modes use the selected model for token counting.
    if (['openai', 'openai_responses'].includes(oai_settings.chat_completion_source)) {
        return oai_settings.openai_model;
    }

    const turboTokenizer = 'gpt-3.5-turbo';
    const gpt4Tokenizer = 'gpt-4';
    const gpt4oTokenizer = 'gpt-4o';
    const gpt2Tokenizer = 'gpt2';
    const claudeTokenizer = 'claude';
    const llamaTokenizer = 'llama';
    const llama3Tokenizer = 'llama3';
    const mistralTokenizer = 'mistral';
    const yiTokenizer = 'yi';
    const gemmaTokenizer = 'gemma';
    const jambaTokenizer = 'jamba';
    const qwen2Tokenizer = 'qwen2';
    const commandRTokenizer = 'command-r';
    const commandATokenizer = 'command-a';
    const nemoTokenizer = 'nemo';
    const deepseekTokenizer = 'deepseek';

    if (oai_settings.chat_completion_source == 'azure_openai') {
        return oai_settings.azure_openai_model || turboTokenizer;
    }

    if (oai_settings.chat_completion_source == 'deepseek') {
        return deepseekTokenizer;
    }

    // And for OpenRouter (if not a site model, then it's impossible to determine the tokenizer)
    if (main_api == 'openai' && oai_settings.chat_completion_source == 'openrouter' && oai_settings.openrouter_model ||
        main_api == 'textgenerationwebui' && textgen_settings.type === 'openrouter' && textgen_settings.openrouter_model) {
        const model = main_api == 'openai'
            ? model_list.find(x => x.id === oai_settings.openrouter_model)
            : openRouterModels.find(x => x.id === textgen_settings.openrouter_model);

        if (model?.architecture?.tokenizer === 'Llama2') {
            return llamaTokenizer;
        } else if (model?.architecture?.tokenizer === 'Llama3') {
            return llama3Tokenizer;
        } else if (model?.architecture?.tokenizer === 'Mistral') {
            return mistralTokenizer;
        } else if (model?.architecture?.tokenizer === 'Yi') {
            return yiTokenizer;
        } else if (model?.architecture?.tokenizer === 'Gemini') {
            return gemmaTokenizer;
        } else if (model?.architecture?.tokenizer === 'Qwen') {
            return qwen2Tokenizer;
        } else if (model?.architecture?.tokenizer === 'Cohere') {
            if (model?.id && model?.id.includes('command-a')) {
                return commandATokenizer;
            }
            return commandRTokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-4o')) {
            return gpt4oTokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-4')) {
            return gpt4Tokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-3.5-turbo')) {
            return turboTokenizer;
        } else if (oai_settings.openrouter_model.includes('claude')) {
            return claudeTokenizer;
        } else if (oai_settings.openrouter_model.includes('GPT-NeoXT')) {
            return gpt2Tokenizer;
        } else if (oai_settings.openrouter_model.includes('jamba')) {
            return jambaTokenizer;
        } else if (oai_settings.openrouter_model.includes('deepseek')) {
            return deepseekTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == 'electronhub' && oai_settings.electronhub_model) {
        if (oai_settings.electronhub_model.includes('gpt-4o') || oai_settings.electronhub_model.includes('gpt-5')) {
            return gpt4oTokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-4.1') || oai_settings.electronhub_model.includes('gpt-4.5')) {
            return gpt4oTokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-4')) {
            return gpt4Tokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-3.5-turbo')) {
            return turboTokenizer;
        } else if (oai_settings.electronhub_model.includes('claude')) {
            return claudeTokenizer;
        } else if (oai_settings.electronhub_model.includes('jamba')) {
            return jambaTokenizer;
        } else if (oai_settings.electronhub_model.includes('deepseek') || oai_settings.electronhub_model.includes('sonar-reasoning') || oai_settings.electronhub_model.includes('r1')) {
            return deepseekTokenizer;
        } else if (oai_settings.electronhub_model.includes('qwen')) {
            return qwen2Tokenizer;
        } else if (oai_settings.electronhub_model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (oai_settings.electronhub_model.includes('mistral')) {
            return mistralTokenizer;
        } else if (oai_settings.electronhub_model.includes('yi')) {
            return yiTokenizer;
        } else if (oai_settings.electronhub_model.includes('llama3') || oai_settings.electronhub_model.includes('llama-3') || oai_settings.electronhub_model.startsWith('l3')) {
            return llama3Tokenizer;
        } else if (oai_settings.electronhub_model.includes('llama')) {
            return llamaTokenizer;
        } else if (oai_settings.electronhub_model.includes('command-a')) {
            return commandATokenizer;
        } else if (oai_settings.electronhub_model.includes('command-r')) {
            return commandRTokenizer;
        } else if (oai_settings.electronhub_model.includes('nemo')) {
            return nemoTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == 'chutes' && oai_settings.chutes_model) {
        const model = oai_settings.chutes_model.toLowerCase();

        if (model.includes('deepseek') || model.includes('mai-ds')) {
            return deepseekTokenizer;
        } else if (model.includes('qwen') || model.includes('qwq') || model.includes('tongyi') || model.includes('kimi')) {
            return qwen2Tokenizer;
        } else if (model.includes('llama') || model.includes('longcat') || model.includes('hermes')) {
            return llama3Tokenizer;
        } else if (model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (model.includes('nemo')) {
            return nemoTokenizer;
        } else if (model.includes('mistral')) {
            return mistralTokenizer;
        } else if (model.includes('gpt-oss')) {
            return gpt4oTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == 'minimax') {
        // MiniMax uses a proprietary tokenizer; fall back to a coarse OpenAI estimation.
        return 'gpt-3.5-turbo';
    }

    if (oai_settings.chat_completion_source == 'workers_ai' && oai_settings.workers_ai_model) {
        const model = oai_settings.workers_ai_model.toLowerCase();

        if (model.includes('deepseek')) {
            return deepseekTokenizer;
        } else if (model.includes('qwen') || model.includes('qwq') || model.includes('kimi')) {
            return qwen2Tokenizer;
        } else if (model.includes('llama-3') || model.includes('llama-4')) {
            return llama3Tokenizer;
        } else if (model.includes('llama')) {
            return llamaTokenizer;
        } else if (model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (model.includes('mistral')) {
            return mistralTokenizer;
        } else if (model.includes('phi')) {
            return turboTokenizer;
        } else if (model.includes('gpt-oss')) {
            return gpt4oTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == 'cohere') {
        if (oai_settings.cohere_model.includes('command-a')) {
            return commandATokenizer;
        }
        return commandRTokenizer;
    }

    if (oai_settings.chat_completion_source == 'makersuite') {
        return gemmaTokenizer;
    }

    if (oai_settings.chat_completion_source == 'vertexai') {
        return gemmaTokenizer;
    }

    if (oai_settings.chat_completion_source == 'ai21') {
        return jambaTokenizer;
    }

    if (oai_settings.chat_completion_source == 'claude') {
        return claudeTokenizer;
    }

    if (oai_settings.chat_completion_source == 'mistralai') {
        if (oai_settings.mistralai_model.includes('nemo') || oai_settings.mistralai_model.includes('pixtral')) {
            return nemoTokenizer;
        }
        return mistralTokenizer;
    }

    if (oai_settings.chat_completion_source == 'custom') {
        return oai_settings.custom_model;
    }

    if (oai_settings.chat_completion_source == 'linkapi') {
        // Mixed vendor list; the server-side tokenizer resolver maps the raw id by name.
        return oai_settings.linkapi_model;
    }

    if (oai_settings.chat_completion_source === 'perplexity') {
        if (oai_settings.perplexity_model.includes('sonar-reasoning') || oai_settings.perplexity_model.includes('r1-1776')) {
            return deepseekTokenizer;
        }
        if (oai_settings.perplexity_model.includes('llama-3') || oai_settings.perplexity_model.includes('llama3')) {
            return llama3Tokenizer;
        }
        if (oai_settings.perplexity_model.includes('llama')) {
            return llamaTokenizer;
        }
        if (oai_settings.perplexity_model.includes('mistral') || oai_settings.perplexity_model.includes('mixtral')) {
            return mistralTokenizer;
        }
    }

    if (oai_settings.chat_completion_source === 'groq') {
        if (oai_settings.groq_model.includes('qwen')) {
            return qwen2Tokenizer;
        }
        if (oai_settings.groq_model.includes('llama-3') || oai_settings.groq_model.includes('llama3')) {
            return llama3Tokenizer;
        }
        if (oai_settings.groq_model.includes('mistral') || oai_settings.groq_model.includes('mixtral')) {
            return mistralTokenizer;
        }
        if (oai_settings.groq_model.includes('gemma')) {
            return gemmaTokenizer;
        }
    }

    // Default to Turbo 3.5
    return turboTokenizer;
}
