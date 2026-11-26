import { applyRegexScript, normalizeRegexScript } from '../extensions/in-chat-agents/regex-scripts.js';

export const CREATOR_AGENT_TEXT_LIMIT = 100000;
/* Rules may strip reasoning or wrappers from a long reply, so the input may be twice a field. */
export const CREATOR_AGENT_INPUT_LIMIT = CREATOR_AGENT_TEXT_LIMIT * 2;
export const CREATOR_AGENT_REGEX_TIMEOUT_MS = 2000;
const TOO_LONG = 'The agent returned more than 100,000 characters. Nothing was applied.';

export function creatorAgentRegexScripts(agent) {
    return (agent?.regexScripts ?? []).map(raw => normalizeRegexScript(raw)).filter(script => !script.disabled);
}

/** Applies the rules in order and stops as soon as the text outgrows a card field. */
export function applyCreatorAgentRegexScripts(scripts, value) {
    let text = String(value);
    if (!scripts?.length) return text;
    if (text.length > CREATOR_AGENT_INPUT_LIMIT) throw new Error(TOO_LONG);
    for (const script of scripts ?? []) {
        text = applyRegexScript(script, text);
        if (text.length > CREATOR_AGENT_INPUT_LIMIT) throw new Error(TOO_LONG);
    }
    return text;
}

/**
 * Runs the rules in a disposable worker with a time limit. Without worker support the rules
 * run in place, still bounded by the field length.
 */
export function applyCreatorAgentRegexScriptsInWorker(scripts, value, { timeoutMs = CREATOR_AGENT_REGEX_TIMEOUT_MS } = {}) {
    const text = String(value);
    if (!scripts?.length) return Promise.resolve(text);
    if (typeof Worker !== 'function') return Promise.resolve().then(() => applyCreatorAgentRegexScripts(scripts, text));
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./agent-regex-worker.js', import.meta.url), { type: 'module' });
        const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(new Error(error)) : resolve(result); };
        const timer = setTimeout(() => finish('An agent regex rule took too long. Simplify it before running the agent again.'), timeoutMs);
        worker.onmessage = ({ data }) => finish(data?.error, data?.text);
        worker.onerror = event => finish(event?.message || 'The agent regex rules could not run.');
        worker.postMessage({ scripts, text });
    });
}
