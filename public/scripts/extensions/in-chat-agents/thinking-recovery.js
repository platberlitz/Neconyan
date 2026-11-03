// Shared by the browser runner and the server Roleplay runner, so keep it free of DOM and app imports.
import { isLikelyPromptTransformRefusal } from './prompt-transform-refusal.js';

export const THINKING_RECOVERY_TEMPLATE_ID = 'tpl-thinking-reply-recovery';
export const THINKING_RECOVERY_RUN_EXTRA_KEY = 'inChatAgentThinkingRecovery';

const LIMITED_FINISH_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
const THINKING_BLOCK_RE = /^\s*<(thinking|think|reasoning)>[\s\S]*?<\/\1>\s*/i;
const THINKING_TAG_RE = /<\/?(thinking|think|reasoning)>/i;
const ASSISTANT_WRAPPER_RE = /^\s*<assistant_response>\s*([\s\S]*?)\s*<\/assistant_response>\s*$/i;

export function isThinkingRecoveryAgent(agent) {
    return agent?.id === THINKING_RECOVERY_TEMPLATE_ID || agent?.sourceTemplateId === THINKING_RECOVERY_TEMPLATE_ID;
}

/**
 * Only a completed, answerless reply with usable thinking qualifies. Stops,
 * errors, blocks, tool turns, unclosed thinking and token-limited thinking are
 * never repaired, because the thinking is not a finished plan in those cases.
 */
export function isThinkingRecoveryEligible({ text, reasoning, finishReason, outcome, stopped = false, toolTurn = false, unclosed = false } = {}) {
    if (stopped || toolTurn || unclosed || outcome) return false;
    if (LIMITED_FINISH_REASONS.has(finishReason)) return false;
    if (typeof text !== 'string' || text.trim()) return false;
    return typeof reasoning === 'string' && reasoning.trim().length > 0;
}

/** Read a saved reply without treating the recoverable thinking-only notice as a provider failure. */
export function thinkingRecoveryInput(message, nextRecord) {
    const extra = message?.extra ?? {};
    const continuation = extra.reasoning_continuation_empty === true;
    const reasoning = continuation && typeof extra.reasoning_current === 'string' ? extra.reasoning_current : extra.reasoning;
    const prefix = continuation ? String(message?.mes ?? '') : '';
    const outcome = extra.generation_outcome?.status === 'error' && extra.generation_outcome.reason === 'reasoning_only'
        ? null : extra.generation_outcome;
    const toolTurn = extra.generation_tool_turn === true || extra.tool_invocations?.length > 0
        || nextRecord?.is_system === true && nextRecord.extra?.tool_invocations?.length > 0;
    const eligible = !message?.is_user && !message?.is_system && isThinkingRecoveryEligible({
        text: continuation ? '' : message?.mes, reasoning, outcome, toolTurn,
        unclosed: extra.reasoning_unclosed === true, finishReason: extra.generation_finish_reason,
    });
    return { eligible, reasoning, continuation, prefix };
}

/** Read the bounded run of tool-result records immediately preceding a reply, oldest first. */
export function precedingToolInvocations(chatRecords, messageIndex) {
    const invocations = [];
    for (let index = messageIndex - 1, read = 0; index >= 0 && read < 16; index--, read++) {
        const record = chatRecords[index];
        if (record?.is_system !== true) break;
        if (Array.isArray(record.extra?.tool_invocations)) invocations.unshift(...record.extra.tool_invocations);
    }
    return invocations;
}

/**
 * Accepts only the reply prose. Closed leading thinking blocks and an
 * assistant_response wrapper are removed; anything still carrying an unclosed
 * or stray thinking tag, or any refusal of the thinking, is rejected.
 */
