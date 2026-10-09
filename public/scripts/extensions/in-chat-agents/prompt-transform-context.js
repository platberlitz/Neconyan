export const MAX_PROMPT_TRANSFORM_CONTEXT_MESSAGES = 30;
export const LENGTH_TRIMMER_TEMPLATE_ID = 'tpl-length-trimmer';
export const DEFAULT_LENGTH_TARGET = 'About 300 to 450 words';

export function normalizePromptTransformContextMessages(value) {
    const numeric = Math.trunc(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? Math.min(MAX_PROMPT_TRANSFORM_CONTEXT_MESSAGES, numeric) : 0;
}

export function getAgentLengthTarget(agent) {
    const value = typeof agent?.settings?.lengthTarget === 'string' ? agent.settings.lengthTarget.trim() : '';
    return value || DEFAULT_LENGTH_TARGET;
}

/** The caller supplies only messages preceding the target, never later chat. */
export function buildPromptTransformRecentChat(records, count, unwrap = value => value) {
    const limit = normalizePromptTransformContextMessages(count);
    const lines = [];
    for (let index = records.length - 1; index >= 0 && lines.length < limit; index--) {
        const entry = records[index];
        if (!entry || entry.is_system) continue;
        const text = unwrap(String(entry.mes ?? '')).trim();
        if (!text) continue;
        const name = String(entry.name ?? '').trim() || (entry.is_user ? 'User' : 'Assistant');
        lines.unshift(`${name}: ${text}`);
    }
    return lines.join('\n\n');
}
