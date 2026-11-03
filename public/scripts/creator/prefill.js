import { isKimiK3Model } from '../openai-model-capabilities.js';

export function creatorPrefill(connection = {}, model = '') {
    const partial = isKimiK3Model(model);
    const text = String(partial && connection.partialPrefill ? connection.partialPrefill : connection.prefill || '');
    // Kimi can start inside a reasoning block. Only its visible suffix belongs in the proposal.
    const thinking = partial && text.match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/i);
    return { text, partial, reply: thinking ? text.slice(thinking[0].length).trimStart() : text };
}

export function joinCreatorPrefill(text, prefill) {
    // Some providers echo the prefix, others return only its continuation.
    if (!text || !prefill || text.startsWith(prefill) || prefill.startsWith(text)) return text;
    return prefill + text;
}
