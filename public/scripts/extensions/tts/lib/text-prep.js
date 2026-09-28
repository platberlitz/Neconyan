import { regexFromString } from '../../../regex-utils.js';

/**
 * Pure TTS text preparation shared by the browser TTS extension and the
 * server-side Conversation narrator, so automatic narration filters text the
 * same way manual playback does. No imports beyond regex-utils; safe in Node.
 */

export function escapeRegex(string) {
    return String(string ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Neconyan: filter action blocks before quote extraction so quoted actions remain excluded from dialogue-only narration.
export function filterTtsAsterisks(text, { narrateDialoguesOnly = false, passAsterisks = false } = {}) {
    if (passAsterisks) {
        return text;
    }

    return narrateDialoguesOnly
        ? text.replace(/\*[^*]*?(\*|$)/g, '').trim()
        : text.replaceAll('*', '').trim();
}

// Neconyan: discard semantic blocks before quote extraction without dropping dialogue wrapped in presentation tags.
export function stripTtsTaggedBlocks(text, { preserveFormatting = false } = {}) {
    const formattingTags = new Set([
        'b', 'big', 'em', 'font', 'i', 'mark', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'u',
    ]);
    let filteredText = String(text ?? '');
    let previousText;

    do {
        previousText = filteredText;
        filteredText = filteredText.replace(
            /<([a-z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
            (_block, tagName, content) => preserveFormatting && formattingTags.has(tagName.toLowerCase()) ? content : '',
        );
    } while (filteredText !== previousText);

    return filteredText;
}

/**
 * Extract and join quoted blocks with proper matching pairs and nesting.
 * - Captures outermost quotes and everything inside (including different inner quote styles).
 * - Requires matching opener/closer style (e.g., " ... ", 「 ... 」, « ... », etc.).
 * - Ignores incomplete/unclosed quotes (doesn't include them in the result).
 * - Symmetric quotes like "..." and ＂...＂ are supported (not nesting the same symmetric style).
 */
export function joinQuotedBlocks(text, opts = {}) {
    const {
        separator = ' ... ',
        includeQuotes = true,
        returnEmptyOnNoQuotes = false,
        pairs = [
            // typographic doubles
            ['„', '“'],          // DE low-high
            ['“', '”'],          // EN
            ['«', '»'],          // FR open « close »
            ['»', '«'],          // Some locales open »
            // typographic singles
            ['‘', '’'],
            ['‚', '‘'],
            // Japanese corner quotes
            ['「', '」'],
            ['『', '』'],
            // symmetric doubles
            ['"', '"'],
            ['＂', '＂'],
        ],
    } = opts;

    if (!text || typeof text !== 'string') return text;

    const openToClose = Object.fromEntries(pairs);

    const segments = [];
    const stack = []; // [{ opener, expectedClose, start }]
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const top = stack[stack.length - 1];

        // Prefer closing the current open pair if the char matches its expected closer
        if (top && ch === top.expectedClose) {
            const finished = stack.pop();
            if (stack.length === 0) {
                // Only collect outermost quotes (contains all nested content)
                segments.push(text.slice(finished.start, i + 1));
            }
            continue;
        }

        // Otherwise, see if this is a new opener
        if (openToClose[ch]) {
            stack.push({ opener: ch, expectedClose: openToClose[ch], start: i });
            continue;
        }

        // If it's a stray closer that doesn't match current top, ignore
    }

    if (!segments.length) return returnEmptyOnNoQuotes ? '' : text;

    const cleaned = includeQuotes
        ? segments
        : segments.map(s => s.slice(1, -1)); // all defined pairs are single-char quotes

    return cleaned.join(separator);
}

export function parseMessageSegments(text, multiVoiceEnabled = false) {
    if (!multiVoiceEnabled) {
        return [{ type: 'other', text: text }];
    }

    const segments = [];
    const segmentRegex = /(\*[^*]*?\*)|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;
    let lastIndex = 0;
    let match;

    segmentRegex.lastIndex = 0;

    while ((match = segmentRegex.exec(text)) !== null) {
        // Add other text before this match
        if (match.index > lastIndex) {
            const otherText = text.substring(lastIndex, match.index).trim();
            if (otherText && otherText.length > 0) {
                segments.push({ type: 'other', text: otherText });
            }
        }

        const matchedText = match[0];
        let segmentType = 'other';
        let content = '';

        if (match[1]) {
            // Asterisk content (*action*)
            segmentType = 'action';
            content = matchedText.slice(1, -1);
        } else if (match[2] || match[3] || match[4] || match[5] || match[6] || match[7]) {
            // Various quote types ("dialogue")
            segmentType = 'dialogue';
            content = matchedText.slice(1, -1);
        }

        // Trim and check for actual content
        content = content.trim();
        if (content.length > 0) {
            segments.push({
                type: segmentType,
                text: content,
            });
        }

        lastIndex = match.index + matchedText.length;
    }

    // Add remaining other text after last match
    if (lastIndex < text.length) {
        const otherText = text.substring(lastIndex).trim();
        if (otherText.length > 0) {
            segments.push({ type: 'other', text: otherText });
        }
    }

    // If no segments found and not empty, treat whole text as other text
    if (segments.length === 0 && text.trim().length > 0) {
        segments.push({ type: 'other', text: text.trim() });
    }

    return segments;
}

export const DEFAULT_TTS_VOICE_MARKER = '[Default Voice]';
export const DISABLED_TTS_VOICE_MARKER = 'disabled';

/** Resolve a voice-map entry, following the "[Default Voice]" indirection. */
export function resolveTtsVoiceMapEntry(voiceMap, key, {
    defaultMarker = DEFAULT_TTS_VOICE_MARKER,
    disabledMarker = DISABLED_TTS_VOICE_MARKER,
} = {}) {
    const map = voiceMap && typeof voiceMap === 'object' ? voiceMap : {};
    let direct = map[key] === defaultMarker ? map[defaultMarker] : map[key];
    if (direct === undefined && key !== defaultMarker && Object.prototype.hasOwnProperty.call(map, defaultMarker)) {
        // The browser seeds every character with the default marker during init, so
        // a character absent from the saved map still inherits the configured default.
        direct = map[defaultMarker];
    }
    return { entry: direct, disabled: direct === disabledMarker };
}

/** Normalise a saved voice map that may be a legacy "name:id,name:id" string. */
export function parseTtsVoiceMap(value) {
    if (value && typeof value === 'object') {
        return value;
    }
    const map = {};
    for (const entry of String(value ?? '').split(',')) {
        const separator = entry.indexOf(':');
        const name = separator < 0 ? '' : entry.slice(0, separator).trim();
        const voice = separator < 0 ? '' : entry.slice(separator + 1).trim();
        if (name && voice) {
            map[name] = voice;
        }
    }
    return map;
}

/**
 * Mirror the browser TTS queue's text preparation for a single narration.
 * `substitute` is the macro substitution callback; `displayText` is the
 * translated text used when narrate_translated_only is on.
 */
export function prepareTtsNarrationText(text, tts = {}, {
    characterName = '',
    allowName2Display = false,
    substitute = null,
    processText = null,
    displayText = '',
    separator = ' ... ',
} = {}) {
    let result = tts.narrate_translated_only ? String(displayText || text || '') : String(text ?? '');

    if (typeof substitute === 'function') {
        result = substitute(result);
    }

    if (tts.skip_codeblocks) {
        result = result.replace(/```.*?```/gs, '').trim();
        result = result.replace(/~~~.*?~~~/gs, '').trim();
    }

    result = filterTtsAsterisks(result, {
        narrateDialoguesOnly: tts.narrate_dialogues_only,
        passAsterisks: tts.pass_asterisks,
    });

    // Neconyan: Strip tag markup before quote extraction so wrappers preserve dialogue without narrating attributes.
    if (tts.narrate_quoted_only) {
        if (tts.skip_tags) {
            result = stripTtsTaggedBlocks(result, { preserveFormatting: true });
        }
        result = result.replace(/<.*?>/g, '').trim();
        result = joinQuotedBlocks(result, { separator, includeQuotes: true });
    }

    if (tts.skip_tags) {
        result = result.replace(/<.*?>[\s\S]*?<\/.*?>/g, '').trim();
    }

    if (tts.apply_regex && tts.regex_pattern) {
        const regex = regexFromString(tts.regex_pattern);
        if (regex) {
            result = result.replace(regex, '').replace(/\s+/g, ' ').trim();
        }
    }

    // Remove embedded images
    result = result.replace(/!\[.*?]\([^)]*\)/g, '');

    if (typeof processText === 'function') result = processText(result);

    // Collapse newlines and spaces into single space
    result = result.replace(/\s+/g, ' ').trim();

    // Remove character name from start of the line if power user setting is disabled
    if (characterName && !allowName2Display) {
        result = result.replace(new RegExp(`^${escapeRegex(characterName)}:`, 'gm'), '');
    }

    return result;
}
