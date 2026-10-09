/** Collect native streamed function calls in the same shape as non-streamed chat replies. */
export function createStreamTools() {
    const calls = new Map();
    function entry(key) {
        if (!calls.has(key)) {
            if (calls.size >= 32) throw new Error('The model returned too many tool calls.');
            calls.set(key, { type: 'function', function: { name: '', arguments: '' } });
        }
        return calls.get(key);
    }
    function index(value) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 1024) throw new Error('The model returned an invalid tool call index.');
        return value;
    }
    return {
        push(chunk) {
            const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message;
            for (const [position, part] of (delta?.tool_calls ?? []).entries()) {
                const call = entry(`openai:${index(part.index ?? position)}`);
                if (part.type && part.type !== 'function') throw new Error('The model returned an unsupported tool call.');
                if (part.id) call.id = part.id;
                // Some OpenAI-compatible proxies repeat the full name in every delta instead of sending it once.
                if (part.function?.name) {
                    const name = part.function.name;
                    call.function.name = call.function.name && name.startsWith(call.function.name) ? name : call.function.name + name;
                }
                if (part.function?.arguments) call.function.arguments += part.function.arguments;
            }
            if (chunk.content_block?.type === 'tool_use') {
                const call = entry(`anthropic:${index(chunk.index)}`);
                call.id = chunk.content_block.id;
                call.function.name = chunk.content_block.name;
                call.function.arguments = JSON.stringify(chunk.content_block.input ?? {});
            }
            if (chunk.delta?.type === 'input_json_delta') {
                const key = `anthropic:${index(chunk.index)}`;
                if (!calls.has(key)) throw new Error('The model returned tool arguments without a tool call.');
                const call = calls.get(key);
                call.partial = (call.partial ?? '') + chunk.delta.partial_json;
                call.function.arguments = call.partial;
            }
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
                if (!part.functionCall) continue;
                const call = entry(`gemini:${calls.size}`);
                call.id = part.functionCall.id;
                call.function.name = part.functionCall.name;
                call.function.arguments = JSON.stringify(part.functionCall.args ?? {});
            }
            if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
                const call = entry(`responses:${index(chunk.output_index)}`);
                call.id = chunk.item.call_id ?? chunk.item.id;
                call.function.name = chunk.item.name;
                call.function.arguments = chunk.item.arguments ?? '';
            }
            if (chunk.type === 'response.function_call_arguments.delta') {
                const key = `responses:${index(chunk.output_index)}`;
                if (!calls.has(key)) throw new Error('The model returned tool arguments without a tool call.');
                calls.get(key).function.arguments += chunk.delta;
            }
        },
        finish() {
            return [...calls.values()].map(call => {
                // The reply normaliser checks names against the tools actually offered.
                if (!call.function.name) throw new Error('The model returned a tool call without a name.');
                let args;
                try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('The model tool arguments are not JSON.'); }
                if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The model tool arguments must be an object.');
                return { type: call.type, id: call.id, function: call.function };
            });
        },
    };
}
