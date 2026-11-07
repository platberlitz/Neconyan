import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { Script } from 'node:vm';
import fetch, { Response } from 'node-fetch';
import { compileStructuredPrefill, structuredPrefillRequest, structuredPrefillSchema } from '../public/scripts/structured-prefill.js';
import { abortOnRequestClose } from './util.js';
import { normalisePrefillReply } from './structured-prefill-formats.js';

/** Decode a JSON string incrementally, including escapes split across network frames. */
export function createPrefillDecoder(compiled, overlap = '') {
    let header = ''; let stage = 'header'; let escape = ''; let tail = ''; let pending = ''; let content = '';
    let emitted = ''; let hiddenPrefix = ''; let prefixComplete = !compiled.hidden;
    let rawContent = ''; let verification = 'streaming';
    const validator = new Script(`new RegExp(${JSON.stringify(compiled.pattern)}).test(text)`);
    const matcher = compiled.hidden ? new Script(`(() => {
        const match = new RegExp(${JSON.stringify(`^(?:${compiled.prefix})`)}).exec(text);
        return match && { length: match[0].length, hidden: new RegExp(${JSON.stringify(`^(?:${compiled.hidden})`)}).exec(match[0])?.[0] ?? '' };
    })()`) : null;
    let lastMatchLength = -1;
    const decode = value => {
        rawContent += value;
        pending += value;
        let result = '';
        while (pending) {
            if (pending.startsWith(compiled.token)) { result += '\n'; pending = pending.slice(compiled.token.length); } else if (compiled.token.startsWith(pending)) break;
            else { result += pending[0]; pending = pending.slice(1); }
        }
        content += result;
    };
    const snapshot = final => {
        if (final) { content += pending; pending = ''; }
        if (content.length > 2 * 1024 * 1024) throw new Error('The structured reply exceeds the 2 MB limit.');
        if (!prefixComplete && (final || content.length > lastMatchLength)) {
            // Prefixes are small; never run a template against the entire growing reply.
            const start = content.slice(0, 32000);
            lastMatchLength = content.length;
            let match;
            try { match = matcher.runInNewContext({ text: start }, { timeout: 25 }); } catch { throw new Error('The prefill pattern is too costly to match. Simplify its regex slots or turn off prefix hiding.'); }
            if (match && (final || match.length < start.length)) {
                hiddenPrefix = match.hidden;
                prefixComplete = true;
            } else if (final || start.length === 32000) prefixComplete = true;
        }
        let text = content;
        if (compiled.config.remove_prefill_from_history && !overlap) {
            text = prefixComplete ? content.slice(hiddenPrefix.length) : '';
        }
        if (overlap) {
            if (content.length < overlap.length && overlap.startsWith(content)) text = '';
            else if (content.startsWith(overlap)) text = content.slice(overlap.length);
            else throw new Error('The provider did not return the requested Continue overlap. The saved reply was not changed.');
        }
        const delta = text.slice(emitted.length); emitted = text;
        return { text: delta, metadata: { ...compiled.context, applied: true, accepted: true, verification,
            hidden_prefix: overlap || compiled.config.remove_prefill_from_history ? '' : hiddenPrefix,
            history_removed: Boolean(compiled.config.remove_prefill_from_history && hiddenPrefix && !overlap),
            pending: !prefixComplete, continuation: Boolean(overlap) } };
    };
    return {
        push(value) {
            for (const char of String(value)) {
                if (stage === 'header') {
                    header += char;
                    if (/^\s*\{\s*"response"\s*:\s*"$/.test(header)) stage = 'string';
                    else if (header.length > 256) throw new Error('The provider did not return the Structured Prefill response format.');
                } else if (stage === 'tail') {
                    tail += char;
                    if (tail.length > 256) throw new Error('The provider returned unexpected data after the structured reply.');
                } else if (escape) {
                    escape += char;
                    if (escape === '\\u' || escape.startsWith('\\u') && escape.length < 6) continue;
                    try { decode(JSON.parse(`"${escape}"`)); } catch { throw new Error('The provider returned an invalid JSON escape.'); }
                    escape = '';
                } else if (char === '\\') escape = char;
                else if (char === '"') stage = 'tail';
                else if (char.charCodeAt(0) < 32) throw new Error('The provider returned invalid structured text.');
                else decode(char);
            }
            return snapshot(false);
        },
        finish({ partial = false } = {}) {
            if (!partial && (stage !== 'tail' || !/^\s*}\s*$/.test(tail))) throw new Error('The provider ended an incomplete Structured Prefill response.');
            verification = 'incomplete';
            if (!partial) {
                try { verification = validator.runInNewContext({ text: rawContent }, { timeout: 25 }) ? 'matched' : 'mismatch'; } catch { verification = 'unchecked'; }
            }
            return snapshot(true);
        },
        partial({ invalid = false } = {}) {
            verification = invalid ? 'invalid' : 'incomplete';
            prefixComplete = true;
            return snapshot(true);
        },
    };
}

async function generatedStarter(request, config, messages) {
    if (!config.prefill_gen_enabled || !config.prefill_gen_profile_id) throw new Error('Choose a starter model connection profile to use [[pg]].');
    const [{ captureChatProfile }, { runChatProfile }] = await Promise.all([import('./generation/profiles.js'), import('./generation/service.js')]);
    const controller = new AbortController();
    const cancel = abortOnRequestClose(request, controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('The starter model timed out.')); }, config.prefill_gen_timeout_ms);
    try {
        const prompt = structuredClone(messages);
        if (config.prefill_gen_extra_prompt) prompt.push({ role: config.prefill_gen_extra_prompt_role === 'user' ? 'user' : 'system', content: config.prefill_gen_extra_prompt });
        const result = await runChatProfile({ context: { owner: request.user.profile.handle, directories: request.user.directories },
            binding: { kind: 'profile', ...captureChatProfile(request.user.directories, config.prefill_gen_profile_id) }, messages: prompt,
            maxTokens: config.prefill_gen_max_tokens, signal: controller.signal, fetch: request.fetch,
            ephemeralStops: config.prefill_gen_stop.split('\n').filter(Boolean), generationType: 'quiet' });
        if (result.outcome || !result.text) throw new Error('The starter model returned no usable text.');
        const matched = result.response?.matched_stop ?? result.response?.choices?.[0]?.matched_stop;
        return result.text + (config.prefill_gen_keep_matched_stop_string && typeof matched === 'string' ? matched : '');
    } catch (error) {
        if (cancel.isAborted && !timedOut) throw Object.assign(new Error('The starter request was cancelled.'), { code: 'PREFILL_CANCELLED' });
        throw error;
    } finally { clearTimeout(timer); cancel.cleanup(); }
}

