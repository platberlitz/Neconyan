import { attachmentIdentity, promptImageCopyDescriptor, promptMediaError, selectPromptMedia } from '../prompt-media-policy.js';
import { getConversationAttachmentSummary } from './thread-store-utils.js';

export function conversationReplyImageProof(message, reference, authoredText, hash) {
    return { version: 1, source_hash: hash([message.id, message.mes ?? '', getConversationAttachmentSummary(message)]),
        reference_hash: hash([reference.text ?? '', reference.attachmentSummary ?? '', authoredText]), authored_text: authoredText };
}

/** Project automatic model input only; stored bubbles, search and reply previews are unchanged. */
export function projectConversationImageInput(messages, mediaPolicy, { hash } = {}) {
    const veto = mediaPolicy.account === 'display-only' || mediaPolicy.chat === 'display-only';
    const sources = messages.map(message => {
        const extra = { ...message.extra };
        if (extra.image_url) {
            extra.media = [...(extra.media ?? []), { type: 'image', url: extra.image_url,
                title: extra.neconyan_image_prompt?.mode === 'caption' ? extra.image_prompt || 'Generated image' : 'Generated image', ...(extra.neconyan_image_prompt ? { neconyan_prompt: extra.neconyan_image_prompt } : {}) }];
        }
        return { ...message, is_user: message.role === 'user', is_system: message.role === 'system', extra };
    });
    const projection = selectPromptMedia([{}, ...sources], mediaPolicy, { hash });
    const projected = projection.records.slice(1).map((record, index) => {
        const source = sources[index], extra = { ...record.extra };
        delete extra.image_url;
        const choices = projection.decisions.filter(item => item.index === index);
        const excluded = veto || choices.some(item => item.mode === 'display-only');
        const captions = projection.captionTexts.filter(item => item.index === index && !item.composed);
        const additions = [...new Set(captions.map(item => item.text))].filter(text => !String(record.mes ?? '').includes(text));
        const mes = String(record.mes ?? '') + (additions.length ? `\n\n${additions.join('\n\n')}` : '');
        if (excluded && extra.conversation_attachment_context) {
            const proof = extra.conversation_attachment_context_provenance;
            const valid = proof?.version === 1 && hash && proof.source_hash === hash([
                source.extra.conversation_attachment_context, source.extra.media ?? [], source.extra.files ?? []]);
            if (valid && typeof proof.file_text === 'string') extra.conversation_attachment_context = proof.file_text;
            else {
                const choice = extra.neconyan_image_context;
                if (!choice || choice.version !== 1 || !hash || choice.source_hash !== hash([
                    source.extra.conversation_attachment_context, source.extra.conversation_reply_to ?? null])) {
                    throw promptMediaError('mixed-attachment-context', index, -1,
                        'Review this message\'s saved attachment text before using Show only. You can keep reviewed text or omit the attachment context.');
                }
                if (choice.mode === 'omit') delete extra.conversation_attachment_context;
                else if (choice.mode === 'replace' && typeof choice.text === 'string' && new TextEncoder().encode(choice.text).length <= 16384) extra.conversation_attachment_context = choice.text;
                else throw promptMediaError('mixed-attachment-context', index, -1, 'Review this message\'s attachment text.');
            }
        }
        // Descriptive labels are independent of byte conversion and gallery selection.
        const rawSource = messages[index];
        const summaryMedia = (rawSource.extra?.media ?? []).filter((_item, mediaIndex) => {
            const choice = choices.find(item => item.mediaIndex === mediaIndex);
            return choice?.mode !== 'display-only' && choice?.mode !== 'caption';
        });
        const generatedChoice = choices.find(item => item.mediaIndex === (rawSource.extra?.media?.length ?? 0));
        const summary = getConversationAttachmentSummary({ ...rawSource, extra: { ...rawSource.extra,
            image_url: generatedChoice?.mode === 'include' ? rawSource.extra?.image_url : undefined, media: summaryMedia } });
        const sentChoices = choices.filter(choice => choice.send);
        const promptImageCopies = (record.extra.media ?? []).flatMap((item, offset) =>
            item.url && (item.type ?? 'image') === 'image'
                ? [promptImageCopyDescriptor(source.extra.media?.[sentChoices[offset]?.mediaIndex])] : []);
        return { ...record, mes, extra, promptAttachmentSummary: summary, promptImageCopies };
    });
    for (const [index, record] of projected.entries()) {
        const reference = record.extra?.conversation_reply_to;
        if (!reference) continue;
        const matches = messages.map((message, index) => message.id === reference.messageId ? index : -1).filter(index => index >= 0);
        const sourceIndex = matches.length === 1 ? matches[0] : -1;
        const sourceExcluded = sourceIndex >= 0 && projection.decisions.some(item => item.index === sourceIndex && item.mode === 'display-only');
        if (!veto && !sourceExcluded) continue;
        const proof = reference.neconyan_image_source;
        const verified = sourceIndex >= 0 && proof?.version === 1 && typeof proof.authored_text === 'string'
            && proof.authored_text.length <= 160 && hash
            && proof.source_hash === hash([messages[sourceIndex].id, messages[sourceIndex].mes ?? '', getConversationAttachmentSummary(messages[sourceIndex])])
            && proof.reference_hash === hash([reference.text ?? '', reference.attachmentSummary ?? '', proof.authored_text]);
        if (verified) {
            record.extra.conversation_reply_to = { ...reference, text: proof.authored_text,
                attachmentSummary: projected[sourceIndex].promptAttachmentSummary };
        } else if (reference.text || reference.attachmentSummary) {
            const choice = record.extra.neconyan_image_context;
            if (!choice || choice.version !== 1 || !['omit', 'replace'].includes(choice.mode) || choice.mode === 'replace' && (typeof choice.text !== 'string' || new TextEncoder().encode(choice.text).length > 16384) || !hash
                || choice.source_hash !== hash([sources[index].extra.conversation_attachment_context ?? '', reference])) {
                throw promptMediaError('mixed-reply-context', index, -1, 'Review the quoted attachment text. Its original message is unavailable, changed, or lacks verified quote provenance.');
            }
            record.extra.conversation_reply_to = { ...reference, text: choice.mode === 'replace' ? choice.text : '', attachmentSummary: '' };
        }
    }
    return projected;
}

export function conversationImagePolicyIdentity(item) {
    return attachmentIdentity(item);
}
