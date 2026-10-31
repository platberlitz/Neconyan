import { classifyGenerationOutcome, generationErrorEnvelope } from '../../public/scripts/generation-outcome.js';
import { normalizeContentText } from '../../public/scripts/generation-format.js';
import { createStreamTools } from './stream-tools.js';
import { MAX_GENERATION_STREAM_BYTES, MAX_GENERATION_TEXT_BYTES } from './stream-limits.js';

/** Assemble a complete provider stream; never turn an EOF without a final event into a reply. */
export function assembleGenerationStream(raw, options) {
    const stream = createGenerationStream(undefined, options);
    stream.push(String(raw));
    return stream.finish();
}

/** Preview deltas share the final parser, but only finish() can accept a reply. */
export function createGenerationStream(onUpdate, { allowTools = false } = {}) {
    const tools = allowTools ? createStreamTools() : null;
    let pending = '';
    let bytes = 0;
    let text = '';
    let reasoning = '';
    let finishReason;
    let usage;
    let signature = '';
    let complete = false;
    let outcome = null;
    let unsupportedOutput = false;
    let terminated = false;
    let textBytes = 0;
    let reasoningBytes = 0;
    const accept = event => {
        const eventType = event.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') {
            complete = true;
            terminated = true;
            return;
        }
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new Error('The AI service sent a reply that could not be read.'); }
        outcome ??= classifyGenerationOutcome(chunk);
        if (outcome) complete = true;
        if (generationErrorEnvelope(chunk, eventType)) {
            if (outcome) return;
            throw new Error('The AI service rejected the reply while it was streaming.');
        }
        if (terminated) throw new Error('The AI service sent extra text after the reply had finished.');
        const choice = chunk.choices?.find((value, index) => (value.index ?? index) === 0);
        const delta = choice?.delta ?? choice?.message;
        const candidate = chunk.candidates?.find((value, index) => (value.index ?? index) === 0);
        const parts = candidate?.content?.parts;
        if (chunk.choices?.length && !choice || chunk.candidates?.length && !candidate) return;
        if (choice) chunk = { ...chunk, choices: [choice] };
        if (candidate) chunk = { ...chunk, candidates: [candidate] };
        const reason = choice?.finish_reason ?? candidate?.finishReason ?? chunk.delta?.stop_reason ?? chunk.stop_reason;
        if (reason != null) finishReason = reason;
        // OpenAI-compatible providers commonly send usage in a final choices: [] frame.
        if (chunk.usage && typeof chunk.usage === 'object' && !Array.isArray(chunk.usage)) usage = { ...usage, ...chunk.usage };
        if (!outcome && (parts?.some(part => part?.inlineData) || !tools && (delta?.tool_calls?.length || parts?.some(part => part?.functionCall)
            || chunk.content_block?.type === 'tool_use' || chunk.item?.type === 'function_call'))) {
            unsupportedOutput = true;
        }
        if (!outcome) tools?.push(chunk);
        let nextText = normalizeContentText(delta?.content ?? delta?.text ?? choice?.text ?? chunk.delta?.text
            ?? (chunk.type === 'response.output_text.delta' ? chunk.delta : undefined)
            ?? chunk.delta?.message?.content?.text ?? chunk.token ?? (typeof chunk.content === 'string' ? chunk.content : ''), { excludeReasoning: true });
        let nextReasoning = normalizeContentText(delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking
            ?? chunk.delta?.thinking ?? choice?.thinking ?? '', { excludeReasoning: false });
        if (Array.isArray(delta?.content)) for (const item of delta.content) {
            if (Array.isArray(item?.thinking)) nextReasoning += item.thinking.map(part => part?.text ?? '').join('');
        }
        if (Array.isArray(parts)) for (const part of parts) {
            if (part?.thought) nextReasoning += part.text ?? '';
            else nextText += part?.text ?? '';
            if (part?.thoughtSignature) signature = part.thoughtSignature;
        }
        for (const detail of Array.isArray(delta?.reasoning_details) ? delta.reasoning_details : []) {
            if (detail?.type === 'reasoning.encrypted' && typeof detail.data === 'string' && !/tool/i.test(String(detail.id))) signature = detail.data;
        }
        textBytes += Buffer.byteLength(nextText);
        reasoningBytes += Buffer.byteLength(nextReasoning);
        if (textBytes > MAX_GENERATION_TEXT_BYTES || reasoningBytes > MAX_GENERATION_TEXT_BYTES) {
            throw new Error('The reply or its thinking text is over the 2 MB limit.');
        }
        text += nextText;
        reasoning += nextReasoning;
        if (chunk.type === 'message_stop' || chunk.type === 'message-end' || chunk.type === 'response.completed' || chunk.done === true || choice?.finish_reason != null
            || candidate?.finishReason || chunk.event === 'done') complete = true;
        if (nextText || nextReasoning) onUpdate?.({ text, reasoning });
    };
    return {
        push(chunk) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_GENERATION_STREAM_BYTES) throw new Error('The streamed reply is over the 64 MB size limit.');
            pending += chunk;
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) {
                accept(pending.slice(0, boundary.index).replace(/\r\n/g, '\n'));
                pending = pending.slice(boundary.index + boundary[0].length);
            }
        },
        finish() {
            if (pending) { accept(pending.replace(/\r\n/g, '\n')); pending = ''; }
            if (unsupportedOutput && !outcome) throw new Error('The AI service sent a kind of output that a Roleplay reply cannot save.');
            const toolCalls = outcome ? [] : tools?.finish() ?? [];
            if (!complete || !outcome && !text.trim() && !reasoning.trim() && !toolCalls.length) throw new Error('The AI service ended the reply before it was finished.');
            return { ...(usage ? { usage } : {}), choices: [{ ...(outcome || finishReason != null ? { finish_reason: outcome?.reason ?? finishReason } : {}), text, reasoning, message: { content: text, reasoning_content: reasoning, reasoning,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                ...(signature ? { reasoning_details: [{ id: 'thought', type: 'reasoning.encrypted', data: signature }] } : {}) } }],
            content: [{ type: 'thinking', thinking: reasoning }, { type: 'text', text }], thinking: reasoning,
            responseContent: { parts: [...(reasoning ? [{ thought: true, text: reasoning }] : []),
                { text, ...(signature ? { thoughtSignature: signature } : {}) }] } };
        },
    };
}
