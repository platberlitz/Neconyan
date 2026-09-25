import { fail, hash } from '../mewmory/core.js';
import { providerStep, providerNotDispatched, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { setTimeout as wait } from 'node:timers/promises';
import { runBackendRequest } from '../endpoints/conversation-generation.js';
import { handleKoboldGenerate } from '../endpoints/backends/kobold.js';
import { handleNovelGenerate, handleNovelStatus } from '../endpoints/novelai.js';
import { handleHordeSubmit, handleHordeTaskStatus } from '../endpoints/horde.js';
import { encodeGenerationText } from '../endpoints/tokenizers.js';
import { resolveGenerationProfile } from './profiles.js';
import { cleanGeneratedText, createRawPrompt, extractMessageFromData, removePartialStops } from '../../public/scripts/generation-format.js';
import { resolveCustomStoppingStrings } from '../../public/scripts/chat-request-controls.js';

const novelTokenizer = model => model.includes('clio') ? 'nerdstash' : model.includes('kayra') ? 'nerdstash_v2'
    : model.includes('erato') ? 'llama3' : null;
const cleanupFields = ['collapse_newlines', 'allow_name1_display', 'allow_name2_display', 'disable_group_trimming',
    'auto_fix_generated_markdown', 'trim_spaces'];

async function pollHorde({ context, jobContext, key, taskId, cleanup, signal, fetch: fetchImpl, userName, characterName, groupNames, trimNames }) {
    const request = { user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} };
    for (let attempt = 0; attempt < 480; attempt++) {
        signal?.throwIfAborted();
        const status = await runBackendRequest(request, handleHordeTaskStatus, { taskId }, { signal, fetch: fetchImpl, boundProfile: true });
        if (status?.faulted || status?.is_possible === false) fail('The saved Horde task cannot finish.', 502);
        if (status?.done) {
            const rawText = status.generations?.[0]?.text;
            if (typeof rawText !== 'string' || !rawText.trim()) fail('Horde completed without a text result.', 502);
            const text = cleanGeneratedText(removePartialStops(rawText, cleanup.stops), { power: cleanup.power, mainApi: 'koboldhorde',
                name1: userName, name2: characterName, groupNames, trimNames, trimWrongNames: trimNames, displayIncompleteSentences: true });
            const result = { response: { text: rawText }, text, generation: { backend: 'horde', source: 'koboldhorde', showThoughts: false } };
            writeArtifact(context.directories, jobContext.job.id, 'horde-result:' + key, result);
            return result;
        }
        await wait(2500, undefined, { signal });
    }
    fail('The saved Horde task is still running. Check its status before retrying.', 504);
}

async function novelTokenControls(settings, model, stops, signal) {
    const tokenizer = novelTokenizer(model);
    if (!tokenizer) {
        if (stops.length || settings.banned_tokens || settings.logit_bias?.length) fail('This NovelAI model has no saved tokenizer for stopping strings or token controls.', 409);
        return {};
    }
    const encode = value => encodeGenerationText(tokenizer, value, model, signal);
    const stopSequences = await Promise.all(stops.slice(0, 1024).map(encode));
    const badWords = [];
    for (const line of String(settings.banned_tokens || '').split('\n')) {
        const value = line.trim();
        if (!value) continue;
        if (value.startsWith('[') && value.endsWith(']')) {
            let ids;
            try { ids = JSON.parse(value); } catch { fail('The saved NovelAI banned token list is invalid.', 409); }
            if (!Array.isArray(ids) || !ids.every(Number.isInteger)) fail('The saved NovelAI banned token list is invalid.', 409);
            badWords.push(ids);
        } else if (value.startsWith('{') && value.endsWith('}')) badWords.push(await encode(value.slice(1, -1)));
        else {
            for (const variant of new Set([value, ` ${value}`, value[0].toUpperCase() + value.slice(1), ` ${value[0].toUpperCase()}${value.slice(1)}`,
                value[0].toLowerCase() + value.slice(1), ` ${value[0].toLowerCase()}${value.slice(1)}`, value.toUpperCase(), ` ${value.toUpperCase()}`, value.toLowerCase(), ` ${value.toLowerCase()}`])) {
                badWords.push(await encode(variant));
            }
        }
    }
    const logitBias = [];
    for (const entry of settings.logit_bias || []) {
        if (typeof entry.text !== 'string' || !Number.isFinite(entry.value)) fail('The saved NovelAI token bias is invalid.', 409);
        const value = entry.text.trim();
        if (!value) continue;
        let sequence;
        if (value.startsWith('[') && value.endsWith(']')) {
            try { sequence = JSON.parse(value); } catch { fail('The saved NovelAI token bias is invalid.', 409); }
            if (!Array.isArray(sequence) || !sequence.every(Number.isInteger)) fail('The saved NovelAI token bias is invalid.', 409);
        } else sequence = await encode(value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : ` ${value}`);
        logitBias.push({ bias: entry.value, sequence, ensure_sequence_finish: false, generate_once: false });
    }
    return { stop_sequences: stopSequences, bad_words_ids: badWords, logit_bias_exp: logitBias };
}

