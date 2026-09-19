import { MEDIA_DISPLAY } from '../constants.js';
import { TRANSCRIPT_MESSAGE_LIMIT } from './constants.js';
import { buildConversationGroupReferenceContext, formatPromptText } from './shared-helpers.js';
import { getConversationAttachmentSummary, getConversationMediaDisplay, getConversationMediaIndex, getConversationPromptMediaAttachments } from './thread-store-utils.js';

/** Compose the same transcript on either host; only image loading belongs to the host. */
export async function composeConversationPromptMessages(messages, directive, speakerName, {
    groupId = '', userName = 'User', convertImages,
} = {}) {
    const imageUrls = [];
    const rows = messages.slice(-TRANSCRIPT_MESSAGE_LIMIT).map((message, index) => {
        const parts = [formatPromptText(message.mes, 1800), getConversationAttachmentSummary(message)].filter(Boolean);
        const media = getConversationPromptMediaAttachments(message);
        if (!parts.length && !media.length) return null;
        const text = parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : `${message.name || 'Speaker'} sent an attachment.`;
        const row = {
            role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
            content: text,
            identifier: `conversation-message-${message.id || index}`,
        };
        if (media.length) {
            const selected = getConversationMediaDisplay(message) === MEDIA_DISPLAY.GALLERY
                ? [media[getConversationMediaIndex(message, media)]] : media;
            const urls = selected.map(item => item?.url).filter(Boolean);
            row.content = [{ type: 'text', text }];
            row.imageOffset = imageUrls.length;
            row.imageCount = urls.length;
            imageUrls.push(...urls);
        }
        return row;
    }).filter(Boolean);
    // A single host call bounds image conversion across the entire transcript.
    const images = imageUrls.length ? await convertImages(imageUrls) : [];
    for (const row of rows) {
        if (row.imageOffset === undefined) continue;
        for (const url of images.slice(row.imageOffset, row.imageOffset + row.imageCount).filter(Boolean)) {
            row.content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
        }
        delete row.imageOffset;
        delete row.imageCount;
    }
    const result = [{ role: 'user', content: 'Conversation transcript:', identifier: 'conversation-transcript-header' }];
    result.push(...(rows.length ? rows : [{ role: 'user', content: '(No prior DM messages.)', identifier: 'conversation-empty-transcript' }]));
    const reference = buildConversationGroupReferenceContext(messages, { groupId, speakerName, userName });
    if (reference) result.push({ role: 'system', content: reference, identifier: 'conversation-group-reference-context' });
    result.push({ role: 'user', content: [directive, `${speakerName}:`].filter(Boolean).join('\n\n'), identifier: 'conversation-reply-directive' });
    return result;
}
