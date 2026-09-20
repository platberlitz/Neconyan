import { getPresetManager } from './preset-manager.js';
import { extractJsonFromData, extractMessageFromData, getGenerateUrl, getRequestHeaders, name1, name2, normalizeContentText, substituteParams } from '../script.js';
import { getTextGenServer, createTextGenGenerationData, textgenerationwebui_settings } from './textgen-settings.js';
import { mergeTextPresetSettings } from './text-preset-request.js';
import { extractReasoningFromData } from './reasoning.js';
import { getInstructStoppingSequences } from './instruct-mode.js';
import { selected_group } from './group-chats.js';
import { power_user } from './power-user.js';
import { constructScopedTextPrompt, cleanScopedTextResponse } from './generation-format.js';
import { chat_completion_sources, getStreamingReply, tryParseStreamingError, createGenerationParameters, getNanoGptServiceTier, oai_settings } from './openai.js';
import EventSourceStream from './sse-stream.js';
import { fetchResumable } from './resumable-generation.js';
import { buildChatPresetPayload, createChatRequestData } from './chat-preset-request.js';
import { isGenerationLengthFinish } from './generation-request-controls.js';

// #region Type Definitions
/**
 * @typedef {Object} TextCompletionRequestBase
 * @property {boolean?} [stream=false] - Whether to stream the response
 * @property {number} max_tokens - Maximum number of tokens to generate
 * @property {string} [model] - Optional model name
 * @property {string} api_type - Type of API to use
 * @property {string} [api_server] - Optional API server URL
 * @property {number} [temperature] - Optional temperature parameter
 * @property {number} [min_p] - Optional min_p parameter
 */

/**
 * @typedef {Object} TextCompletionPayloadBase
 * @property {boolean?} [stream=false] - Whether to stream the response
 * @property {string} prompt - The text prompt for completion
 * @property {number} max_tokens - Maximum number of tokens to generate
 * @property {number} max_new_tokens - Alias for max_tokens
 * @property {string} [model] - Optional model name
 * @property {string} api_type - Type of API to use
 * @property {string} api_server - API server URL
 * @property {number} [temperature] - Optional temperature parameter
 */

/** @typedef {Record<string, any> & TextCompletionPayloadBase} TextCompletionPayload */

/**
 * @typedef {Object} ChatCompletionMessage
 * @property {string} [name] - The name of the message author (optional)
 * @property {string} role - The role of the message author (e.g., "user", "assistant", "system")
 * @property {string} content - The content of the message
 */

/**
 * @typedef {Object} ChatCompletionPayloadBase
 * @property {boolean?} [stream=false] - Whether to stream the response
 * @property {ChatCompletionMessage[]} messages - Array of chat messages
 * @property {string} [model] - Optional model name to use for completion
 * @property {string} chat_completion_source - Source provider
 * @property {number} max_tokens - Maximum number of tokens to generate
 * @property {number} [temperature] - Optional temperature parameter for response randomness
 * @property {string} [custom_url] - Optional custom URL
 * @property {string} [reverse_proxy] - Optional reverse proxy URL
 * @property {string} [proxy_password] - Optional proxy password
 * @property {string} [custom_prompt_post_processing] - Optional custom prompt post-processing
 * @property {import('../script.js').JsonSchema} [json_schema] - Optional JSON schema for structured generation
 */

/** @typedef {Record<string, any> & ChatCompletionPayloadBase} ChatCompletionPayload */

/**
 * @typedef {Object} ExtractedData
 * @property {string} content - Extracted content.
 * @property {string} reasoning - Extracted reasoning.
 */

/**
 * @typedef {Object} StreamResponse
 * @property {string} text - Generated text.
 * @property {string[]} swipes - Generated swipes
 * @property {Object} state - Generated state
 * @property {string?} [state.reasoning] - Generated reasoning
 * @property {string?} [state.image] - Generated image
 */

// #endregion

/**
 * Creates & sends a text completion request.
 */
export class TextCompletionService {
    static TYPE = 'textgenerationwebui';

    /**
     * Converts chat-style prompt messages into plain text without implicit object coercion.
     * @param {ChatCompletionMessage[]} prompt
     * @returns {string}
     */
    static flattenPromptMessages(prompt) {
        return prompt
            .map(message => normalizeContentText(message?.content))
            .join('\n\n');
    }

