import { t, translate } from './i18n.js';

// The wording that depends on a value or a server code in the image review dialogs (prompt-media-ui.js). Each text is
// looked up when it is asked for, so it follows the interface language chosen by then. Nothing here touches the page.
// A sentence with a hole, and every short label, has a scoped key that only translate() reaches (D22); the rest use their
// own English as the key. Both are written with literal arguments because that is how the builder collects them.

/**
 * Fills the ${0}, ${1} holes of a looked-up template. The replacement is a function, so a value that holds $& or $1 is
 * inserted exactly as written.
 * @param {string} template
 * @param {...(string|number)} values
 * @returns {string}
 */
export function fillTemplate(template, ...values) {
    return String(template).replace(/\$\{(\d+)\}/g, (hole, index) => values[Number(index)] === undefined ? hole : String(values[Number(index)]));
}

/**
 * The sentence either side of a single ${0} hole, so a value can sit in its own element between them (the hole is for
 * a name, a path or a number, never a word of the sentence).
 * @param {string} template
 * @returns {[string, string]}
 */
export function splitAtHole(template) {
    const at = String(template).indexOf('${0}');
    return at < 0 ? [String(template), ''] : [template.slice(0, at), template.slice(at + 4)];
}

/**
 * One label for each status the scan can report (RVW-36). The completeness test compares these keys with the scan's list.
 * @returns {Record<string, string>}
 */
export function reviewStatusLabels() {
    return {
        'saved-reference': t`Saved on this server`,
        'missing-file': t`Missing: its file is no longer on the server`,
        'needs-compatible-copy': t`Needs a compatible copy: unsupported format, or larger than 2048 pixels`,
        'unreadable-or-over-limit': t`Needs a compatible copy: larger than 1 MiB, or unreadable`,
        'embedded-image': t`Stored inside the chat file`,
        'external-or-old-location': t`Linked from a website or an old location`,
        'invalid-gallery-selection': t`The gallery's chosen image is missing`,
        'malformed-attachment': translate('Damaged attachment', 'scoped.prompt_media.RVW-36.8'),
        'empty-attachment-list': translate('Empty attachment list', 'scoped.prompt_media.RVW-36.9'),
        'other-media': translate('Audio or video', 'scoped.prompt_media.RVW-36.10'),
    };
}

/**
 * @param {string} status A scan status
 * @returns {string} Its label. A status this page does not know (a newer server) shows as its own code.
 */
export function reviewStatusLabel(status) {
    return Object.hasOwn(reviewStatusLabels(), status) ? reviewStatusLabels()[status] : String(status);
}

/** The label beside the image's own saved description in a row (RVW-36). */
export const savedDescriptionLabel = () => translate('Saved description', 'scoped.prompt_media.RVW-36.11');

/**
 * The row legend in the Roleplay dialog (RVW-35): a complete phrase for each of the four cases.
 * @param {{index: number, swipe?: number|null, mediaIndex: number}} location Zero-based message, alternative and image
 * @returns {string}
 */
export function reviewLegend({ index, swipe = null, mediaIndex }) {
    const message = index + 1;
    const alternative = swipe === null || swipe === undefined ? null : swipe + 1;
    if (mediaIndex < 0) {
        return alternative === null
            ? fillTemplate(translate('Message ${0}, attachment list', 'scoped.prompt_media.RVW-35.3'), message)
            : fillTemplate(translate('Message ${0}, alternative ${1}, attachment list', 'scoped.prompt_media.RVW-35.4'), message, alternative);
    }
    return alternative === null
        ? fillTemplate(translate('Message ${0}, image ${1}', 'scoped.prompt_media.RVW-35.1'), message, mediaIndex + 1)
        : fillTemplate(translate('Message ${0}, alternative ${1}, image ${2}', 'scoped.prompt_media.RVW-35.2'), message, alternative, mediaIndex + 1);
}

/**
 * The row legend in the Conversation dialog (CNV-13).
 * @param {number} index Zero-based message
 * @param {number|null} mediaIndex Zero-based image, or null for the message's generated image
 * @returns {string}
 */
export function conversationImageLegend(index, mediaIndex) {
    return mediaIndex === null
        ? fillTemplate(translate('Message ${0}, generated image', 'scoped.prompt_media.CNV-13.2'), index + 1)
        : fillTemplate(translate('Message ${0}, image ${1}', 'scoped.prompt_media.RVW-35.1'), index + 1, mediaIndex + 1);
}

/** The legend over a message's older saved attachment text (CNV-18). */
export const conversationContextLegend = index => fillTemplate(translate('Message ${0}, saved attachment text', 'scoped.prompt_media.CNV-18'), index + 1);

/** The legend over a reply whose only saved context is a quote, with no saved attachment text (CNV-28). */
export const conversationQuoteLegend = index => fillTemplate(translate('Message ${0}, quote from another message', 'scoped.prompt_media.CNV-28'), index + 1);

/**
 * One label for each stage Change history can report (HIS-02), for a change whose backup is, or is not, still there. The
 * completeness test compares these keys with the server's list.
 * @param {{backupAvailable?: boolean}} [state]
 * @returns {Record<string, string>}
 */
