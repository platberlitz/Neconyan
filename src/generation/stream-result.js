import { normalizeContentText } from '../../public/scripts/generation-format.js';

const STREAM_LIMIT = 2 * 1024 * 1024;

/** Assemble a complete provider stream; never turn an EOF without a final event into a reply. */
export function assembleGenerationStream(raw) {
    if (Buffer.byteLength(raw) > STREAM_LIMIT) throw new Error('The generated stream exceeded the saved result limit.');
    let text = '';
    let reasoning = '';
    let signature = '';
    let complete = false;
    let textBytes = 0;
    let reasoningBytes = 0;
    const events = String(raw).replace(/\r\n/g, '\n').split('\n\n');
    for (const event of events) {
        if (event.split('\n').some(line => /^event:\s*error\s*$/.test(line))) throw new Error('The provider rejected the generated stream.');
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
            complete = true;
            break;
        }
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new Error('The generated stream contains an invalid event.'); }
        if (chunk.error || chunk.type === 'error') throw new Error('The provider rejected the generated stream.');
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? choice?.message;
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (choice?.index > 0 || candidate?.index > 0) continue;
        if (delta?.tool_calls?.length || parts?.some(part => part?.functionCall || part?.inlineData)) {
            throw new Error('The provider stream contains an output this Roleplay reply cannot save.');
        }
        let nextText = normalizeContentText(delta?.content ?? delta?.text ?? choice?.text ?? chunk.delta?.text
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
        if (textBytes > STREAM_LIMIT || reasoningBytes > STREAM_LIMIT) throw new Error('The generated stream exceeded the saved result limit.');
        text += nextText;
        reasoning += nextReasoning;
        if (chunk.type === 'message_stop' || chunk.type === 'message-end' || chunk.done === true || choice?.finish_reason != null
            || candidate?.finishReason || chunk.event === 'done') complete = true;
    }
    if (!complete || !text.trim()) throw new Error('The provider stream ended without a complete reply.');
    return { choices: [{ text, reasoning, message: { content: text, reasoning_content: reasoning, reasoning,
        ...(signature ? { reasoning_details: [{ id: 'thought', type: 'reasoning.encrypted', data: signature }] } : {}) } }],
    content: [{ type: 'thinking', thinking: reasoning }, { type: 'text', text }], thinking: reasoning,
    responseContent: { parts: [...(reasoning ? [{ thought: true, text: reasoning }] : []),
        { text, ...(signature ? { thoughtSignature: signature } : {}) }] } };
}