    /**
     * @param {Record<string, any> & TextCompletionRequestBase & {prompt: string}} custom
     * @returns {TextCompletionPayload}
     */
    static createRequestData({ stream = false, prompt, max_tokens, model, api_type, api_server, temperature, min_p, ...props }) {
        const payload = {
            stream,
            prompt,
            max_tokens,
            max_new_tokens: max_tokens,
            model,
            api_type,
            api_server: api_server ?? getTextGenServer(api_type),
            temperature,
            min_p,
            ...props,
        };

        // Remove undefined values to avoid API errors
        Object.keys(payload).forEach(key => {
            if (payload[key] === undefined) {
                delete payload[key];
            }
        });

        return payload;
    }

    /**
     * Sends a text completion request to the specified server
     * @param {TextCompletionPayload} data Request data
     * @param {boolean?} extractData Extract message from the response. Default true
     * @param {AbortSignal?} signal
     * @returns {Promise<ExtractedData | (() => AsyncGenerator<StreamResponse>)>} If not streaming, returns extracted data; if streaming, returns a function that creates an AsyncGenerator
     * @throws {Error}
     */
    static async sendRequest(data, extractData = true, signal = null) {
        if (data.service_tier === '') delete data.service_tier;
        if (!data.stream) {
            const response = await fetchResumable(getGenerateUrl(this.TYPE), {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(data),
                signal: signal ?? new AbortController().signal,
            });

            const json = await response.json();
            if (!response.ok || json.error) {
                const error = new Error(String(json.error?.message || json.error || 'Response not OK'));
                error.status = response.status;
                throw error;
            }

            if (!extractData) {
                return json;
            }

            return {
                content: extractMessageFromData(json, this.TYPE, { excludeReasoning: true }),
                reasoning: extractReasoningFromData(json, {
                    mainApi: this.TYPE,
                    textGenType: data.api_type,
                    ignoreShowThoughts: true,
                }),
                lengthLimited: isGenerationLengthFinish(json),
            };
        }

        const response = await fetchResumable('/api/backends/text-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify(data),
            signal: signal ?? new AbortController().signal,
        });

        if (!response.ok) {
            const text = await response.text();
            tryParseStreamingError(response, text, { quiet: true });

            const error = new Error(`Got response status ${response.status}`);
            error.status = response.status;
            throw error;
        }

