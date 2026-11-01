// Pure helpers for the bottom bar chat picker. The picker DOM lives in chat-picker.js.

const CHAT_NAME_UNSAFE_CHARACTERS = /[/?<>\\:*|"\x00-\x1f\x80-\x9f]/g;

/**
 * Character chats are saved as '<owner> - <date or label>'. The owner is the same on every
 * row of the picker, so the row shows only what tells the chats apart. New chat names
 * replace characters the server would refuse, so the cleaned owner name is tried too.
 * @param {string} fileName Raw chat file name, which stays the key for switching.
 * @param {string} [ownerName] Character or group name.
 * @returns {string}
 */
export function getChatPickerTitle(fileName, ownerName = '') {
    const raw = String(fileName ?? '').replace(/\.jsonl$/i, '').trim();
    const owner = String(ownerName ?? '').trim();
    if (!raw || !owner) {
        return raw;
    }

    const safeOwner = owner.replace(CHAT_NAME_UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    for (const variant of new Set([owner, safeOwner])) {
        const prefix = `${variant} - `;
        if (variant && raw.startsWith(prefix)) {
            const rest = raw.slice(prefix.length).trim();
            if (rest) {
                return rest;
            }
        }
    }

    return raw;
}

/**
 * Every word of the query must appear in the title, the raw file name or the preview.
 * @param {{ title?: string, fileName?: string, preview?: string }} entry
 * @param {string} query
 * @returns {boolean}
 */
export function matchesChatPickerQuery(entry, query) {
    const terms = String(query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
        return true;
    }

    const haystack = [entry?.title, entry?.fileName, entry?.preview]
        .map(value => String(value ?? '').toLocaleLowerCase())
        .join('\n');
    return terms.every(term => haystack.includes(term));
}

/**
 * Places the picker beside its trigger inside the visible viewport, which shrinks when a
 * phone keyboard opens. It opens above the trigger unless there is clearly more room below.
 * @param {object} options
 * @param {{ top: number, bottom: number, left: number }} options.anchor Trigger rectangle.
 * @param {{ top: number, left: number, width: number, height: number }} options.viewport Visible viewport.
 * @param {number} [options.preferredWidth=440]
 * @param {number} [options.preferredHeight=520]
 * @param {number} [options.minAboveHeight=240]
 * @param {number} [options.gap=8]
 * @param {number} [options.edge=8]
 * @returns {{ left: number, width: number, maxHeight: number, above: boolean, edgeTop: number }}
 */
export function resolveChatPickerPlacement({
    anchor,
    viewport,
    preferredWidth = 440,
    preferredHeight = 520,
    minAboveHeight = 240,
    gap = 8,
    edge = 8,
}) {
    const viewTop = viewport.top + edge;
    const viewBottom = viewport.top + viewport.height - edge;
    const viewLeft = viewport.left + edge;
    const viewRight = viewport.left + viewport.width - edge;
    const width = Math.max(0, Math.min(preferredWidth, viewRight - viewLeft));
    const left = Math.max(viewLeft, Math.min(anchor.left, viewRight - width));
    // A keyboard can cover the trigger; then the picker sits on the keyboard's top edge.
    const anchorTop = Math.min(anchor.top, viewBottom + gap);
    const spaceAbove = Math.max(0, anchorTop - gap - viewTop);
    const spaceBelow = Math.max(0, viewBottom - (anchor.bottom + gap));
    const above = spaceAbove >= Math.min(minAboveHeight, preferredHeight) || spaceAbove >= spaceBelow;
    const maxHeight = Math.max(0, Math.min(preferredHeight, above ? spaceAbove : spaceBelow));
    return {
        left: Math.round(left),
        width: Math.round(width),
        maxHeight: Math.floor(maxHeight),
        above,
        edgeTop: Math.round(above ? anchorTop - gap : anchor.bottom + gap),
    };
}