/** Prepare once at the shared backend boundary, before provider-specific formatting. */
export async function prepareStructuredPrefill(request) {
    const body = request.body;
    const config = structuredPrefillRequest(body, body.structured_prefill, body.structured_prefill?.type);
    delete body.structured_prefill;
    if (!config || !Array.isArray(body.messages)) return;
    const messages = structuredClone(body.messages);
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role === 'system') index--;
    const last = messages[index];
    const continuing = config.type === 'continue';
    const historyTail = last?.role === 'assistant' && config.last_assistant !== null && last.content === config.last_assistant && last.content !== config.original_prefill;
    const fieldPrefill = typeof body.assistant_prefill === 'string' ? body.assistant_prefill : '';
    let template = config.override_prefill_enabled && !continuing ? config.override_prefill_text
        : !historyTail && last?.role === 'assistant' && typeof last.content === 'string' ? last.content : fieldPrefill;
    if (continuing && last?.role === 'assistant') template = last.content;
    if (!template) return;
    let overlap = '';
    if (continuing) {
        if (last?.role !== 'assistant' || typeof last.content !== 'string') return;
        overlap = config.continue_overlap_chars ? [...last.content].slice(-config.continue_overlap_chars).join('') : '';
        template = overlap;
    } else {
        if (!historyTail && last?.role === 'assistant' && (!config.override_prefill_enabled || last.content === config.original_prefill)) messages.splice(index, 1);
        for (const name of [body.char_name, ...(Array.isArray(body.group_names) ? body.group_names : [])]) {
            if (name && template.startsWith(`${name}: `)) { template = template.slice(name.length + 2); break; }
        }
    }
    const warnings = [];
    let generated = '';
    if (!continuing && template.includes('[[pg]]')) {
        try { generated = await generatedStarter(request, config, messages); } catch (error) {
            if (error.code === 'PREFILL_CANCELLED' || request.aborted || request.generationSignal?.aborted) throw error;
            warnings.push('The starter model failed. The main reply continued with an empty [[pg]] slot.');
        }
    }
    const compiled = compileStructuredPrefill(template, { ...config, ...(continuing ? { hide_prefill_in_display: false, remove_prefill_from_history: false } : {}) },
        [body.user_name, body.char_name, ...(Array.isArray(body.group_names) ? body.group_names : [])], { literal: continuing, generated });
    compiled.context = { source: body.chat_completion_source, model: body.model, method: config.output_method,
        prefill_source: continuing ? 'continue' : config.override_prefill_enabled ? 'template' : fieldPrefill === template ? 'assistant_prefill' : 'assistant message', warnings };
    body.messages = messages;
    if (fieldPrefill && !continuing) delete body.assistant_prefill;
    request.structuredPrefill = true;
    if (config.output_method === 'instructions') {
        messages.push({ role: 'system', content: 'Return only a JSON object with one string field named "response", without markdown fences. '
            + `The response must match this JSON schema: ${JSON.stringify(structuredPrefillSchema(compiled).value)}. `
            + `Use ${JSON.stringify(compiled.token)} for line breaks inside the response. Follow the pattern and then continue the reply.` });
    } else body.json_schema = structuredPrefillSchema(compiled);
    const send = request.fetch || fetch;
    request.fetch = async (...args) => {
        const outgoing = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null;
        const schema = outgoing?.response_format?.json_schema?.schema ?? outgoing?.response_format?.schema
            ?? outgoing?.output_config?.format?.schema ?? outgoing?.generationConfig?.responseJsonSchema ?? outgoing?.text?.format?.schema;
        if (config.output_method === 'schema' && schema?.properties?.response?.pattern !== compiled.pattern) {
            throw new Error('This connection does not offer the requested schema format. Choose Instructions in Structured Prefill, or use a model with schema support.');
        }
        const response = await send(...args);
        if (!response.ok) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        if (!body.stream) {
            const data = normalisePrefillReply(await response.json());
            for (const choice of data.choices ?? []) {
                choice.structured_prefill = { ...compiled.context, applied: true, accepted: true, verification: 'incomplete', pending: false, hidden_prefix: '' };
                if (!choice.message?.content || choice.message.refusal || choice.finish_reason === 'error') continue;
                if (choice.finish_reason === 'content_filter' && !/^\s*\{\s*"response"\s*:/.test(choice.message.content)) continue;
                const decoder = createPrefillDecoder(compiled, overlap);
                let text = '';
                try {
                    text = decoder.push(choice.message.content).text;
                    const last = decoder.finish({ partial: ['length', 'content_filter'].includes(choice.finish_reason) });
                    choice.message.content = text + last.text;
                    choice.structured_prefill = last.metadata;
                } catch (error) {
                    let partial;
                    try { partial = decoder.partial({ invalid: true }); } catch { /* A mismatched Continue overlap cannot be appended. */ }
                    choice.message.content = text + (partial?.text ?? '');
                    choice.structured_prefill = partial?.metadata ?? { applied: true, pending: false, hidden_prefix: '' };
                    choice.finish_reason = 'error';
                    data.error = { message: error.message, code: 'STRUCTURED_PREFILL_INVALID_RESPONSE' };
                }
            }
            return new Response(JSON.stringify(data), { status: response.status, headers });
        }
        return new Response(Readable.from(decodePrefillStream(response.body, compiled, overlap)), { status: response.status, headers });
    };
}