/** Use the already-selected legacy controls and native handler; no browser-prepared provider request. */
export async function runLegacyProfile({ context, binding, messages, maxTokens, macroEnvironment,
    ephemeralStops = [], userName = 'User', characterName = 'Character', groupNames = [],
    signal, fetch: fetchImpl, jobContext, modelOverride = '', overridePayload = {}, rawOptions = {}, beforeDispatch, validatePrompt, stream = false, preparedText, cfgValues, onProviderStep, stepNamespace = '',
} = {}) {
    signal ||= jobContext?.signal;
    signal?.throwIfAborted();
    if (typeof stepNamespace !== 'string' || stepNamespace.length > 512) fail('The saved generation step identity is invalid.', 400);
    if (!Array.isArray(messages) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || modelOverride
        || Object.keys(overridePayload || {}).length || Object.keys(rawOptions || {}).some(key => !['instructOverride', 'quietToLoud', 'systemPrompt', 'prefill', 'trimNames'].includes(key))) {
        fail('This bound legacy request has unsupported controls.', 409);
    }
    if (stream) fail('This provider stream has no verified completion marker for a durable Roleplay reply.', 409);
    const key = hash({ binding, messages, maxTokens, ephemeralStops, userName, characterName, groupNames, rawOptions,
        ...(preparedText !== undefined ? { preparedText } : {}), ...(cfgValues ? { cfgValues } : {}), ...(stepNamespace ? { stepNamespace } : {}) });
    const resultName = 'horde-result:' + key;
    if (jobContext && binding?.backend === 'horde') {
        const completed = readArtifact(context.directories, jobContext.job.id, resultName);
        if (completed !== undefined) return completed;
        const known = readArtifact(context.directories, jobContext.job.id, 'provider:' + key);
        if (known !== undefined) {
            const cleanup = readArtifact(context.directories, jobContext.job.id, 'horde-cleanup:' + key);
            if (!cleanup || !/^[a-zA-Z0-9_-]{1,128}$/.test(known?.id)) fail('The saved Horde task needs recovery.', 409);
            return pollHorde({ context, jobContext, key, taskId: known.id, cleanup, signal, fetch: fetchImpl,
                userName, characterName, groupNames, trimNames: rawOptions.trimNames !== false });
        }
    }
    if (jobContext && binding?.backend !== 'horde') {
        const saved = readArtifact(context.directories, jobContext.job.id, 'provider:' + key);
        if (saved !== undefined) return saved;
    }
    const material = resolveGenerationProfile(context.directories, binding);
    if (!['kobold', 'novel', 'horde'].includes(material.backend) || material.backend !== binding.backend) fail('This provider cannot use the legacy request builder.', 409);
    const substitute = value => {
        if (macroEnvironment?.evaluate) return macroEnvironment.evaluate(value, { legacy: !material.power.experimental_macro_engine, strictCapabilities: true });
        if (String(value).includes('{{')) fail('This connection requires the captured chat macro context.', 400);
        return value;
    };
    const preparedName = 'legacy-request:' + key;
    const prepared = jobContext && readArtifact(context.directories, jobContext.job.id, preparedName);
    const stops = prepared?.stops ?? resolveCustomStoppingStrings(material.power, substitute, ephemeralStops).filter(Boolean);
    let prompt = prepared?.payload?.prompt ?? prepared?.payload?.input ?? preparedText ?? createRawPrompt(structuredClone(messages), material.backend, rawOptions.instructOverride, rawOptions.quietToLoud,
        rawOptions.systemPrompt, rawOptions.prefill, { instruct: material.power.instruct, context: material.power.context,
            name1: userName, name2: characterName, selectedGroup: groupNames.length > 0, substitute });
    const settings = material.active;
    let payload = prepared?.payload ?? { prompt, api_server: settings.api_server, gui_settings: settings.preset_settings === 'gui',
        max_length: maxTokens, max_context_length: material.contextLimit, streaming: false };
    if (!prepared && !payload.gui_settings) Object.assign(payload, {
        rep_pen: Number(settings.rep_pen), rep_pen_range: Number(settings.rep_pen_range), rep_pen_slope: Number(settings.rep_pen_slope),
        temperature: Number(settings.temp), tfs: Number(settings.tfs), top_a: Number(settings.top_a), top_k: Number(settings.top_k),
        top_p: Number(settings.top_p), min_p: Number(settings.min_p), typical: Number(settings.typical),
        sampler_order: settings.sampler_order || material.preset?.sampler_order, singleline: false,
        use_default_badwordsids: Boolean(settings.use_default_badwordsids), mirostat: Number(settings.mirostat),
        mirostat_tau: Number(settings.mirostat_tau), mirostat_eta: Number(settings.mirostat_eta),
        grammar: substitute(settings.grammar || ''), sampler_seed: Number(settings.seed) >= 0 ? Number(settings.seed) : undefined,
        ...(stops.length ? { stop_sequence: stops } : {}),
    });
    if (material.backend !== 'novel') payload.api_server = settings.api_server;
    const savePrepared = () => {
        if (!jobContext || prepared) return;
        const { api_server: _endpoint, ...saved } = payload;
        void _endpoint;
        writeArtifact(context.directories, jobContext.job.id, preparedName, { payload: saved, stops });
    };
    if (material.backend === 'horde') {
        if (!jobContext) fail('Horde needs a durable server job before submitting work.', 409);
        const { prompt: ignoredPrompt, api_server: ignoredServer, gui_settings: ignoredGui, streaming: ignoredStreaming, ...params } = payload;
        void ignoredPrompt; void ignoredServer; void ignoredGui; void ignoredStreaming;
        if (Object.values(params).some(value => typeof value === 'number' && !Number.isFinite(value))) fail('Save complete Horde sampler controls before generating.', 409);
        const cleanup = { stops, power: Object.fromEntries(cleanupFields.map(name => [name, material.power[name]])) };
        writeArtifact(context.directories, jobContext.job.id, 'horde-cleanup:' + key, cleanup);
        const request = { user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} };
        savePrepared();
        await validatePrompt?.(payload, material);
        await onProviderStep?.('provider:' + key);
        const submitted = await providerStep(jobContext, key, async () => {
            resolveGenerationProfile(context.directories, binding);
            try { await beforeDispatch?.(); } catch (error) { throw providerNotDispatched(error); }
            const response = await runBackendRequest(request, handleHordeSubmit, { prompt, params: { ...params, n: 1,
                frmtadsnsp: false, frmtrmblln: false, frmtrmspch: false, frmttriminc: false },
            trusted_workers: Boolean(material.horde.trusted_workers_only), models: material.horde.models },
            { signal, fetch: fetchImpl, boundProfile: true });
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(response?.id)) fail('Horde did not confirm a task ID.', 502);
            return { id: response.id };
        });
        return pollHorde({ context, jobContext, key, taskId: submitted.id, cleanup, signal, fetch: fetchImpl,
            userName, characterName, groupNames, trimNames: rawOptions.trimNames !== false });
    }
    if (material.backend === 'kobold' && Object.values(payload).some(value => typeof value === 'number' && !Number.isFinite(value))) {
        fail('Save complete Kobold sampler controls before generating.', 409);
    }
    const handler = material.backend === 'novel' ? handleNovelGenerate : handleKoboldGenerate;
    if (material.backend === 'novel' && !prepared) {
        const model = settings.model_novel;
        const erato = model.includes('erato');
        let maxLength = 150;
        if (erato || model.includes('kayra')) {
            const subscription = await runBackendRequest({ user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} },
                handleNovelStatus, { status: true }, { signal, fetch: fetchImpl, boundProfile: true });
            if (![1, 2, 3].includes(subscription?.tier)) fail('NovelAI did not confirm the account tier.', 409);
            if (subscription.tier === 3) maxLength = 250;
        }
        const legacyStops = erato ? [...stops, ...stops.filter(stop => stop.startsWith('\n')).flatMap(stop =>
            ['.', '!', '?', '*', '"', '_', '...', '."', '?"', '!"', '.*', ')'].map(prefix => prefix + stop))] : stops;
        const tokens = await novelTokenControls(settings, model, legacyStops, signal);
        const prefix = /clio|kayra|erato/.test(model) ? (prompt.slice(-1500).includes('}') ? 'special_instruct' : settings.prefix || '') : 'vanilla';
        if (erato) prompt = '<|startoftext|><|reserved_special_token81|>' + prompt;
        payload = { input: prompt, model, max_length: Math.min(maxTokens, maxLength), streaming: false, use_string: true,
            ...Object.fromEntries(['temperature', 'min_length', 'repetition_penalty', 'repetition_penalty_range', 'repetition_penalty_slope',
                'repetition_penalty_frequency', 'repetition_penalty_presence', 'top_a', 'top_p', 'top_k', 'min_p',
                'math1_temp', 'math1_quad', 'math1_quad_entropy_scale', 'typical_p', 'tail_free_sampling'].map(name => [name, Number(settings[name])])),
            mirostat_lr: settings.mirostat_lr == null ? undefined : Number(settings.mirostat_lr),
            mirostat_tau: settings.mirostat_tau == null ? undefined : Number(settings.mirostat_tau),
            phrase_rep_pen: settings.phrase_rep_pen, prefix, order: settings.order || material.preset?.order || [1, 5, 0, 2, 3, 4],
            cfg_scale: cfgValues?.guidanceScale?.value, generate_until_sentence: true, use_cache: false, return_full_text: false,
            num_logprobs: material.power.request_token_probabilities ? 10 : undefined, ...tokens };
    }
    savePrepared();
    await validatePrompt?.(payload, material);
    const call = async () => {
        resolveGenerationProfile(context.directories, binding);
        try { await beforeDispatch?.(); } catch (error) { throw providerNotDispatched(error); }
        const response = await runBackendRequest({ user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} },
            handler, payload, { signal, fetch: fetchImpl, boundProfile: true });
        const rawText = extractMessageFromData(response, material.source, { excludeReasoning: true });
        const text = cleanGeneratedText(removePartialStops(rawText, stops), { power: material.power, mainApi: material.source,
            name1: userName, name2: characterName, groupNames, trimNames: rawOptions.trimNames !== false,
            trimWrongNames: rawOptions.trimNames !== false, displayIncompleteSentences: true });
        if (!text) fail('No message generated.', 502);
        return { response, text, generation: { backend: material.backend, source: material.source, showThoughts: false } };
    };
    if (jobContext) await onProviderStep?.('provider:' + key);
    return jobContext ? providerStep(jobContext, key, call) : call();
}
