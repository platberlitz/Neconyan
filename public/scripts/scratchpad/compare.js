// Compare one assistant on two connections. Pure helpers shared by the
// Scratchpad page and its tests; the server repeats the same checks.

export const CURRENT_CONNECTION_CHOICE = '__current__';

export function compareChoiceValue(connection) {
    if (!connection) return '';
    return connection.kind === 'profile' && connection.profileId ? connection.profileId : CURRENT_CONNECTION_CHOICE;
}

export function compareConnectionFromChoice(value) {
    if (!value) return null;
    if (value === CURRENT_CONNECTION_CHOICE) return { kind: 'current' };
    return { kind: 'profile', profileId: String(value) };
}

export function effectiveConnection(connection, chatProfileId = '') {
    const profileId = connection?.kind === 'profile' && connection.profileId ? connection.profileId : chatProfileId;
    return profileId ? { kind: 'profile', profileId } : { kind: 'active' };
}

export function sameCompareTarget(primary, compare, chatProfileId = '') {
    if (!compare) return false;
    const a = effectiveConnection(primary, chatProfileId);
    const b = effectiveConnection(compare, chatProfileId);
    return a.kind === b.kind && (a.kind !== 'profile' || a.profileId === b.profileId);
}

// The connection a new message is compared on, or null when this send gets one reply.
export function activeCompareConnection(settings, { regenerate = false, discuss = false, rehearsal = false } = {}) {
    if (!settings?.compareConnection || settings.roundTable || regenerate || discuss || rehearsal) return null;
    return settings.compareConnection;
}

export function comparedSiblings(messages, message) {
    if (!message?.compareGroup || message.role !== 'assistant') return [];
    return (messages ?? []).filter(item => item !== message && item.id !== message.id && item.role === 'assistant'
        && item.compareGroup === message.compareGroup && (item.assistant ?? '') === (message.assistant ?? ''));
}

export function comparingPending(messages) {
    const pending = (messages ?? []).filter(item => item.role === 'assistant' && item.state === 'pending' && item.compareGroup);
    return pending.length > 1 && new Set(pending.map(item => item.compareGroup)).size < pending.length;
}
