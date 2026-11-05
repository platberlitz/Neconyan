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
    if (outputNode.hidden !== (!pending && !output)) outputNode.hidden = !pending && !output;
    if (outputNode.textContent !== `${output}t`) outputNode.textContent = `${output}t`;
    if (outputNode.title !== t`Output tokens`) outputNode.title = t`Output tokens`;
    const outputLabel = `${t`Output tokens`}: ${output}`;
    if (outputNode.getAttribute('aria-label') !== outputLabel) outputNode.setAttribute('aria-label', outputLabel);
    const reasoningNode = counters.querySelector('.nn-reasoning-tokens');
    if (reasoningNode.hidden !== (!pending && !reasoning)) reasoningNode.hidden = !pending && !reasoning;
    const reasoningText = reasoningNode.querySelector('span');
    if (reasoningText.textContent !== `${reasoning}t`) reasoningText.textContent = `${reasoning}t`;
    if (reasoningNode.title !== t`Thought tokens`) reasoningNode.title = t`Thought tokens`;
    const reasoningLabel = `${t`Thought tokens`}: ${reasoning}`;
    if (reasoningNode.getAttribute('aria-label') !== reasoningLabel) reasoningNode.setAttribute('aria-label', reasoningLabel);
}
