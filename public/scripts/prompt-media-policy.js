/** Shared, side-effect-free image selection. Account/file validation belongs to the host. */
export const PROMPT_MEDIA_VERSION = 1;
export const PROMPT_MEDIA_MODES = Object.freeze(['include', 'display-only', 'caption']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => new TextEncoder().encode(value).length;

export function promptMediaError(reason, index, mediaIndex, message) {
    return Object.assign(new Error(message), { code: 'ROLEPLAY_IMAGE_INPUT', status: 409,
        imageIssue: { reason, index, mediaIndex, actions: ['review', 'display-only', 'caption'] } });
}

/** Canonical JSON shared with protected server identities; object insertion order is irrelevant. */
export function canonicalPromptMedia(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalPromptMedia).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPromptMedia(value[key])}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}

/** Defaults differ by mode; one mode's saved preference is not consent for the other. */
export function generatedImageInputPreference(settings, conversation = false) {
    const mode = settings?.[conversation ? 'conversationChatImageInput' : 'chatImageInput'];
    return PROMPT_MEDIA_MODES.includes(mode) ? mode : conversation ? 'include' : 'display-only';
}

export function attachmentIdentity(item) {
    return [item?.type ?? 'image', item?.url ?? null];
}

export function validateImagePreference(value) {
    if (value === undefined) return 'include';
    if (!object(value) || value.version !== 1 || !['include', 'display-only'].includes(value.images)
        || Object.keys(value).some(key => !['version', 'images'].includes(key))) {
        throw promptMediaError('invalid-policy', -1, -1, 'Review the saved image input choice.');
    }
    return value.images;
}

/** Bind only immutable decisions, never the browser's display state or capability guesses. */
export function createPromptMediaContext(settings, metadata = {}, controls = {}, { backend = 'chat' } = {}) {
    const account = validateImagePreference(settings?.power_user?.neconyan_prompt_media);
    const chat = validateImagePreference(metadata?.neconyan_prompt_media);
    const caption = settings?.extension_settings?.caption;
    return { version: PROMPT_MEDIA_VERSION, account, chat, inlineImages: backend === 'chat' && controls.media_inlining !== false,
        automaticCaptions: Boolean(caption?.auto_mode && !settings?.extension_settings?.disabledExtensions?.includes('caption')),
        mediaDisplay: settings?.power_user?.media_display ?? 'list' };
}

function policyFor(item, index, mediaIndex, hash) {
    const policy = item.neconyan_prompt;
    if (policy === undefined) return { mode: 'include' };
    if (!object(policy) || policy.version !== 1 || !PROMPT_MEDIA_MODES.includes(policy.mode)
        || Object.keys(policy).some(key => !['version', 'mode', 'attachment_hash', 'image_url', 'original_evidence', 'caption'].includes(key))
        || typeof policy.attachment_hash !== 'string' || !/^[a-f0-9]{64}$/.test(policy.attachment_hash)) {
        throw promptMediaError('invalid-policy', index, mediaIndex, 'Review this image\'s saved input choice.');
    }
    if (!hash || policy.attachment_hash !== hash(attachmentIdentity(item))) {
        throw promptMediaError('stale-policy', index, mediaIndex, 'This image changed. Choose how to use it in replies again.');
    }
    if (policy.image_url !== undefined && (typeof policy.image_url !== 'string' || !policy.image_url.startsWith('/user/images/'))
        || policy.original_evidence !== undefined && (!object(policy.original_evidence)
            || Object.keys(policy.original_evidence).some(key => key !== 'rawHash') || !/^[a-f0-9]{64}$/.test(policy.original_evidence.rawHash))) {
        throw promptMediaError('invalid-policy', index, mediaIndex, 'Review this image\'s saved prompt copy.');
    }
    return policy;
}

