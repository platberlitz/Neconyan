import { t } from './i18n.js';
import { getPositiveTokenCount } from './reasoning-token-accounting.js';

/** Compact, non-announcing counters: frequent updates must not interrupt screen readers. */
export function updateMessageTokenCounts(container, value = {}, { pending = false } = {}) {
    const output = getPositiveTokenCount(value?.token_count);
    const reasoning = getPositiveTokenCount(value?.reasoning_tokens);
    let counters = container.querySelector('.nn-message-token-counts');
    if (!pending && !output && !reasoning) { counters?.remove(); return; }
    if (!counters) {
        counters = document.createElement('span');
        counters.className = 'nn-message-token-counts';
        counters.innerHTML = '<span class="nn-output-tokens"></span> <span class="nn-reasoning-tokens"><i class="fa-solid fa-brain" aria-hidden="true"></i> <span></span></span>';
        container.append(counters);
    }
    const outputNode = counters.querySelector('.nn-output-tokens');
    outputNode.hidden = !pending && !output;
    outputNode.textContent = `${output}t`;
    outputNode.title = t`Output tokens`;
    outputNode.setAttribute('aria-label', `${t`Output tokens`}: ${output}`);
    const reasoningNode = counters.querySelector('.nn-reasoning-tokens');
    reasoningNode.hidden = !pending && !reasoning;
    reasoningNode.querySelector('span').textContent = `${reasoning}t`;
    reasoningNode.title = t`Thought tokens`;
    reasoningNode.setAttribute('aria-label', `${t`Thought tokens`}: ${reasoning}`);
}
