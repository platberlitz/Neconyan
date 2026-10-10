import { getCounter } from '../mewmory/tokens.js';
import { extractProviderReasoning } from '../../public/scripts/generation-format.js';

export function getReplyReasoning(reply) {
    return extractProviderReasoning(reply.response, {
        mainApi: reply.generation?.backend === 'text' ? 'textgenerationwebui' : 'openai',
        textGenType: reply.generation?.source, chatCompletionSource: reply.generation?.source,
    }) || reply.response?.choices?.[0]?.message?.reasoning_content || reply.response?.choices?.[0]?.message?.reasoning || reply.response?.thinking || '';
}

/** Local display counts, using the same default counter as server-owned Roleplay. */
export async function createMessageTokenCounter(publish, { signal, interval = 500 } = {}) {
    const { count } = await getCounter();
    let latest;
    let timer;
    let countedAt = -Infinity;
    let stopped = false;
    const counts = (text = '', reasoning = '') => ({ token_count: count(text), reasoning_tokens: count(reasoning) });
    const flush = () => {
        clearTimeout(timer);
        timer = null;
        if (!latest || stopped || signal?.aborted) return;
        countedAt = Date.now();
        publish({ ...latest, ...counts(latest.text, latest.reasoning) });
        latest = null;
    };
    const stop = () => { stopped = true; clearTimeout(timer); latest = null; signal?.removeEventListener('abort', stop); };
    signal?.addEventListener('abort', stop, { once: true });
    return {
        counts,
        publish(value) {
            if (stopped || signal?.aborted) return;
            latest = value;
            const remaining = interval - (Date.now() - countedAt);
            if (remaining <= 0) flush();
            else if (!timer) timer = setTimeout(flush, remaining);
        },
        flush,
        stop,
    };
}
