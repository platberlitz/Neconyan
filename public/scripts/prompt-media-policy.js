import { uiText } from './ui-text.js';

/** Shared, side-effect-free image selection. Account/file validation belongs to the host. */
export const PROMPT_MEDIA_VERSION = 1;
export const PROMPT_MEDIA_MODES = Object.freeze(['include', 'display-only', 'caption']);
/** Sent on the window when a setting that decides whether images are sent changes (the account or chat choice). */
export const IMAGE_INPUT_SETTINGS_CHANGED = 'neconyan:image-input-settings-changed';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => new TextEncoder().encode(value).length;

export function promptMediaError(reason, index, mediaIndex, message) {
    return Object.assign(new Error(message), { code: 'ROLEPLAY_IMAGE_INPUT', status: 409,
        imageIssue: { reason, index, mediaIndex, actions: ['review', 'display-only', 'caption'] } });
}

/**
 * True when a failure is about an image the person can decide about: the code ROLEPLAY_IMAGE_INPUT or an imageIssue field,
 * on the error itself, on the server reply it carries (error.body), or on a server reply read as plain data.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isImageInputIssue(error) {
    return [error, error?.body].some(source => source?.code === 'ROLEPLAY_IMAGE_INPUT' || (source?.imageIssue !== null && typeof source?.imageIssue === 'object'));
}

/**
 * What a server reply or a stored job error keeps of an image refusal, besides its message: the code and the imageIssue
 * (reason, index, mediaIndex, actions). Any other error gets nothing here, so its reply or job error stays as it was.
 * @param {unknown} error
 * @returns {{code?: string, imageIssue?: {reason: string, index: number, mediaIndex: number, actions: string[]}}}
 */
export function imageInputFields(error) {
    if (error?.code !== 'ROLEPLAY_IMAGE_INPUT') return {};
    const issue = error.imageIssue;
    return { code: 'ROLEPLAY_IMAGE_INPUT', ...(issue !== null && typeof issue === 'object'
        ? { imageIssue: { reason: issue.reason, index: issue.index, mediaIndex: issue.mediaIndex, actions: issue.actions } } : {}) };
}

/**
 * What the refusal event carries: the image issue fields (reason, index, mediaIndex, actions), the message to show and, when the
 * site knows it, the `origin` of the request or job that was refused (see roleplayImageOrigin and conversationImageOrigin).
 * @param {unknown} error An error, or a server reply
 * @param {object} [origin] Where the refusal came from; the notice opens the review for it
 * @returns {{message: string, origin?: object, reason?: string, index?: number, mediaIndex?: number, actions?: string[]}}
 */
export function imageInputIssueDetail(error, origin) {
    const issue = error?.imageIssue ?? error?.body?.imageIssue;
    return { ...(issue !== null && typeof issue === 'object' ? issue : {}), message: String(error?.message ?? error?.error ?? ''),
        ...(origin !== null && typeof origin === 'object' ? { origin } : {}) };
}

/**
 * The origin of a refused Roleplay request or workflow job: its own chat locator and the account it ran under. Taken from the
 * request or the job record, never from the chat that is open when the refusal arrives. The one documented shape of `detail.origin`:
 *   { workspace: 'roleplay', account, locator: { group: false, chat, avatar } | { group: true, chat } }
 * The locator is the one the review's scan route takes (a group locator has no avatar and no group id).
 * @param {{group?: boolean, chat?: string, avatar?: string}} locator A workflow locator
 * @param {string} account The handle the request ran under
 * @returns {object|undefined} undefined when the locator names no chat
 */
export function roleplayImageOrigin(locator, account) {
    const chat = typeof locator?.chat === 'string' ? locator.chat.replace(/\.jsonl$/, '') : '';
    if (!chat) return undefined;
    if (locator.group === true) return { workspace: 'roleplay', account, locator: { group: true, chat } };
    return typeof locator.avatar === 'string' && locator.avatar ? { workspace: 'roleplay', account, locator: { group: false, chat, avatar: locator.avatar } } : undefined;
}

