import { canGroupMemberSee } from '../../public/scripts/group-chat-visibility.js';
import { hash, sourceAt } from './core.js';

/**
 * The memory a group speaker may read. Lines they did not hear are left out, and so is every
 * memory written after the first such line: a memory cites only some of the messages it came
 * from, so one made later could still carry what they missed.
 * @param {object} state Mewmory state
 * @param {string[]|null} viewers Speakers the prompt is written for
 * @param {{ seesAll?: string[] }} [rules] The chat's scene rules
 * @returns {{ state: object, recordAsOf: number, key: string }|null} Null when they heard everything
 */
export function viewerState(state, viewers, rules = {}) {
    if (!Array.isArray(viewers) || !viewers.length) return null;
    const hidden = [];
    let recordAsOf = Infinity;
    for (const ref of state.timeline) {
        const audience = state.sources[ref.id]?.audience;
        if (!audience || viewers.every(viewer => canGroupMemberSee({ extra: { group_scene: audience } }, viewer, rules))) continue;
        hidden.push(ref.id);
        const sequence = sourceAt(state, ref)?.sequence;
        if (Number.isFinite(sequence)) recordAsOf = Math.min(recordAsOf, sequence - 1);
    }
    if (!hidden.length) return null;
    return {
        state: { ...state, excludedSources: [...new Set([...(state.excludedSources || []), ...hidden])] },
        recordAsOf,
        key: hash([...new Set(viewers)].sort()),
    };
}

/**
 * Reads the speakers a prompt is prepared for.
 * @param {unknown} value Request value
 * @param {(message: string, status?: number) => never} fail Error helper
 * @returns {string[]|null} Speakers, or null for an ordinary prompt
 */
export function readViewers(value, fail) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || !value.length || value.length > 64
        || value.some(viewer => typeof viewer !== 'string' || !viewer || viewer.length > 512)) {
        fail('Choose valid group speakers for Mewmory.', 400);
    }
    return [...new Set(value)];
}
