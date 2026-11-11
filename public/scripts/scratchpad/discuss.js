/**
 * The finished answers to the latest message when a round table can discuss them:
 * at least two different assistants answered and nothing is still being written.
 */
export function roundToDiscuss(session) {
    const settings = session?.settings;
    if (!settings?.roundTable || settings.randomReply || (settings.participants?.length ?? 0) < 2) return [];
    const messages = session.messages ?? [];
    const asked = messages.findLastIndex(message => message.role === 'user');
    if (asked < 0) return [];
    const replies = messages.slice(asked + 1);
    if (replies.some(message => message.state === 'pending')) return [];
    const done = replies.filter(message => message.role === 'assistant' && message.state === 'done' && String(message.text ?? '').trim());
    return new Set(done.map(message => message.assistant)).size > 1 ? done : [];
}
