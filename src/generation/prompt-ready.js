/**
 * Tell an optional listener about the final prompt about to reach the model. Only the
 * prompt and plain labels leave here, never connection or credential fields, and a
 * failing listener never stops the request.
 * @param {Function|undefined} listener Receives `{ prompt, backend, source, model, preset, contextLimit }`.
 * @param {object} payload Final provider payload.
 * @param {object} material Resolved generation profile.
 * @param {object} [binding] Generation binding.
 */
export function notifyPromptReady(listener, payload, material, binding) {
    if (typeof listener !== 'function' || !payload || typeof payload !== 'object') return;
    try {
        const prompt = Array.isArray(payload.messages) ? payload.messages
            : typeof payload.prompt === 'string' ? payload.prompt
                : typeof payload.input === 'string' ? payload.input : null;
        if (prompt === null) return;
        const model = payload.model || material?.profile?.model || '';
        const contextLimit = Number(material?.contextLimit || material?.active?.openai_max_context) || 0;
        listener({
            prompt,
            backend: String(material?.backend || binding?.backend || ''),
            source: String(material?.source || ''),
            model: typeof model === 'string' ? model : '',
            preset: String(binding?.presetOverride || material?.profile?.preset || ''),
            contextLimit,
        });
    } catch (error) {
        console.warn('Could not note the prompt sent:', error?.message || error);
    }
}