/**
 * The origin of a refused Conversation request or job: the thread and branch it was for, and the account. Taken from the request
 * as it started, or from the job record (avatar, group, persona, branch and the branch's createdAt), never from the thread that is
 * open when the refusal arrives. The one documented shape of `detail.origin`:
 *   { workspace: 'conversation', account, avatar, groupId, personaId, branchId, lifetimeSeed?, createdAt? }
 * lifetimeSeed and createdAt tell the branch apart from a later one that reuses its id; each is present only where the route knows it.
 * @param {{avatar?: string, groupId?: string, personaId?: string, branchId?: string, lifetimeSeed?: string, createdAt?: string|number}} target
 * @param {string} account The handle the request ran under
 * @returns {object|undefined} undefined when the target names no character or branch
 */
export function conversationImageOrigin({ avatar, groupId, personaId, branchId, lifetimeSeed, createdAt } = {}, account) {
    if (!avatar || !branchId) return undefined;
    return { workspace: 'conversation', account, avatar: String(avatar), groupId: String(groupId ?? ''), personaId: String(personaId ?? ''), branchId: String(branchId),
        ...(lifetimeSeed ? { lifetimeSeed: String(lifetimeSeed) } : {}), ...(createdAt !== undefined && createdAt !== null && createdAt !== '' ? { createdAt: String(createdAt) } : {}) };
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

/** The scope ('account', 'chat' or 'branch') only picks the message, so each setting names the control that repairs it. */
export function validateImagePreference(value, scope = 'chat') {
    if (value === undefined) return 'include';
    if (!object(value) || value.version !== 1 || !['include', 'display-only'].includes(value.images)
        || Object.keys(value).some(key => !['version', 'images'].includes(key))) {
        throw promptMediaError('invalid-policy', -1, -1, scope === 'account'
            ? uiText('The saved setting \'Don\'t send chat images to the model\' is damaged. Turn it off and on again in User Settings.')
            : scope === 'branch'
                ? uiText('This branch\'s saved setting for sending images is damaged. Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.')
                : uiText('This chat\'s saved setting for sending images is damaged. Turn \'Don\'t send this chat\'s images to the model\' off and on again in Review chat images.'));
    }
    return value.images;
}

/** Bind only immutable decisions, never the browser's display state or capability guesses. */
export function createPromptMediaContext(settings, metadata = {}, controls = {}, { backend = 'chat', chatScope = 'chat' } = {}) {
    const account = validateImagePreference(settings?.power_user?.neconyan_prompt_media, 'account');
    const chat = validateImagePreference(metadata?.neconyan_prompt_media, chatScope);
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
        throw promptMediaError('invalid-policy', index, mediaIndex, uiText('An image\'s saved choice is damaged. Choose again for it in Review chat images.'));
    }
    if (!hash || policy.attachment_hash !== hash(attachmentIdentity(item))) {
        throw promptMediaError('stale-policy', index, mediaIndex, uiText('An image changed after its choice was saved. Choose again for it in Review chat images.'));
    }
    if (policy.image_url !== undefined && (typeof policy.image_url !== 'string' || !policy.image_url.startsWith('/user/images/'))
        || policy.original_evidence !== undefined && (!object(policy.original_evidence)
            || Object.keys(policy.original_evidence).some(key => key !== 'rawHash') || !/^[a-f0-9]{64}$/.test(policy.original_evidence.rawHash))) {
        throw promptMediaError('invalid-policy', index, mediaIndex, uiText('An image\'s compatible copy record is damaged. Prepare a new copy in Review chat images.'));
    }
    return policy;
}

