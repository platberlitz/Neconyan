/** Shared creation contract for page-run and server-run assistant tools. */
export const CREATE_AGENT_GUIDE = 'Create a new saved agent after review. Choose before-reply to inject instructions into the main prompt, after-reply to rewrite or append to the reply with a model, or companion to produce separate notes after replies. The new agent starts switched off; tell the user to enable it in Agents and turn Agents On. Empty connectionProfile inherits the configured agent connection.';

export const CREATE_AGENT_SCHEMA = {
    type: 'object', required: ['agent'], additionalProperties: false,
    properties: { agent: {
        type: 'object', required: ['name', 'prompt', 'kind'], additionalProperties: false,
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            prompt: { type: 'string', minLength: 1, maxLength: 16000 },
            kind: { type: 'string', enum: ['before-reply', 'after-reply', 'companion'] },
            description: { type: 'string', maxLength: 2000 },
            tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
            connectionProfile: { type: 'string', maxLength: 200, description: 'Exact saved connection profile ID, or empty to inherit.' },
            modelOverride: { type: 'string', maxLength: 200 },
            afterReplyMode: { type: 'string', enum: ['rewrite', 'append'], description: 'Only for after-reply agents; defaults to rewrite.' },
        },
    } },
};

/** Return a bounded, disabled custom agent. Storage supplies the remaining normal defaults. */
export function buildAssistantAgent(input, id, profileIds = new Set()) {
    const fields = CREATE_AGENT_SCHEMA.properties.agent.properties;
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !Object.hasOwn(fields, key))) throw new Error('The proposed agent contains unsupported fields.');
    for (const field of ['name', 'prompt', 'description', 'connectionProfile', 'modelOverride']) {
        const value = input[field];
        const required = field === 'name' || field === 'prompt';
        if (value === undefined && !required) continue;
        if (typeof value !== 'string' || value.length > fields[field].maxLength || required && !value.trim()) {
            throw new Error(`The agent ${field} must contain text within its size limit.`);
        }
    }
    if (!fields.kind.enum.includes(input.kind)) throw new Error('Choose before-reply, after-reply or companion for the agent kind.');
    if (input.afterReplyMode !== undefined && (input.kind !== 'after-reply' || !fields.afterReplyMode.enum.includes(input.afterReplyMode))) {
        throw new Error('afterReplyMode must be rewrite or append for an after-reply agent.');
    }
    const tags = input.tags === undefined ? [] : input.tags;
    if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100)
        || new Set(tags.map(tag => tag.trim())).size !== tags.length) throw new Error('Agent tags must be unique, non-empty short strings.');
    const connectionProfile = input.connectionProfile?.trim() ?? '';
    if (connectionProfile && !profileIds.has(connectionProfile)) throw new Error('The selected connection profile is not saved.');
    return {
        id, name: input.name.trim(), prompt: input.prompt, description: input.description ?? '',
        tags: tags.map(tag => tag.trim()), connectionProfile, modelOverride: input.modelOverride ?? '',
        category: 'custom', execution: input.kind === 'companion' ? 'companion' : 'inline',
        phase: input.kind === 'before-reply' ? 'pre' : 'post', enabled: false, favorite: false,
        ...(input.kind === 'before-reply' ? { preProcess: { mode: 'inject' } } : {}),
        ...(input.kind === 'after-reply' ? { postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode: input.afterReplyMode ?? 'rewrite' } } : {}),
        ...(input.kind === 'companion' ? { companion: { trigger: 'auto', displayMode: 'panel' } } : {}),
    };
}

export function assistantAgentCreated(agent) {
    return { status: 'success', committed: true, id: agent.id, name: agent.name, enabled: false,
        message: 'Saved in Agents, switched off. Enable this agent and turn Agents On to use it.' };
}
