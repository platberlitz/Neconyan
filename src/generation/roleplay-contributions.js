import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { validFunctionTools } from '../../public/scripts/chat-input-capabilities.js';

const invalid = message => { throw roleplayError('ROLEPLAY_INVALID', message, 409); };
const roles = ['system', 'user', 'assistant'];

function validate(values) {
    if (!values || !Array.isArray(values.extensions) || !Array.isArray(values.history)
        || values.extensions.length > 128 || values.history.length > 128 || !validFunctionTools(values.tools ?? [])
        || Object.keys(values).some(key => !['extensions', 'history', 'tools'].includes(key))
        || Buffer.byteLength(JSON.stringify(values)) > 2 * 1024 * 1024) invalid('The saved prompt contributions exceed their input limit.');
    const keys = new Set();
    for (const prompt of values.extensions) {
        if (!prompt || typeof prompt.key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(prompt.key) || keys.has(prompt.key)
            || typeof prompt.content !== 'string' || ![0, 1, 2].includes(prompt.position)
            || !Number.isSafeInteger(prompt.depth) || prompt.depth < 0 || prompt.depth > 10000
            || !roles.includes(prompt.role) || typeof prompt.scan !== 'boolean'
            || Object.keys(prompt).some(key => !['key', 'content', 'position', 'depth', 'role', 'scan'].includes(key))) invalid('A saved extension prompt is invalid.');
        keys.add(prompt.key);
    }
    validateRoleplayToolHistory(values.history, { allowMedia: false, maxMessages: 128 });
    return values;
}

/** Validate a complete context, including matching tool results, before an interceptor can replace it. */
export function validateRoleplayToolHistory(history, { allowMedia = true, maxMessages = 8192 } = {}) {
    if (!Array.isArray(history) || history.length > maxMessages || Buffer.byteLength(JSON.stringify(history)) > 2 * 1024 * 1024) {
        invalid('The complete prompt context exceeds its input limit.');
    }
    const pending = new Set();
    const seen = new Set();
    for (const original of history) {
        let message = original;
        if (allowMedia && Array.isArray(original?.content)) {
            if (original.content.some(part => !part || (part.type === 'text' ? typeof part.text !== 'string'
                || Object.keys(part).some(key => !['type', 'text'].includes(key)) : part.type !== 'image_url'
                || typeof part.image_url?.url !== 'string' || !part.image_url.url
                || Object.keys(part).some(key => !['type', 'image_url'].includes(key))
                || Object.keys(part.image_url).some(key => !['url', 'detail'].includes(key))
                || part.image_url.detail !== undefined && !['auto', 'low', 'high'].includes(part.image_url.detail)))) {
                invalid('The complete prompt context contains unsupported media.');
            }
            message = { ...original, content: JSON.stringify(original.content) };
        }
        if (!message || ![...roles, 'tool'].includes(message.role)
            || message.content !== undefined && typeof message.content !== 'string'
            || message.name !== undefined && typeof message.name !== 'string'
            || ['signature', 'reasoning'].some(key => message[key] !== undefined && typeof message[key] !== 'string')
            || Object.keys(message).some(key => !['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'signature', 'reasoning'].includes(key))) {
            invalid('A saved progressive prompt message is invalid.');
        }
        if (message.role === 'tool') {
            if (!pending.delete(message.tool_call_id) || message.tool_calls || typeof message.content !== 'string') {
                invalid('A saved tool result has no matching call.');
            }
            continue;
        }
        if (pending.size || message.tool_call_id !== undefined) invalid('A saved tool call has incomplete results.');
        if (message.tool_calls !== undefined) {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length
                || message.tool_calls.length > 32) invalid('Saved progressive tool calls are invalid.');
            for (const call of message.tool_calls) {
                if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 256 || seen.has(call.id)
                    || call.type !== 'function' || typeof call.function?.name !== 'string' || !call.function.name
                    || typeof call.function.arguments !== 'string'
                    || call.signature !== undefined && typeof call.signature !== 'string'
                    || Object.keys(call).some(key => !['id', 'type', 'function', 'signature'].includes(key))
                    || Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))) invalid('A saved progressive tool call is invalid.');
                pending.add(call.id);
                seen.add(call.id);
            }
        } else if (typeof message.content !== 'string') invalid('A saved progressive prompt message has no content.');
    }
    if (pending.size) invalid('A saved tool call has incomplete results.');
    return history;
}

/** Contributors publish a complete immutable input after their own durable steps finish. */
export function saveRoleplayPromptContributions(context, values) {
    validate(values);
    const record = { intentHash: roleplayHash(context.job.intent), values, hash: roleplayHash(values) };
    const previous = readArtifact(context.directories, context.job.id, 'roleplay-prompt-contributions');
    if (previous !== undefined) {
        if (roleplayHash(previous) !== roleplayHash(record)) invalid('This job already has different saved prompt contributions.');
        return previous.values;
    }
    if (readArtifact(context.directories, context.job.id, 'roleplay-history-input') !== undefined) {
        invalid('Prompt preparation has already started for this job.');
    }
    context.signal.throwIfAborted();
    writeArtifact(context.directories, context.job.id, 'roleplay-prompt-contributions', record);
    return values;
}

export function readRoleplayPromptContributions(context) {
    const saved = readArtifact(context.directories, context.job.id, 'roleplay-prompt-contributions');
    if (saved === undefined) return { extensions: [], history: [] };
    if (!saved || saved.intentHash !== roleplayHash(context.job.intent) || saved.hash !== roleplayHash(saved.values)) {
        throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved prompt contributions need recovery.', 503);
    }
    return validate(saved.values);
}