function description(record, item, policy, index, mediaIndex) {
    const caption = policy.caption;
    if (!object(caption) || !['media-title', 'message-title', 'custom'].includes(caption.source)
        || Object.keys(caption).some(key => !['source', 'text'].includes(key))) {
        throw promptMediaError('missing-description', index, mediaIndex, uiText('An image set to Use a description has no description. Choose or type one in Review chat images.'));
    }
    const value = caption.source === 'media-title' ? item.title : caption.source === 'message-title' ? record.extra?.title : caption.text;
    if (typeof value !== 'string' || !value.trim() || bytes(value) > 16 * 1024) {
        throw promptMediaError('missing-description', index, mediaIndex, uiText('An image\'s description is missing or longer than 16 KiB. Edit it in Review chat images.'));
    }
    return value;
}

/** Legacy image fields are interpreted only in the derived prompt, never rewritten here. */
function mediaFor(record, index) {
    const extra = record.extra ?? {};
    if (extra.media !== undefined) {
        if (!Array.isArray(extra.media)) throw promptMediaError('malformed-media', index, -1, uiText('A message\'s attachment list is damaged. Review it in Review chat images.'));
        return { media: extra.media, legacy: false };
    }
    if (Object.hasOwn(extra, 'image') || Object.hasOwn(extra, 'image_swipes')) {
        const urls = extra.image_swipes === undefined ? [extra.image] : extra.image_swipes;
        if (!Array.isArray(urls) || !urls.length || urls.some(url => typeof url !== 'string' || !url)) {
            throw promptMediaError('legacy-media', index, -1, uiText('A message\'s older image attachment is damaged. Review it in Review chat images.'));
        }
        return { media: urls.map(url => ({ type: 'image', url, title: extra.title, append_title: extra.append_title })), legacy: true };
    }
    return { media: [], legacy: false };
}

/** Preserve source coordinates even when no media is selected. Never reads a URL. */
export function selectPromptMedia(records, context, { hash, includeCaptionReads = false } = {}) {
    if (context?.version !== PROMPT_MEDIA_VERSION) throw promptMediaError('policy-version', -1, -1, uiText('The page and the server are running different versions. Reload the page, then try again.'));
    if (!['include', 'display-only'].includes(context.account) || !['include', 'display-only'].includes(context.chat)
        || typeof context.inlineImages !== 'boolean' || typeof context.automaticCaptions !== 'boolean') throw promptMediaError('invalid-policy', -1, -1, uiText('Image settings could not be read. Reload the page, then try again.'));
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
            if (!['gallery', 'list'].includes(mode)) throw promptMediaError('invalid-display', index, -1, uiText('A message has an unknown image layout. Switch it to list or gallery, then try again.'));
            selected = legacy ? Math.max(0, media.findIndex(item => item.url === extra.image)) : extra.media_index === undefined ? 0 : extra.media_index;
            if (mode === 'gallery' && (!Number.isSafeInteger(selected) || selected < 0 || selected >= media.length)) {
                throw promptMediaError('invalid-selection', index, -1, uiText('A gallery\'s chosen image no longer exists. Pick another image in that gallery, or fix it in Review chat images.'));
            }
        }
        const included = [], additions = [];
        for (const [mediaIndex, item] of media.entries()) {
            if (!object(item) || !['image', 'video', 'audio'].includes(item.type ?? 'image')) {
                throw promptMediaError('malformed-media', index, mediaIndex, uiText('A message has a damaged attachment. Remove it in Review chat images.'));
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
            if (decision.send || includeCaptionReads && read) {
                const projectedItem = { ...item, append_title: false };
                if (policy.image_url) {
                    projectedItem.url = policy.image_url;
                    // The derived attachment now names the resolved copy. Keep its policy bound to
                    // that URL for subsequent prompt passes; the saved record retains source evidence.
                    projectedItem.neconyan_prompt = { version: policy.version, mode: policy.mode,
                        attachment_hash: hash(attachmentIdentity(projectedItem)) };
                }
                included.push(projectedItem);
            }
        }
        if (included.length > 4) throw promptMediaError('too-many-images', index, -1, uiText('A message would send more than four images. Set some to Show only, or show them as a gallery so only one is sent.'));
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
