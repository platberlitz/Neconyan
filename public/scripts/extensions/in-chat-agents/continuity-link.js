// Links the Continuity Companion and the Continuity Corrector when both are switched on:
// the Corrector reads the Companion's latest note, and the Companion hears what the Corrector fixed.
// Shared by the browser runner and the server Roleplay runner, so keep it free of DOM and app imports.

import { getActiveCompanionResults, isEmptyOutputSentinel } from './companion/companion-shared.js';

export const CONTINUITY_COMPANION_TEMPLATE_ID = 'tpl-continuity-companion';
export const CONTINUITY_CORRECTOR_TEMPLATE_ID = 'tpl-continuity-corrector';
export const CONTINUITY_NOTES_MACRO = 'continuity-notes';
export const CONTINUITY_CORRECTIONS_MACRO = 'continuity-corrections';

const MAX_SENTENCES = 400;
const MAX_CORRECTIONS = 12;
const MAX_CORRECTION_CHARS = 300;
const SENTENCE_BREAK = /(?<=[.!?…"”])\s+|\n+/;

const fromTemplate = (agent, templateId) => agent?.id === templateId || agent?.sourceTemplateId === templateId;

export function isContinuityCompanion(agent) {
    return fromTemplate(agent, CONTINUITY_COMPANION_TEMPLATE_ID);
}

export function isContinuityCorrector(agent) {
    return fromTemplate(agent, CONTINUITY_CORRECTOR_TEMPLATE_ID);
}

const enabled = agents => (Array.isArray(agents) ? agents : []).filter(agent => agent && agent.enabled !== false);

function sentences(value) {
    return String(value ?? '').split(SENTENCE_BREAK).map(part => part.trim()).filter(Boolean);
}

function shorten(value) {
    return value.length > MAX_CORRECTION_CHARS ? `${value.slice(0, MAX_CORRECTION_CHARS - 1).trimEnd()}…` : value;
}

/**
 * The sentences a rewrite changed, removed or added, oldest first.
 * @param {string} before Text the rewrite received.
 * @param {string} after Text the rewrite returned.
 * @returns {{ before: string, after: string }[]}
 */
export function describeTextCorrections(before, after) {
    const left = sentences(before);
    const right = sentences(after);
    if (!right.length || left.join('\n') === right.join('\n')) return [];
    if (left.length > MAX_SENTENCES || right.length > MAX_SENTENCES) {
        return [{ before: '', after: 'The reply was rewritten too heavily to list each change.' }];
    }
    const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
    }
    const corrections = [];
    let removed = [];
    let added = [];
    const flush = () => {
        if (removed.length || added.length) corrections.push({ before: shorten(removed.join(' ')), after: shorten(added.join(' ')) });
        removed = [];
        added = [];
    };
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) {
            flush();
            i++;
            j++;
        } else if (j < right.length && (i >= left.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
            added.push(right[j++]);
        } else {
            removed.push(left[i++]);
        }
    }
    flush();
    return corrections.slice(0, MAX_CORRECTIONS);
}

function runCorrections(run) {
    if (Array.isArray(run.corrections)) return run.corrections;
    if (typeof run.beforeText === 'string' && typeof run.nextMessageText === 'string') {
        return describeTextCorrections(run.beforeText, run.nextMessageText);
    }
    // A run that failed has neither, and says nothing about the reply.
    return null;
}

/**
 * What enabled Continuity Correctors changed in a reply, read from its saved rewrite runs.
 * Returns null when no enabled Corrector finished a run on the reply.
 */
export function continuityCorrectionsFromRuns(runs, agents) {
    const correctors = new Set(enabled(agents).filter(isContinuityCorrector).map(agent => agent.id));
    const finished = (Array.isArray(runs) ? runs : [])
        .filter(run => run && correctors.has(run.agentId))
        .map(runCorrections)
        .filter(Array.isArray);
    return finished.length ? finished.flat().slice(0, MAX_CORRECTIONS) : null;
}

/** The text a Continuity Companion prompt receives about the Corrector's fixes. */
export function buildContinuityCorrectionsText(corrections) {
    if (!Array.isArray(corrections)) return '';
    if (!corrections.length) return 'The Continuity Corrector made no changes to this reply.';
    return corrections.map(({ before = '', after = '' }) => {
        if (before && after) return `- Changed "${before}" to "${after}"`;
        if (before) return `- Removed "${before}"`;
        return `- Added "${after}"`;
    }).join('\n');
}

/**
 * The newest finished note an enabled Continuity Companion wrote before the reply being corrected.
 * Empty unless a Continuity Companion is switched on.
 * @param {object[]} messages Chat messages before the reply.
 * @param {object[]} agents Agents in the chat.
 */
export function latestContinuityNotes(messages, agents) {
    const companions = enabled(agents).filter(isContinuityCompanion);
    if (!companions.length || !Array.isArray(messages)) return '';
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.is_user) continue;
        const stored = getActiveCompanionResults(message);
        for (const agent of companions) {
            const note = Object.hasOwn(stored, agent.id) ? stored[agent.id] : null;
            const content = String(note?.content ?? '').trim();
            if (note?.status === 'done' && content && !isEmptyOutputSentinel(content)) return content;
        }
    }
    return '';
}
