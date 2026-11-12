import { isKimiK3Model } from '../openai-model-capabilities.js';

const ROLE_HEADER_RE = /^\s*\[(system|user|assistant)\]\s*$/i;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

function normalizeRole(value) {
    const role = String(value ?? '').trim().toLowerCase();
    return VALID_ROLES.has(role) ? role : 'assistant';
}

function normalizeContent(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * Parses textarea role blocks into chat-style helper messages.
 *
 * @param {string} value
 * @returns {{role: 'system'|'user'|'assistant', content: string}[]}
 */
export function parseHelperPrefillMessages(value = '') {
    const lines = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const messages = [];
    let currentRole = 'assistant';
    let currentLines = [];

    const flush = () => {
        const content = normalizeContent(currentLines.join('\n'));
        if (content) {
            messages.push({ role: currentRole, content });
        }
        currentLines = [];
    };

    for (const line of lines) {
        const roleMatch = line.match(ROLE_HEADER_RE);
        if (roleMatch) {
            flush();
            currentRole = normalizeRole(roleMatch[1]);
            continue;
        }

        currentLines.push(line);
    }

    flush();
    return messages;
}

/**
 * Appends configured helper prefill messages to a synthetic helper prompt.
 *
 * @param {object[]} messages
 * @param {string} prefillText
 * @returns {object[]}
 */
export function appendHelperPrefillMessages(messages, prefillText = '') {
    const baseMessages = Array.isArray(messages)
        ? messages.filter(message => message && typeof message === 'object').map(message => ({ ...message }))
        : [];
    const prefillMessages = parseHelperPrefillMessages(prefillText);

    if (prefillMessages.length === 0) {
        return baseMessages;
    }

    return [...baseMessages, ...prefillMessages];
}

/**
 * Converts helper prefill messages to labeled prompt text for prompt-only paths.
 *
 * @param {{role?: string, content?: unknown}[]} messages
 * @returns {string}
 */
export function serializeHelperPrefillForPrompt(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .map(message => {
            const content = normalizeContent(message?.content);
            if (!content) {
                return '';
            }

            return `${normalizeRole(message?.role).toUpperCase()}:\n${content}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

/** Add a model-specific continuation after the ordinary helper messages. */
export function prepareHelperPartialPrefill(messages, value, model) {
    const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
    if (!text.trim() || !isKimiK3Model(model)) return { messages, reply: '', active: false };
    const thinking = text.match(/^\s*<think>[\s\S]*?(?:<\/think>|$)/i);
    const reply = thinking ? text.slice(thinking[0].length).trimStart() : text;
    return { messages: [...messages, { role: 'assistant', content: text, partial: true }], reply, active: true };
}

const REASONING_TAG_RE = /<(\/?)(think|thinking|thought|reasoning)>/gi;

function getMessageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
}

/** The reasoning tag an assistant prefill leaves open, or '' when every tag is closed. */
function getOpenReasoningTag(content) {
    let open = '';
    for (const match of getMessageText(content).matchAll(REASONING_TAG_RE)) {
        open = match[1] ? '' : match[2].toLowerCase();
    }
    return open;
}

/**
 * A request that ends with an assistant prefill opening a reasoning block (for example
 * `<think>\nI am going to plan now`) makes some models continue that reasoning in the reply
 * itself, closing it with only `</think>`. Reasoning parsers miss a closing tag without its
 * opening tag, so drop everything up to that first closing tag and keep the actual reply.
 */
export function stripPrefilledReasoning(text, messages) {
    if (typeof text !== 'string' || !text || !Array.isArray(messages)) return text;
    const last = messages.at(-1);
    if (last?.role !== 'assistant') return text;
    const tag = getOpenReasoningTag(last.content);
    if (!tag) return text;
    const close = new RegExp(`</${tag}>`, 'i').exec(text);
    if (!close) return text;
    return text.slice(close.index + close[0].length).replace(/^\s+/, '');
}

/** Restore only visible continuation text, never the seeded reasoning. */
export function joinHelperPartialPrefill(text, prefix = '') {
    if (!text?.trim() || !prefix || text.startsWith(prefix) || text.trimStart().startsWith(prefix.trimStart())) return text;
    return prefix + text;
}
