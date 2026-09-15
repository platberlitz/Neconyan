import { SECTION_LABEL } from './constants.js';
import { canonicalOutbound, contentToText } from './message-content.js';

/**
 * Compares a run against a baseline.
 *
 * Pure. This decides whether a prompt changed; rendering the difference for a
 * human to read is a separate job.
 */

function sectionLabel(id) {
    return SECTION_LABEL[id] ?? id;
}

function sectionOccurrences(run) {
    const occurrences = new Map();
    const list = [];
    for (const section of run?.capture?.sections ?? []) {
        if (section?.id) {
            const occurrence = occurrences.get(section.id) ?? 0;
            occurrences.set(section.id, occurrence + 1);
            list.push({ ...section, occurrence, key: `${section.id}\u0000${occurrence}` });
        }
    }
    return list;
}

/**
 * Replaces the parts of a prompt that are expected to differ every time, so a
 * random roll or a timestamp does not report itself as a regression.
 * Spans are matched as literal text and replaced with a stable placeholder.
 */
function placeholderFor(span) {
    return `⟨${span?.macro ? `macro:${span.macro}` : 'changes each time'}⟩`;
}

export function normalizeVolatile(text, spans = []) {
    let source = String(text ?? '');
    const applicable = Array.isArray(spans) ? spans.filter(Boolean) : [];

    // Legacy runs may only have the two observed values. Replace one literal
    // occurrence, never a whole surrounding region or every matching value.
    const unanchored = applicable.filter(span => !span?.anchorBefore
        && !span?.anchorAfter
        && (span?.text || span?.otherText));
    const matches = [];
    for (const span of unanchored) {
        for (const candidate of new Set([span?.text, span?.otherText].filter(Boolean).map(String))) {
            const index = source.indexOf(candidate);
            if (index !== -1 && source.indexOf(candidate, index + candidate.length) === -1) {
                matches.push({ span, candidate, index });
            }
        }
    }
    if (matches.length === 1) {
        const { span, candidate, index } = matches[0];
        source = `${source.slice(0, index)}${placeholderFor(span)}${source.slice(index + candidate.length)}`;
    }

    // Anchored masking first. A value that differs on every build cannot be
    // matched by the text one run happened to produce, but the unchanged text
    // around it can be, so mask whatever sits between those anchors.
    for (const span of applicable) {
        const before = String(span?.anchorBefore ?? '');
        const after = String(span?.anchorAfter ?? '');
        if (before && after) {
            const start = source.indexOf(before);
            const end = start === -1 ? -1 : source.indexOf(after, start + before.length);
            const unique = start !== -1
                && end !== -1
                && source.indexOf(before, start + 1) === -1
                && source.indexOf(after) === end
                && source.indexOf(after, end + 1) === -1;
            if (unique) {
                source = `${source.slice(0, start)}${before}${placeholderFor(span)}${source.slice(end)}`;
            }
        }
    }

    // Anchors define the only safe region for a value that was observed in an
    // earlier run. Do not replace that value globally: it may also occur in a
    // genuinely edited part of the same section.
    return source;
}

/**
 * Compares two runs section by section.
 * @returns {{changedSections: string[], addedSections: string[], removedSections: string[],
 *   tokenDeltas: object[], totalDelta: number, identical: boolean, summary: string}}
 */
export function compareRuns(run, baseline, { volatileSpans = [], normalize = true } = {}) {
    const current = sectionOccurrences(run);
    const previous = sectionOccurrences(baseline);
    const currentByKey = new Map(current.map(section => [section.key, section]));
    const previousByKey = new Map(previous.map(section => [section.key, section]));
    const spans = normalize && Array.isArray(volatileSpans) ? volatileSpans : [];

    const addedSections = current.filter(section => !previousByKey.has(section.key)).map(section => section.id);
    const removed = previous.filter(section => !currentByKey.has(section.key));
    const removedSections = removed.map(section => section.id);
    const changedSections = [];
    const tokenDeltas = [];

    for (const section of current) {
        const { id, occurrence } = section;
        const before = previousByKey.get(section.key);
        const currentTokens = Number(section.tokens ?? 0);
        const baselineTokens = Number(before?.tokens ?? 0);
        if (before) {
            const sectionSpans = spans.filter(span => (!span?.section || span.section === id)
                && (span?.occurrence === undefined || span.occurrence === occurrence));
            const a = normalizeVolatile(contentToText(before.content), sectionSpans);
            const b = normalizeVolatile(contentToText(section.content), sectionSpans);
            if (a !== b) {
                changedSections.push(id);
            }
        }
        tokenDeltas.push({
            id,
            occurrence,
            label: sectionLabel(id),
            baseline: baselineTokens,
            current: currentTokens,
            delta: currentTokens - baselineTokens,
            status: before ? 'present' : 'added',
        });
    }

    for (const before of removed) {
        const id = before.id;
        tokenDeltas.push({
            id,
            occurrence: before?.occurrence ?? 0,
            label: sectionLabel(id),
            baseline: Number(before?.tokens ?? 0),
            current: 0,
            delta: -Number(before?.tokens ?? 0),
            status: 'removed',
        });
    }

    const totalDelta = Number(run?.capture?.tokenTable?.total ?? 0)
        - Number(baseline?.capture?.tokenTable?.total ?? 0);
    const currentKeys = current.map(section => section.key);
    const previousKeys = previous.map(section => section.key);
    const sameOccurrences = currentKeys.length === previousKeys.length
        && currentKeys.every(key => previousByKey.has(key));
    const sectionOrderChanged = sameOccurrences
        && currentKeys.some((key, index) => key !== previousKeys[index]);
    const outboundChanged = canonicalIdentity(run?.capture, spans)
        !== canonicalIdentity(baseline?.capture, spans);
    const identical = changedSections.length === 0
        && addedSections.length === 0
        && removedSections.length === 0
        && !sectionOrderChanged
        && !outboundChanged;

    return {
        changedSections,
        addedSections,
        removedSections,
        tokenDeltas,
        totalDelta,
        sectionOrderChanged,
        outboundChanged,
        identical,
        summary: describeComparison({
            changedSections,
            addedSections,
            removedSections,
            totalDelta,
            sectionOrderChanged,
            outboundChanged,
        }),
    };
}

