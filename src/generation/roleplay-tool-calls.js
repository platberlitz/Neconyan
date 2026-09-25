import { roleplayError, roleplayHash } from '../roleplay-store.js';

const invalid = message => roleplayError('ROLEPLAY_TOOL_INVALID', message, 409);
const MAX_CALLS = 32;
const MAX_ARGS = 1024 * 1024;
const ID = /^[^\s\x00-\x1f]{1,256}$/u;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{1,127}$/u;

function argumentsFor(value) {
    let parsed = value;
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > MAX_ARGS) throw invalid('The model tool arguments are too large.');
        try { parsed = JSON.parse(value || '{}'); } catch { throw invalid('The model tool arguments are not JSON.'); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Buffer.byteLength(JSON.stringify(parsed)) > MAX_ARGS) throw invalid('The model tool arguments must be a bounded object.');
    return JSON.parse(JSON.stringify(parsed));
}

/** Freeze provider-generated tool IDs once. Gemini's optional ID gets a stable, response-bound substitute. */
export function normaliseRoleplayToolCalls(result, allowedNames = []) {
    if (!Array.isArray(allowedNames) || allowedNames.length > 64
        || allowedNames.some(name => typeof name !== 'string' || !NAME.test(name))) throw invalid('The accepted function tool list is invalid.');
    const response = result?.response;
    const raw = response?.choices?.[0]?.message?.tool_calls?.map(call => ({ id: call.id,
        name: call.function?.name, args: call.function?.arguments, type: call.type }))
        ?? response?.output?.filter(part => part.type === 'function_call')
            .map(call => ({ id: call.call_id ?? call.id, name: call.name, args: call.arguments, type: 'function' }))
        ?? response?.content?.filter(part => part.type === 'tool_use')
            .map(call => ({ id: call.id, name: call.name, args: call.input, type: 'function' }))
        ?? response?.candidates?.[0]?.content?.parts?.filter(part => part.functionCall)
            .map(part => ({ id: part.functionCall.id, name: part.functionCall.name,
                args: part.functionCall.args, type: 'function' })) ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_CALLS) throw invalid('The model returned too many tool calls.');
    const seen = new Set();
    const allowed = new Set(allowedNames);
    return raw.map((call, index) => {
        if (call.type !== 'function' || !NAME.test(call.name) || !allowed.has(call.name)) {
            throw invalid('The model requested an unregistered function tool.');
        }
        const id = call.id ?? `call_${roleplayHash([response, index]).slice(0, 32)}`;
        if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) throw invalid('The model returned an invalid or repeated tool call ID.');
        seen.add(id);
        return { id, name: call.name, arguments: argumentsFor(call.args ?? {}) };
    });
}
