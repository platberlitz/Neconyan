/** Compact text identity; this is a stale-edit check, not a security hash. */
function fingerprint(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return `${text.length}:${hash >>> 0}`;
}

/** Capture offsets and identities only; never put a full message in the request header. */
export function captureRecoveryAnchor(message) {
    const text = String(message?.mes ?? '');
    const reasoning = String(message?.extra?.reasoning ?? '');
    return {
        textHash: fingerprint(text),
        prefixLength: text.length,
        reasoningLength: reasoning.length,
        reasoningHash: fingerprint(reasoning),
        swipeId: message?.swipe_id ?? 0,
    };
}

/** Decide whether a retained reply can still be applied without overwriting another edit. */
export function getHeldReplyTarget(chat, context, id) {
    if (chat.some(message => message.extra?.resumable_generation_id === id
        || message.swipe_info?.some(info => info?.extra?.resumable_generation_id === id))) {
        return { type: 'saved' };
    }
    const anchor = chat[context.chatLength - 1];
    const last = chat.at(-1);
    const identity = context.anchor;
    const sameStart = message => message && !message.is_user
        && new Date(message.gen_started).getTime() === context.startedAt;
    const anchorMatches = anchor && (anchor.send_date ?? null) === context.lastSendDate
        && Boolean(anchor.is_user) === context.lastIsUser
        && (!identity || fingerprint(String(anchor.mes ?? '')) === identity.textHash);
    const replacesTail = ['swipe', 'continue'].includes(context.type);

    if (!replacesTail) {
        if (!anchorMatches) return null;
        if (chat.length === context.chatLength) return { type: 'normal' };
        if (chat.length === context.chatLength + 1 && sameStart(last)) return { type: 'appendFinal', reasoningPrefix: '' };
        return null;
    }

    if (chat.length !== context.chatLength || last?.is_user) return null;
    if (identity && (last.swipe_id ?? 0) !== identity.swipeId) return null;
    if (!anchorMatches && !sameStart(last)) return null;
    if (context.type === 'swipe') {
        return { type: sameStart(last) ? 'appendFinal' : 'swipe', reasoningPrefix: '' };
    }
    // A saved partial continuation already contains some provider text. Replace that suffix.
    if (!identity) return anchorMatches ? { type: 'continue' } : null;
    const prefix = String(last.mes ?? '').slice(0, identity.prefixLength);
    const reasoningPrefix = String(last.extra?.reasoning ?? '').slice(0, identity.reasoningLength);
    if (fingerprint(prefix) !== identity.textHash || fingerprint(reasoningPrefix) !== identity.reasoningHash) return null;
    return { type: 'appendFinal', prefix, reasoningPrefix };
}