function description(record, item, policy, index, mediaIndex) {
    const caption = policy.caption;
    if (!object(caption) || !['media-title', 'message-title', 'custom'].includes(caption.source)
        || Object.keys(caption).some(key => !['source', 'text'].includes(key))) {
        throw promptMediaError('missing-description', index, mediaIndex, 'Choose a saved description or enter one.');
    }
    const value = caption.source === 'media-title' ? item.title : caption.source === 'message-title' ? record.extra?.title : caption.text;
    if (typeof value !== 'string' || !value.trim() || bytes(value) > 16 * 1024) {
        throw promptMediaError('missing-description', index, mediaIndex, 'Choose a description of at most 16 KiB.');
    }
    return value;
}

/** Legacy image fields are interpreted only in the derived prompt, never rewritten here. */
function mediaFor(record, index) {
    const extra = record.extra ?? {};
    if (extra.media !== undefined) {
        if (!Array.isArray(extra.media)) throw promptMediaError('malformed-media', index, -1, 'Review this message\'s image attachments.');
        return { media: extra.media, legacy: false };
    }
    if (Object.hasOwn(extra, 'image') || Object.hasOwn(extra, 'image_swipes')) {
        const urls = extra.image_swipes === undefined ? [extra.image] : extra.image_swipes;
        if (!Array.isArray(urls) || !urls.length || urls.some(url => typeof url !== 'string' || !url)) {
            throw promptMediaError('legacy-media', index, -1, 'Review this message\'s older image attachment.');
        }
        return { media: urls.map(url => ({ type: 'image', url, title: extra.title, append_title: extra.append_title })), legacy: true };
    }
    return { media: [], legacy: false };
}

/** Preserve source coordinates even when no media is selected. Never reads a URL. */
export function selectPromptMedia(records, context, { hash, includeCaptionReads = false } = {}) {
    if (context?.version !== PROMPT_MEDIA_VERSION) throw promptMediaError('policy-version', -1, -1, 'This image input version is unsupported.');
    if (!['include', 'display-only'].includes(context.account) || !['include', 'display-only'].includes(context.chat)
        || typeof context.inlineImages !== 'boolean' || typeof context.automaticCaptions !== 'boolean') throw promptMediaError('invalid-policy', -1, -1, 'Review the saved image input settings.');
    const veto = context.account === 'display-only' || context.chat === 'display-only';
    const decisions = [], captionTexts = [], projected = [records[0]];
    for (const [index, record] of records.slice(1).entries()) {
        // Tool metadata remains untouched for the strict tool-history validator.
        if (!object(record) || !object(record.extra) && record.extra !== undefined || record.extra?.tool_invocations !== undefined) {
            projected.push(record); continue;
        }
        const extra = { ...record.extra };
        const { media, legacy } = mediaFor({ ...record, extra }, index);
        const hidden = record.is_system === true;
        const allImages = media.every(item => object(item) && (item.type === undefined || item.type === 'image'));
        const mode = legacy && Array.isArray(extra.image_swipes) ? 'gallery' : extra.media_display ?? context.mediaDisplay;
        let selected = null;
        if (media.length && !(allImages && (veto || hidden))) {
            if (!['gallery', 'list'].includes(mode)) throw promptMediaError('invalid-display', index, -1, 'Choose list or gallery for this message.');
            selected = legacy ? Math.max(0, media.findIndex(item => item.url === extra.image)) : extra.media_index === undefined ? 0 : extra.media_index;
            if (mode === 'gallery' && (!Number.isSafeInteger(selected) || selected < 0 || selected >= media.length)) {
                throw promptMediaError('invalid-selection', index, -1, 'Choose a remaining image in this gallery.');
            }
        }
        const included = [], additions = [];
        for (const [mediaIndex, item] of media.entries()) {
            if (!object(item) || !['image', 'video', 'audio'].includes(item.type ?? 'image')) {
                throw promptMediaError('malformed-media', index, mediaIndex, 'Remove or replace this malformed attachment.');
            }
            const image = (item.type ?? 'image') === 'image';
            const policy = image ? policyFor(item, index, mediaIndex, hash) : { mode: 'include' };
            const picked = !hidden && (mode !== 'gallery' || selected === mediaIndex);
            const effective = image && (veto || hidden) ? 'display-only' : policy.mode;
            const autoCaption = image && picked && effective === 'include' && context.automaticCaptions && item.source === 'upload' && !item.captioned;
            const read = picked && (image ? effective === 'include' && (context.inlineImages || autoCaption) : true);
            const decision = { index, mediaIndex, selected: picked, mode: effective, read, autoCaption,
                send: read && (!image || context.inlineImages), ...(policy.image_url ? { image_url: policy.image_url } : {}) };
            decisions.push(decision);
            if (picked && effective === 'include' && item.append_title && typeof item.title === 'string' && item.title) additions.push(item.title);
            if (picked && effective === 'caption') {
                const text = description(record, item, policy, index, mediaIndex);
                captionTexts.push({ index, mediaIndex, text, ...(hash ? { sourceHash: hash([attachmentIdentity(item), policy.caption, text]) } : {}) }); additions.push(text);
            }
            if (decision.send || includeCaptionReads && read) included.push({ ...item, ...(policy.image_url ? { url: policy.image_url } : {}), append_title: false });
        }
        if (included.length > 4) throw promptMediaError('too-many-images', index, -1, 'Choose up to four images for this reply or use a gallery.');
        if (included.length) { extra.media = included; extra.media_display = 'list'; delete extra.media_index; } else { delete extra.media; delete extra.media_index; delete extra.media_display; delete extra.inline_image; }
        if (legacy) {
            delete extra.image; delete extra.image_swipes;
            if (veto || hidden || decisions.filter(item => item.index === index).every(item => item.mode === 'display-only')) delete extra.append_title;
        }
        const existing = [record.mes, extra.append_title && extra.title].filter(value => typeof value === 'string');
        const unique = [...new Set(additions)].filter(text => !existing.some(value => value.includes(text)));
        projected.push({ ...record, extra });
        if (unique.length) captionTexts.push({ index, mediaIndex: -1, text: unique.join('\n\n'), composed: true });
    }
    return { records: projected, decisions, captionTexts };
}

