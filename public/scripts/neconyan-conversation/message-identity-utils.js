function normalizeConversationRevisionValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeConversationRevisionValue);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = normalizeConversationRevisionValue(value[key]);
            return result;
        }, {});
    }
    return value;
}

export function getConversationMessageRevision(message) {
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    return JSON.stringify(normalizeConversationRevisionValue({
        id: message?.id || '',
        name: message?.name || '',
        role: message?.role || '',
        mes: message?.mes || '',
        created_at: message?.created_at || '',
        extra: {
            attachments: extra.attachments || [],
            conversation_attachment_context: extra.conversation_attachment_context || '',
            conversation_reply_to: extra.conversation_reply_to || null,
            files: extra.files || [],
            image_url: extra.image_url || '',
            inline_image: Boolean(extra.inline_image),
            media: extra.media || [],
            media_display: extra.media_display || '',
            media_index: extra.media_index ?? '',
            partner_avatar: extra.partner_avatar || '',
        },
    }));
}

export function getConversationMessagesRevision(messages) {
    return JSON.stringify((Array.isArray(messages) ? messages : []).map(getConversationMessageRevision));
}

/** Capture message identities for the server: the id plus the revision seen. */
export function createConversationMessageAnchors(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => message?.id)
        .map(message => ({
            messageId: String(message.id),
            revision: getConversationMessageRevision(message),
        }));
}
