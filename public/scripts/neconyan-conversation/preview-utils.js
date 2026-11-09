import { getConversationAttachmentLabels, getConversationAttachmentSummary } from './thread-store-utils.js';

export function truncateConversationReplyPreview(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Reproduce the stored quote previews on either host, without attachment fallback in authored prose. */
export function getConversationReplyPreviewParts(message, { browserPreview = false } = {}) {
    const strip = value => {
        const text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return browserPreview ? text.slice(0, 130) : text;
    };
    const authored = strip(message?.mes);
    return {
        text: truncateConversationReplyPreview(authored || strip(getConversationAttachmentLabels(message).join(', '))),
        attachmentSummary: truncateConversationReplyPreview(getConversationAttachmentSummary(message)),
        authoredText: truncateConversationReplyPreview(authored),
    };
}