/** Add selected attachment text once, before the host's usual macro/text transformations. */
export function promptMediaText(record, index, projection) {
    const addition = projection?.captionTexts.find(item => item.index === index && item.composed)?.text;
    return String(record.mes ?? '') + (addition ? `\n\n${addition}` : '');
}

/** Detach media without changing authored text or metadata belonging to other attachments. */
export function detachMessageMedia(extra, mediaIndex, all = false) {
    if (!object(extra) || !Array.isArray(extra.media) || !Number.isSafeInteger(mediaIndex)
        || mediaIndex < 0 || mediaIndex >= extra.media.length) throw new Error('Choose an attachment to remove.');
    const next = { ...extra, media: extra.media.filter((_item, index) => !all && index !== mediaIndex) };
    const removed = all ? extra.media : [extra.media[mediaIndex]];
    if (!next.media.length) {
        for (const key of ['media', 'media_index', 'media_display', 'inline_image']) delete next[key];
    } else if (extra.media_index !== undefined) {
        const selected = Number.isSafeInteger(extra.media_index) ? extra.media_index : 0;
        next.media_index = Math.max(0, Math.min(next.media.length - 1, selected >= mediaIndex ? selected - 1 : selected));
    }
    return { extra: next, urls: removed.map(item => item?.url).filter(url => typeof url === 'string' && url.startsWith('/user/images/')) };
}

/** Prompt consumers receive derived text and media, while the caller retains original save evidence. */
export function projectPromptMediaRecords(records, context, options) {
    if (!context) return records;
    const projection = selectPromptMedia(records, context, options);
    return projection.records.map((record, index) => index ? { ...record, mes: promptMediaText(record, index - 1, projection) } : record);
}

/** Minimal read-validation descriptor; embedded and external originals are never sent to this endpoint. */
export function promptImageCopyDescriptor(item) {
    if (!item?.neconyan_prompt?.image_url) return null;
    return { imageUrl: item.neconyan_prompt.image_url,
        originalUrl: item.url?.startsWith('/user/images/') ? item.url : null,
        originalHash: item.url?.startsWith('/user/images/') ? item.neconyan_prompt.original_evidence?.rawHash ?? null : null };
}