        const eventStream = new EventSourceStream();
        response.body.pipeThrough(eventStream);
        const reader = eventStream.readable.getReader();
        return async function* streamData() {
            let text = '';
            const swipes = [];
            const state = { reasoning: '' };
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                if (value.data === '[DONE]') return;

                tryParseStreamingError(response, value.data, { quiet: true });

                let data = JSON.parse(value.data);

                if (data?.choices?.[0]?.index > 0) {
                    const swipeIndex = data.choices[0].index - 1;
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + data.choices[0].text;
                } else {
                    const newText = data?.choices?.[0]?.text || data?.content || '';
                    text += newText;
                    state.reasoning += data?.choices?.[0]?.reasoning ?? '';
                }

                yield { text, swipes, state };
            }
        };
    }

    /**
    * Return a formatted prompt string given an array of messages, a chosen instruct preset, and instruct settings.
    * @param {(ChatCompletionMessage & {ignoreInstruct?: boolean})[]} prompt An array of messages
    * @param {InstructSettings|string} instructPreset Either the name of an instruct preset or the instruct preset object itself.
    * @param {Partial<InstructSettings>} instructSettings Optional instruct settings
    */
    static constructPrompt(prompt, instructPreset, instructSettings) {
        // InstructPreset may either be a name or itself a preset
        if (typeof instructPreset === 'string') {
            const instructPresetManager = getPresetManager('instruct');
            instructPreset = instructPresetManager?.getCompletionPresetByName(instructPreset);
        }

        // Clone the preset to avoid modifying the original
        instructPreset = structuredClone(instructPreset);
        if (instructSettings) {  // apply any additional settings
            Object.assign(instructPreset, instructSettings);
        }

        return constructScopedTextPrompt(prompt, instructPreset ?? power_user.instruct, {
            name1, name2, selectedGroup: Boolean(selected_group), substitute: substituteParams,
        });
    }


    /**
     * Process and send a text completion request with optional preset & instruct
     * @param {TextCompletionPayload} requestData
     * @param {Object} options - Configuration options
     * @param {string?} [options.presetName] - Name of the preset to use for generation settings
     * @param {string?} [options.instructName] - Name of instruct preset for message formatting
     * @param {Partial<InstructSettings>?} [options.instructSettings] - Override instruct settings
     * @param {boolean} extractData - Whether to extract structured data from response
     * @param {AbortSignal?} [signal]
     * @returns {Promise<ExtractedData | (() => AsyncGenerator<StreamResponse>)>} If not streaming, returns extracted data; if streaming, returns a function that creates an AsyncGenerator
     * @throws {Error}
     */
    static async processRequest(requestData, options = {}, extractData = true, signal = null) {
        const { presetName, instructName } = options;

        // remove any undefined params in given request data
        requestData = this.createRequestData(requestData);

        /** @type {InstructSettings | undefined} */
        let instructPreset;
        const prompt = requestData.prompt;
        // Handle instruct formatting if requested
        if (Array.isArray(prompt)) {
            if (instructName) {
                const instructPresetManager = getPresetManager('instruct');
                instructPreset = instructPresetManager?.getCompletionPresetByName(instructName);
                if (instructPreset) {
                    requestData.prompt = this.constructPrompt(prompt, instructPreset, options.instructSettings);
                    const stoppingStrings = getInstructStoppingSequences({ customInstruct: instructPreset, useStopStrings: false });
                    requestData.stop = stoppingStrings;
                    requestData.stopping_strings = stoppingStrings;
                } else {
                    console.warn(`Instruct preset "${instructName}" not found, using basic formatting`);
                    requestData.prompt = this.flattenPromptMessages(prompt);
                }
            } else {
                requestData.prompt = this.flattenPromptMessages(prompt);
            }
        } else if (typeof prompt === 'string') {
            requestData.prompt = prompt;
        }

        // Apply generation preset if specified
        if (presetName) {
            const presetManager = getPresetManager(this.TYPE);
            if (presetManager) {
                const preset = presetManager.getCompletionPresetByName(presetName);
                if (preset) {
                    // Convert preset to payload and merge with custom data
                    requestData = this.presetToGeneratePayload(preset, {}, requestData);
                } else {
                    console.warn(`Preset "${presetName}" not found, continuing with default settings`);
                }
            } else {
                console.warn('Preset manager not found, continuing with default settings');
            }
        }

        const response = await this.sendRequest(requestData, extractData, signal);

        // Remove stopping strings from the end
        if (!requestData.stream && extractData) {
            /** @type {ExtractedData} */
            // @ts-ignore
            const extractedData = response;

            extractedData.content = cleanScopedTextResponse(extractedData.content, requestData.stopping_strings, instructPreset);
        }

        return response;
    }

    /**
     * Converts a preset to a valid text completion payload.
     * Only supports temperature.
     * @param {Object} preset - The preset configuration
     * @param {Object} overridePreset - Additional parameters to override preset values
     * @param {Object} overridePayload - Additional parameters to override payload values
     * @returns {Object} - Formatted payload for text completion API
     */
    static presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
        if (!preset || typeof preset !== 'object') {
            throw new Error('Invalid preset: must be an object');
        }

        // apply preset overrides
        preset = { ...preset, ...overridePreset };

        // Only take fields from the preset specified in setting_names to use as TextCompletionSettings
        const settings = mergeTextPresetSettings(textgenerationwebui_settings, preset, overridePayload);

        // Apply api_type from overridePayload to settings BEFORE createTextGenGenerationData
        // so that source-specific parameter construction uses the correct API type.
        // Without this, switching connection profiles corrupts the global textgenerationwebui_settings,
        // causing createTextGenGenerationData to build a mismatched payload.

        // convert to a generation payload
        const payload = createTextGenGenerationData(settings, overridePayload.model, overridePayload.prompt, preset.genamt);

        // apply overrides
        return this.createRequestData({ ...payload, ...overridePayload });
    }
}

/**
 * Creates & sends a chat completion request.
 */
export class ChatCompletionService {
    static TYPE = 'openai';

    /**
     * @param {ChatCompletionPayload} custom
     * @returns {ChatCompletionPayload}
     */
    static createRequestData(custom) {
        return createChatRequestData(custom);
    }

