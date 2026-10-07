/*
 * Tracker templates describe their note lines as `note: MANDATORY; explain ...`, and some
 * models copy the marker into the real value. Strip it only where it opens a field value
 * (`label: MANDATORY; ...`), so prose that merely uses the word stays untouched.
 */
const MANDATORY_FIELD_MARKER = /^([ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?\p{L}[\p{L}\p{N} _'\u2019-]{0,40}?(?:\*\*|__)?:(?:\*\*|__)?[ \t]*)(?:\(MANDATORY\)|\[MANDATORY\]|MANDATORY[ \t]*[;:,\-\u2013\u2014])[ \t]*/gmu;

/**
 * Removes the template's `MANDATORY;` marker from the start of tracker field values.
 * @param {string} text
 * @returns {string}
 */
export function stripTrackerMandatoryMarkers(text) {
    if (typeof text !== 'string' || !text.includes('MANDATORY')) {
        return text;
    }

    return text.replace(MANDATORY_FIELD_MARKER, '$1');
}