export function cleanThinkingRecoveryOutput(output, { status = 'done', reasoning = '', continuation = false, refusalGuard = true } = {}) {
    if (status !== 'done') return '';
    // A continuation keeps all of the model's leading whitespace, including paragraph breaks, because it is joined directly onto the
    // saved reply. Only trailing whitespace is dropped; a blank-only reply is still rejected below.
    let text = continuation ? String(output ?? '').trimEnd() : String(output ?? '').trim();
    for (let index = 0; index < 8 && THINKING_BLOCK_RE.test(text); index++) text = text.replace(THINKING_BLOCK_RE, '');
    const wrapped = text.match(ASSISTANT_WRAPPER_RE);
    if (wrapped) text = wrapped[1].trim();
    if (!text.trim() || THINKING_TAG_RE.test(text) || /^\s*<assistant_response>/i.test(text)) return '';
    return refusalGuard && isLikelyPromptTransformRefusal(text, reasoning) ? '' : text;
}

/**
 * The system prompt is the agent's own prompt; the user turn carries the completed thinking and recent chat.
 * A continuation whose text never arrived asks for only the missing suffix, which the caller appends to the saved prefix.
 */
export function buildThinkingRecoveryMessages(prompt, { reasoning, assistantName = '', generationType = 'normal', recentChat = '', continuation = false, prefix = '', toolResults = '' }) {
    const instruction = continuation
        ? 'The last reply in the recent chat stopped before its text was written. Write ONLY the text that continues it from exactly where it stops, as the assistant would send it. Do not repeat anything already written, do not restart the reply, do not explain, and do not add markdown fences.'
        : 'Write the reply that the thinking above is planning, as the assistant would send it. Return ONLY the reply text. Do not return the thinking, do not explain, and do not add markdown fences.';
    const recent = recentChat ? `Recent chat, oldest first. Read-only context: do not rewrite, repeat, or return it.\n<recent_chat>\n${recentChat}\n</recent_chat>\n\n` : '';
    const lead = continuation ? 'Completed thinking. The continuation was never written, so this thinking is the only source for the missing text:' : 'Completed thinking. The reply was never written, so this thinking is the only source for it:';
    const saved = continuation ? `The reply so far, which the missing text continues:\n<reply_so_far>\n${prefix}\n</reply_so_far>\n\n` : '';
    const tools = toolResults ? `Tool results from this turn, read-only. Do not call tools or repeat them:\n<tool_results>\n${toolResults}\n</tool_results>\n\n` : '';
    return [{ role: 'system', content: `${prompt}\n\n${instruction}` }, { role: 'user', content: `Assistant name: ${assistantName}\nGeneration type: ${generationType}\n\n${recent}${saved}${tools}${lead}\n<thinking>\n${reasoning}\n</thinking>` }];
}

const TOOL_RESULTS_LIMIT = 12000;

/**
 * Renders the saved tool turn that the reply followed, bounded and read-only. Only tool calls and tool results count,
 * and nothing is executed: the text only shows what the model already saw.
 */
export function formatToolResults(history) {
    const lines = [];
    // Browser tool records store each call as an invocation, so it is read into the same shape as chat-history tool messages.
    const invocations = Array.isArray(history) ? history.filter(item => item && item.role === undefined && item.name !== undefined) : [];
    const messages = Array.isArray(history) ? history.filter(item => !invocations.includes(item)) : [];
    for (const invocation of invocations) {
        lines.push(`tool calls: ${String(invocation.displayName || invocation.name || 'tool')}`);
        const body = typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result ?? '');
        lines.push(`tool result: ${String(body).slice(0, 4000)}`);
    }
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'tool') {
            const body = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
            lines.push(`tool result: ${String(body).slice(0, 4000)}`);
        } else if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
            lines.push(`tool calls: ${message.tool_calls.map(call => String(call?.function?.name ?? call?.name ?? 'tool')).join(', ')}`);
        }
    }
    const text = lines.join('\n');
    return text.length > TOOL_RESULTS_LIMIT ? text.slice(-TOOL_RESULTS_LIMIT) : text;
}
