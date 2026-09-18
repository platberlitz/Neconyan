/** Keep logical message identity outside swipe-specific dates and extra fields. */
export function ensureMewmoryMessageIds(messages, createId) {
    const seen = new Set();
    for (const message of messages) {
        if (!message || typeof message.mes !== 'string') continue;
        if (typeof message.mewmory_id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.mewmory_id)
            || seen.has(message.mewmory_id)) message.mewmory_id = createId();
        seen.add(message.mewmory_id);
    }
}