function canonicalIdentity(capture, spans) {
    try {
        return canonicalOutbound(capture, {
            mapText: text => normalizeVolatile(text, spans),
        });
    } catch {
        return null;
    }
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function describeComparison({
    changedSections = [],
    addedSections = [],
    removedSections = [],
    totalDelta = 0,
    sectionOrderChanged = false,
    outboundChanged = false,
}) {
    const parts = [];
    if (changedSections.length) {
        parts.push(`${plural(changedSections.length, 'section')} changed`);
    }
    if (addedSections.length) {
        parts.push(`${plural(addedSections.length, 'section')} added`);
    }
    if (removedSections.length) {
        parts.push(`${plural(removedSections.length, 'section')} removed`);
    }
    if (sectionOrderChanged) {
        parts.push('section order changed');
    }
    if (outboundChanged && !changedSections.length && !addedSections.length && !removedSections.length) {
        parts.push('the final outbound prompt changed');
    }
    if (!parts.length) {
        return 'This prompt is the same as the baseline.';
    }
    const tokens = totalDelta === 0
        ? 'the same number of tokens'
        : `${Math.abs(totalDelta).toLocaleString()} ${totalDelta > 0 ? 'more' : 'fewer'} tokens`;
    return `${parts.join(', ')}, using ${tokens}.`;
}

/**
 * Finds the pieces of text that differ between two builds of the same prompt.
 * Anything that changes when nothing else did is by definition not fixed
 * content: a random roll, a timestamp, a counter.
 */
export const ANCHOR_LENGTH = 24;

export function findVolatileSpans(first, second) {
    if (!first || !second) {
        return [];
    }
    const spans = [];
    const firstSections = sectionOccurrences(first);
    const secondSections = new Map(sectionOccurrences(second).map(section => [section.key, section]));

    for (const section of firstSections) {
        const id = section.id;
        const other = secondSections.get(section.key);
        const content = contentToText(section.content);
        const otherContent = contentToText(other?.content);
        if (!other || otherContent === content) {
            continue;
        }
        if (differenceHunkCount(content, otherContent) !== 1) {
            return [];
        }
        const span = differingSpan(content, otherContent);
        if (span) {
            // The value itself is different every run, so a later comparison
            // cannot find it by its text. The unchanged text on either side is
            // what stays put, so record that too and mask what sits between.
            spans.push({
                section: id,
                occurrence: section.occurrence,
                text: span.a,
                otherText: span.b,
                anchorBefore: content.slice(Math.max(0, span.start - ANCHOR_LENGTH), span.start),
                anchorAfter: content.slice(span.start + span.a.length, span.start + span.a.length + ANCHOR_LENGTH),
            });
            if (spans.length > 1) {
                return [];
            }
        }
    }
    return spans;
}

function differenceHunkCount(first, second) {
    const Engine = globalThis.diff_match_patch;
    if (typeof Engine === 'function') {
        const parts = new Engine().diff_main(first, second);
        let count = 0;
        let changing = false;
        for (const [operation, text] of parts) {
            if (!text) {
                continue;
            }
            if (operation === 0) {
                changing = false;
            } else if (!changing) {
                count += 1;
                changing = true;
            }
        }
        return count;
    }

    const span = differingSpan(first, second);
    if (!span) {
        return 0;
    }
    // ponytail: the host supplies diff-match-patch. Without it, any shared
    // character inside the broad replacement could be a stable middle hunk,
    // so reject normalization rather than hide an edit.
    const firstCharacters = new Set(span.a);
    return [...span.b].some(character => firstCharacters.has(character)) ? 2 : 1;
}

/** Narrows two strings down to the part between their common ends. */
export function differingSpan(a, b) {
    const first = String(a ?? '');
    const second = String(b ?? '');
    if (first === second) {
        return null;
    }
    let start = 0;
    const max = Math.min(first.length, second.length);
    while (start < max && first[start] === second[start]) {
        start += 1;
    }
    let end = 0;
    while (
        end < max - start
        && first[first.length - 1 - end] === second[second.length - 1 - end]
    ) {
        end += 1;
    }
    return {
        a: first.slice(start, first.length - end),
        b: second.slice(start, second.length - end),
        start,
    };
}