export function historyStageLabels({ backupAvailable = true } = {}) {
    return {
        committed: backupAvailable ? translate('Completed', 'scoped.prompt_media.HIS-02.1') : translate('Completed, backup deleted', 'scoped.prompt_media.HIS-02.2'),
        'backup-verified': t`Prepared, not applied yet`,
        'native-write-pending': t`Interrupted while saving the chat`,
        'staging-incomplete': t`Preparation did not finish`,
        discarded: translate('Discarded', 'scoped.prompt_media.HIS-02.6'),
    };
}

/**
 * @param {{stage?: string, backupAvailable?: boolean}} operation A history entry
 * @returns {string} Its stage label. A stage this page does not know shows as its own code.
 */
export function historyStageLabel(operation) {
    const labels = historyStageLabels({ backupAvailable: operation?.backupAvailable === true });
    return Object.hasOwn(labels, operation?.stage) ? labels[operation.stage] : String(operation?.stage ?? '');
}

/**
 * A change's date and time in the interface language (HIS-02), for a translate="no" element. Nothing is shown for a missing or
 * unreadable date, and an unknown language falls back to English.
 * @param {string|null|undefined} value An ISO date
 * @param {string} [language] The interface language, as the page's lang attribute holds it
 * @returns {string}
 */
export function formatChangeDate(value, language = 'en') {
    const date = new Date(value ?? NaN);
    if (!value || Number.isNaN(date.getTime())) return '';
    const options = { dateStyle: 'medium', timeStyle: 'short' };
    try { return new Intl.DateTimeFormat(language || 'en', options).format(date); } catch { return new Intl.DateTimeFormat('en', options).format(date); }
}

/**
 * The sentence for each error code the conversion worker can post (CPY-23, CPY-30 to CPY-39). The worker has no
 * translation, so it posts a code and this page picks the sentence. 'failed' is also used for anything the worker did not
 * expect and for a worker that could not start (CPY-25).
 * @returns {Record<string, string>}
 */
export function workerErrorMessages() {
    return {
        'too-large': t`Choose an image smaller than 16 MiB.`,
        animated: t`Animated images cannot be converted. Choose a still image.`,
        'png-incomplete': t`This PNG file is incomplete. Choose another image.`,
        'webp-incomplete': t`This WebP file is incomplete. Choose another image.`,
        'jpeg-damaged': t`This JPEG file is damaged. Choose another image.`,
        'jpeg-incomplete': t`This JPEG file is incomplete. Choose another image.`,
        unsupported: t`Choose a PNG, JPEG or WebP still image of at most 16 million pixels.`,
        'too-many-pixels': t`This image has more than 16 million pixels. Choose a smaller one.`,
        'still-too-large': t`Even converted, this image is larger than 1 MiB. Choose a smaller one.`,
        'result-too-large': t`The converted image is too large. Choose a smaller one.`,
        failed: t`This browser could not convert the image. Choose a PNG, JPEG or WebP file instead.`,
    };
}

/**
 * @param {string|undefined} code A code the worker posted
 * @returns {string} Its sentence; an unknown code gets the general one.
 */
export function workerErrorMessage(code) {
    const messages = workerErrorMessages();
    return Object.hasOwn(messages, code) ? messages[code] : messages.failed;
}

/**
 * The sources offered for an image's description, under Astra's three conditions (D20, RVW-40 to RVW-42, RVW-57 to RVW-59):
 * 1. a saved source (the image's own description, the message's title) is offered only when the scan says it has text;
 * 2. typing a description is always offered;
 * 3. a saved choice of a source that has no text now stays selected, under its 'no longer available' label, and the caller
 *    explains it. Nothing here changes the saved choice, and nothing selects another source.
 * @param {{mode?: string, caption?: {source?: string}, sources?: Record<string, boolean>}} issue A scan issue
 * @returns {{options: {value: string, label: string}[], selected: string, unavailable: string|null}}
 */
export function descriptionSourceOptions(issue) {
    const saved = issue?.caption?.source;
    const options = [{ value: 'custom', label: translate('Type a description', 'scoped.prompt_media.RVW-40') }];
    let unavailable = null;
    for (const [value, available, gone] of [
        ['media-title', t`The image's saved description`, t`The image's saved description (no longer available)`],
        ['message-title', t`The message's saved title`, t`The message's saved title (no longer available)`],
    ]) {
        if (issue?.sources?.[value] === true) options.push({ value, label: available });
        else if (saved === value && issue?.mode === 'caption') { options.push({ value, label: gone }); unavailable = value; }
    }
    return { options, selected: options.some(option => option.value === saved) ? saved : 'custom', unavailable };
}

/** The results of a change to several chats (BAT-09). */
export const batchResultText = {
    saved: () => t`Saved`,
    noImages: () => t`No images stored in the chat`,
    copiesSaved: count => fillTemplate(translate('Compatible copies saved: ${0}', 'scoped.prompt_media.BAT-09.3'), count),
};