/** Transform before resumable storage, so reconnects replay the same decoded text. */
export async function* decodePrefillStream(body, compiled, overlap = '') {
    const decoder = new StringDecoder('utf8');
    const choices = new Map();
    let pending = '';
    const finishRemaining = () => {
        const result = [];
        for (const [index, state] of choices) {
            if (state.finished || !state.started) continue;
            const final = state.decoder.finish(); state.finished = true;
            result.push({ index, delta: { content: final.text }, structured_prefill: final.metadata });
        }
        return result.length ? `data: ${JSON.stringify({ choices: result })}\n\n` : '';
    };
    function transform(event) {
        const raw = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw) return event + '\n\n';
        if (raw === '[DONE]') return finishRemaining() + event + '\n\n';
        const data = normalisePrefillReply(JSON.parse(raw), true);
        for (const choice of data.choices ?? []) {
            const index = choice.index ?? 0;
            let state = choices.get(index);
            if (!state) { state = { decoder: createPrefillDecoder(compiled, overlap), started: false, finished: false }; choices.set(index, state); }
            const field = choice.delta ?? choice.message;
            let decoded;
            if (field?.refusal || ['content_filter', 'error'].includes(choice.finish_reason)) {
                if (choice.finish_reason === 'content_filter' && !field?.refusal && (state.started || /^\s*\{\s*"response"\s*:/.test(field?.content ?? ''))) {
                    const first = state.decoder.push(field?.content ?? '');
                    const last = state.decoder.partial();
                    (choice.delta ??= {}).content = first.text + last.text;
                    state.metadata = last.metadata;
                }
                state.finished = true;
                choice.structured_prefill = { ...compiled.context, ...(state.metadata ?? { applied: true, hidden_prefix: '' }), accepted: true, verification: 'incomplete', pending: false };
                continue;
            }
            if (field?.content) {
                state.started = true;
                decoded = state.decoder.push(field.content);
                state.unsent = decoded.text;
                state.metadata = decoded.metadata;
            }
            if (choice.finish_reason && state.started && !state.finished) {
                const final = state.decoder.finish({ partial: choice.finish_reason === 'length' }); state.finished = true;
                decoded = { text: (decoded?.text ?? '') + final.text, metadata: final.metadata };
            }
            if (decoded) {
                (choice.delta ??= {}).content = decoded.text;
                choice.structured_prefill = decoded.metadata;
                if (choice.message) delete choice.message;
            }
        }
        for (const state of choices.values()) state.unsent = '';
        return `data: ${JSON.stringify(data)}\n\n`;
    }
    try {
        for await (const chunk of body) {
            pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
            if (pending.length > 4 * 1024 * 1024) throw new Error('The structured reply frame exceeds the 4 MB limit.');
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) {
                yield transform(pending.slice(0, boundary.index).replace(/\r\n/g, '\n'));
                pending = pending.slice(boundary.index + boundary[0].length);
            }
        }
        pending += decoder.end();
        if (pending.trim()) yield transform(pending.replace(/\r\n/g, '\n'));
        const final = finishRemaining();
        if (final) yield final;
    } catch (error) {
        const failed = [];
        const fragments = [];
        for (const [index, state] of choices) {
            let partial;
            if (!state.finished) {
                try { partial = state.decoder.partial({ invalid: true }); } catch { /* Do not append a mismatched overlap. */ }
                failed.push({ index, delta: {}, finish_reason: 'error' });
            }
            fragments.push({ index, delta: { content: (state.unsent ?? '') + (partial?.text ?? '') },
                structured_prefill: { ...(partial?.metadata ?? state.metadata ?? { applied: true, hidden_prefix: '' }), pending: false } });
        }
        if (fragments.length) yield `data: ${JSON.stringify({ choices: fragments })}\n\n`;
        yield `data: ${JSON.stringify({ choices: failed.length ? failed : [{ index: 0, finish_reason: 'error', delta: {} }],
            error: { message: error.message, code: 'STRUCTURED_PREFILL_INVALID_RESPONSE' } })}\n\n`;
    }
}
