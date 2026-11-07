/** Native provider replies share one decoder; ordinary requests keep their existing format. */
const finishReason = reason => {
    if (!reason) return undefined;
    if (['max_tokens', 'MAX_TOKENS', 'MAX_TOKEN', 'length', 'max_output_tokens'].includes(reason)) return 'length';
    if (['end_turn', 'stop_sequence', 'STOP', 'COMPLETE', 'stop', 'completed'].includes(reason)) return 'stop';
    if (['refusal', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'content_filter'].includes(reason)) return 'content_filter';
    if (['ERROR', 'ERROR_TOXIC', 'error', 'failed'].includes(reason)) return 'error';
    return reason;
};
const signature = value => value ? [{ type: 'reasoning.encrypted', data: value }] : undefined;
const text = parts => (parts ?? []).map(part => part.text ?? '').join('');

export function normalisePrefillReply(data, stream = false) {
    const field = stream ? 'delta' : 'message';
    const choice = (content = '', reasoning = '', reason, signed, index = 0) => ({ index,
        [field]: { content, reasoning_content: reasoning, ...(signed ? { reasoning_details: signature(signed) } : {}) },
        ...(reason ? { finish_reason: finishReason(reason) } : {}) });
    const frame = (choices = [], extra = {}) => ({ ...extra, structured_prefill_wire: true, choices });
    if (Array.isArray(data.choices)) {
        for (const item of data.choices) {
            const value = item.delta ?? item.message;
            if (Array.isArray(value?.content)) {
                value.reasoning_content ??= value.content.flatMap(part => part.thinking ?? []).map(part => part.text ?? '').join('');
                value.content = text(value.content.filter(part => part.type === 'text'));
            }
        }
        return { ...data, structured_prefill_wire: true };
    }
    if (data.error) return frame([choice('', '', 'error')], { error: data.error });
    if (data.candidates || data.promptFeedback) {
        if (data.promptFeedback?.blockReason) return frame([choice('', '', 'content_filter')]);
        const usage = data.usageMetadata;
        return frame((data.candidates ?? []).map((candidate, index) => {
            const parts = candidate.content?.parts ?? [];
            return choice(text(parts.filter(part => !part.thought)), text(parts.filter(part => part.thought)), candidate.finishReason,
                parts.findLast(part => part.thoughtSignature)?.thoughtSignature, candidate.index ?? index);
        }), usage ? { usage: { prompt_tokens: usage.promptTokenCount ?? 0, completion_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) } } : {});
    }
    if (!stream && Array.isArray(data.content)) {
        const usage = data.usage ?? {};
        return frame([choice(text(data.content.filter(part => part.type === 'text')),
            data.content.filter(part => part.type === 'thinking').map(part => part.thinking ?? '').join(''), data.stop_reason,
            data.content.findLast(part => part.signature)?.signature)],
        { usage: { prompt_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), completion_tokens: usage.output_tokens ?? 0 } });
    }
    if (!stream && Array.isArray(data.output)) {
        const parts = data.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
        const refusal = parts.find(part => part.type === 'refusal');
        return frame([choice(text(parts.filter(part => part.type === 'output_text')),
            data.output.filter(item => item.type === 'reasoning').map(item => text(item.summary ?? item.content)).join(''),
            refusal ? 'content_filter' : data.incomplete_details?.reason ?? data.status ?? 'stop')], { usage: data.usage });
    }
    if (!stream && data.message) return frame([choice(text(data.message.content), data.message.tool_plan ?? '', data.finish_reason)], { usage: data.usage });
    if (stream) {
        const delta = data.delta ?? {};
        switch (data.type) {
            case 'content_block_start': {
                const block = data.content_block ?? {};
                return frame([choice(block.type === 'text' ? block.text : '', block.thinking, undefined, block.signature)]);
            }
            case 'content_block_delta': return frame([choice(delta.text, delta.thinking, undefined, delta.signature)]);
            case 'message_delta': return frame([choice('', '', delta.stop_reason)], { usage: data.usage });
            case 'message_stop': return frame([choice('', '', 'stop')]);
            case 'content-delta': return frame([choice(delta.message?.content?.text, delta.message?.tool_plan)]);
            case 'message-end': return frame([choice('', '', delta.finish_reason ?? data.finish_reason)], { usage: delta.usage });
            case 'response.output_text.delta': return frame([choice(data.delta)]);
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta': return frame([choice('', data.delta)]);
            case 'response.refusal.delta': return frame([{ ...choice('', '', 'content_filter'), delta: { refusal: data.delta } }]);
            case 'response.completed':
            case 'response.incomplete':
            case 'response.failed': return frame([choice('', '', data.response?.incomplete_details?.reason ?? data.response?.status ?? data.type.slice(9))],
                { usage: data.response?.usage, ...(data.response?.error ? { error: data.response.error } : {}) });
        }
    }
    return frame();
}
