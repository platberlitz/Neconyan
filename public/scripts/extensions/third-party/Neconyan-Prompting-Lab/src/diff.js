import { normalizeVolatile } from './compare.js';

/**
 * Turns two versions of a piece of text into a list of parts to render.
 *
 * Uses the diff library Neconyan already bundles, so nothing extra is
 * shipped. When it is unavailable the whole text is reported as one
 * replacement rather than throwing, because a coarse diff is still useful.
 */

export const PART = Object.freeze({
    SAME: 'same',
    ADDED: 'added',
    REMOVED: 'removed',
});

function diffEngine() {
    const Engine = globalThis.diff_match_patch;
    return typeof Engine === 'function' ? new Engine() : null;
}

/**
 * @returns {{type: string, text: string}[]} parts in reading order.
 */
export function diffText(before, after, { volatileSpans = [], normalize = false, cleanup = true } = {}) {
    const a = normalize ? normalizeVolatile(before, volatileSpans) : String(before ?? '');
    const b = normalize ? normalizeVolatile(after, volatileSpans) : String(after ?? '');
    if (a === b) {
        return a ? [{ type: PART.SAME, text: a }] : [];
    }

    const engine = diffEngine();
    if (!engine) {
        const parts = [];
        if (a) {
            parts.push({ type: PART.REMOVED, text: a });
        }
        if (b) {
            parts.push({ type: PART.ADDED, text: b });
        }
        return parts;
    }

    const raw = engine.diff_main(a, b);
    if (cleanup && typeof engine.diff_cleanupSemantic === 'function') {
        engine.diff_cleanupSemantic(raw);
    }
    return raw
        .map(([op, text]) => ({
            type: op === 0 ? PART.SAME : (op === 1 ? PART.ADDED : PART.REMOVED),
            text,
        }))
        .filter(part => part.text.length > 0);
}

/**
 * Shortens the unchanged runs so a long prompt does not bury a small edit.
 */
export function collapseUnchanged(parts, { context = 60 } = {}) {
    return parts.map((part, index) => {
        if (part.type !== PART.SAME || part.text.length <= context * 2) {
            return part;
        }
        const isFirst = index === 0;
        const isLast = index === parts.length - 1;
        const head = isFirst ? '' : part.text.slice(0, context);
        const tail = isLast ? '' : part.text.slice(-context);
        const hidden = part.text.length - head.length - tail.length;
        return {
            ...part,
            text: `${head}\n… ${hidden.toLocaleString()} unchanged characters …\n${tail}`,
            collapsed: true,
        };
    });
}

/** Diffs one section of two runs. */
export function diffSection(baselineRun, currentRun, sectionId, options = {}) {
    const occurrence = options.occurrence ?? 0;
    const before = baselineRun?.capture?.sections?.filter(section => section.id === sectionId)[occurrence];
    const after = currentRun?.capture?.sections?.filter(section => section.id === sectionId)[occurrence];
    const volatileSpans = (options.volatileSpans ?? [])
        .filter(span => (!span?.section || span.section === sectionId)
            && (span?.occurrence === undefined || span.occurrence === occurrence));
    return {
        id: sectionId,
        occurrence,
        baselineTokens: Number(before?.tokens ?? 0),
        currentTokens: Number(after?.tokens ?? 0),
        parts: diffText(before?.content ?? '', after?.content ?? '', {
            ...options,
            volatileSpans,
        }),
        onlyInBaseline: Boolean(before) && !after,
        onlyInCurrent: !before && Boolean(after),
    };
}

/** True when a set of parts contains nothing but unchanged text. */
export function isUnchanged(parts) {
    return parts.every(part => part.type === PART.SAME);
}