    /**
     * Sends a chat completion request
     * @param {ChatCompletionPayload} data Request data
     * @param {boolean?} extractData Extract message from the response. Default true
     * @param {AbortSignal?} signal Abort signal
     * @returns {Promise<ExtractedData | (() => AsyncGenerator<StreamResponse>)>} If not streaming, returns extracted data; if streaming, returns a function that creates an AsyncGenerator
     * @throws {Error}
     */
    static async sendRequest(data, extractData = true, signal = null) {
        delete data.__connectionProfileRequestFields;
        delete data.modelOverride;
        if (data.service_tier === '') delete data.service_tier;
        if (data.chat_completion_source === chat_completion_sources.NANOGPT && data.service_tier) {
            data.service_tier = await getNanoGptServiceTier({ ...data, nanogpt_service_tier: data.service_tier }, data.model);
        }
        const response = await fetchResumable('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify(data),
            signal: signal ?? new AbortController().signal,
        });

        if (!data.stream) {
            const json = await response.json();
            if (!response.ok || json.error) {
                const error = new Error(String(json.error?.message || json.error || 'Response not OK'));
                error.status = response.status;
                throw error;
            }

            if (!extractData) {
                return json;
            }

            const result = {
                content: extractMessageFromData(json, this.TYPE, { excludeReasoning: true }),
                reasoning: extractReasoningFromData(json, {
                    mainApi: this.TYPE,
                    textGenType: data.chat_completion_source,
                    ignoreShowThoughts: true,
                }),
                lengthLimited: isGenerationLengthFinish(json),
            };
            // Try parse JSON
            if (data.json_schema) {
                result.content = JSON.parse(extractJsonFromData(json, { mainApi: this.TYPE, chatCompletionSource: data.chat_completion_source }));
            }
            return result;
        }

        if (!response.ok) {
            const text = await response.text();
            tryParseStreamingError(response, text, { quiet: true });

            const error = new Error(`Got response status ${response.status}`);
            error.status = response.status;
            throw error;
        }

        const eventStream = new EventSourceStream();
        response.body.pipeThrough(eventStream);
        const reader = eventStream.readable.getReader();
        return async function* streamData() {
            let text = '';
            const swipes = [];
            const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                const rawData = value.data;
                if (rawData === '[DONE]') return;
                tryParseStreamingError(response, rawData, { quiet: true });
                const parsed = JSON.parse(rawData);

                const reply = getStreamingReply(parsed, state, {
                    chatCompletionSource: data.chat_completion_source,
                    overrideShowThoughts: true,
                });
                if (Array.isArray(parsed?.choices) && parsed?.choices?.[0]?.index > 0) {
                    const swipeIndex = parsed.choices[0].index - 1;
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + reply;
                } else {
                    text += reply;
                }

                yield { text, swipes: swipes, state };
            }
        };
    }

    /**
     * Process and send a chat completion request with optional preset
     * @param {ChatCompletionPayload} requestData - payload data, overriding preset if given
     * @param {Object} options - Configuration options
     * @param {string?} [options.presetName] - Name of the preset to use for generation settings
     * @param {boolean} [extractData=true] - Whether to extract structured data from response
     * @param {AbortSignal?} [signal] - Abort signal
     * @returns {Promise<ExtractedData | (() => AsyncGenerator<StreamResponse>)>} If not streaming, returns extracted data; if streaming, returns a function that creates an AsyncGenerator
     * @throws {Error}
     */
    static async processRequest(requestData, options, extractData = true, signal = null) {
        const { presetName } = options;
        requestData = this.createRequestData(requestData);

        // Apply generation preset if specified
        if (presetName) {
            const presetManager = getPresetManager(this.TYPE);
            if (presetManager) {
                const preset = presetManager.getCompletionPresetByName(presetName);
                if (preset) {
                    // Convert preset to payload and merge with custom parameters
                    requestData = await this.presetToGeneratePayload(preset, {}, requestData);
                } else {
                    console.warn(`Preset "${presetName}" not found, continuing with default settings`);
                }
            } else {
                console.warn('Preset manager not found, continuing with default settings');
            }
        }

        return await this.sendRequest(requestData, extractData, signal);
    }

    /**
     * Converts a preset to a valid chat completion payload
     * Only supports temperature.
     * @param {Object} preset - The preset configuration
     * @param {Object} overridePreset - Additional parameters to override preset values
     * @param {Object} overridePayload - Additional parameters to override payload values
     * @returns {Promise<any>} - Formatted payload for chat completion API
     */
    static async presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
        return this.createRequestData(await buildChatPresetPayload(oai_settings, preset, overridePreset, overridePayload, createGenerationParameters));
    }
}
