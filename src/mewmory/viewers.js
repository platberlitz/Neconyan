import { canGroupMemberSee } from '../../public/scripts/group-chat-visibility.js';
import { hash, recordRevision, sourceAt } from './core.js';

/** A memory built from several memories carries each of their audiences, and a reader must be in all of them. */
const canHear = (audience, viewer, rules) => Array.isArray(audience)
    ? audience.every(one => canHear(one, viewer, rules))
    : !audience || canGroupMemberSee({ extra: { group_scene: audience } }, viewer, rules);

const heardByEveryone = audience => !audience || (audience.everyone === true && !audience.whisper_to?.length);

/** Whether a saved line comes before a group chat's memory starting point, so no member hears it. */
const beforeStart = (state, ref) => state.groupStart > 0 && (sourceAt(state, ref)?.sequence ?? -1) < state.groupStart;

/** Who heard a saved line, or null for a line everyone heard. */
export function sourceAudience(state, ref) {
    const audience = state.sources[ref?.id]?.audience;
    return heardByEveryone(audience) ? null : audience;
}

/** Lines heard by the same people share a key, so one extraction batch never mixes listeners. */
export function audienceKey(audience) {
    if (heardByEveryone(audience)) return '';
    const sorted = value => Array.isArray(value) ? [...new Set(value)].sort() : null;
    return JSON.stringify([sorted(audience.present), sorted(audience.whisper_to) ?? []]);
}

/** The first lines of a batch that the same people heard, so each memory has one audience. */
export function sameAudience(state, refs) {
    const first = audienceKey(sourceAudience(state, refs[0]));
    const cut = refs.findIndex(ref => audienceKey(sourceAudience(state, ref)) !== first);
    return cut > 0 ? refs.slice(0, cut) : refs;
}

/** The group members a story knows, from its character cards. */
export function groupMembers(state) {
    return (state.contextSources || []).flatMap(ref => {
        if (state.sources[ref.id]?.type !== 'character') return [];
        const revision = sourceAt(state, ref);
        return revision?.meta?.avatar ? [{ avatar: revision.meta.avatar, entityId: revision.entityId || '' }] : [];
    });
}

/** Whether a memory version says who may read it. Older memories carry no such mark. */
const marked = record => Boolean(record?.provenance) && Object.hasOwn(record.provenance, 'audience');

/**
 * Who may read a memory written only from other memories, such as a Pawspective interview: the
 * members who may read every version it was built on. An older version names no listeners, so it
 * counts as every line up to it, as the fallback rule in viewerState reads it.
 * @param {object} state Mewmory state
 * @param {{ id: string, version: number }[]} dependencies Memory versions it was built on
 * @returns {object|object[]|null} One audience, several that all apply, or null for everyone
 */
export function memoryAudience(state, dependencies) {
    const audiences = dependencies.flatMap(({ id, version }) => {
        const record = recordRevision(state, id, version);
        if (marked(record)) return [record.provenance.audience].flat();
        const asOf = record?.asOf ?? Infinity;
        return state.timeline.filter(ref => sourceAt(state, ref)?.sequence <= asOf).map(ref => sourceAudience(state, ref));
    }).filter(Boolean);
    const unique = [...new Map(audiences.map(audience => [audienceKey(audience), audience])).values()];
    return unique.length ? structuredClone(unique.length === 1 ? unique[0] : unique) : null;
}

/** The last chat line a saved memory version was built from, or Infinity when nobody can say. */
function memoryReach(state, id, version) {
    const record = Number.isInteger(version) ? recordRevision(state, id, version) : state.records.find(entry => entry.id === id);
    if (!record) return Infinity;
    const reach = marked(record) ? record.provenance.horizon : record.asOf;
    return Number.isFinite(reach) ? reach : Infinity;
}

/**
 * The last chat line anything behind a new group memory reaches: the lines it was written from
 * and every memory the model was shown, through what those were built from in turn. A member
 * who has heard every line up to it may read the memory, whoever heard it at the time.
 * @param {object} state Mewmory state
 * @param {number[]} lines Sequences of the lines it was written from
 * @param {{ id: string, version?: number }[]} [memories] Memory versions the model was shown
 * @returns {number|null} The line's sequence, or null when a memory it saw cannot say
 */
export function memoryHorizon(state, lines, memories = []) {
    const horizon = Math.max(-1, ...lines.filter(Number.isFinite), ...memories.map(({ id, version }) => memoryReach(state, id, version)));
    return Number.isFinite(horizon) ? horizon : null;
}

/** The first chat line a saved memory version was built from: 0 when nobody can say, Infinity for card text alone. */
function memoryStart(state, id, version) {
    const record = Number.isInteger(version) ? recordRevision(state, id, version) : state.records.find(entry => entry.id === id);
    if (!record) return 0;
    if (!marked(record)) return record.asOf < 0 ? Infinity : 0;
    return Number.isFinite(record.provenance.floor) ? record.provenance.floor : 0;
}

/**
 * The first chat line anything behind a new group memory reaches, the mirror of its horizon.
 * Once the chat has a memory starting point, a memory is read only when this is on or after it.
 * @param {object} state Mewmory state
 * @param {number[]} lines Sequences of the lines it was written from
 * @param {{ id: string, version?: number }[]} [memories] Memory versions the model was shown
 * @returns {number|null} The line's sequence, or null for the first line or when nobody can say
 */
export function memoryFloor(state, lines, memories = []) {
    const floor = Math.min(...lines.filter(Number.isFinite), ...memories.map(({ id, version }) => memoryStart(state, id, version)));
    return Number.isFinite(floor) && floor > 0 ? floor : null;
}

/**
 * The memory a group speaker may read. Lines they did not hear are left out. A memory written
 * from one group of listeners says so, and only those listeners read it, until a speaker caught
 * up later has heard every line up to its horizon. An older memory has no such mark and cites
 * only some of the messages it came from, so a speaker reads it only when they heard every line
 * up to it. Lines before the chat's memory starting point reach nobody, and neither does a
 * memory anything behind it came from them.
 * @param {object} state Mewmory state
 * @param {string[]|null} viewers Speakers the prompt is written for
 * @param {{ seesAll?: string[] }} [rules] The chat's scene rules
 * @param {{ fromStart?: boolean }} [options] `fromStart: false` reads as if the chat had no starting point
 * @returns {{ state: object, heldRefs: Set<string>, key: string }|null} Null when they may read everything
 */
export function viewerState(state, viewers, rules = {}, { fromStart = true } = {}) {
    if (!Array.isArray(viewers) || !viewers.length) return null;
    const start = fromStart && state.groupStart > 0 ? state.groupStart : 0;
    const hidden = [];
    let legacyAsOf = Infinity;
    for (const ref of state.timeline) {
        const audience = sourceAudience(state, ref);
        if (!(start && beforeStart(state, ref)) && viewers.every(viewer => canHear(audience, viewer, rules))) continue;
        hidden.push(ref.id);
        const sequence = sourceAt(state, ref)?.sequence;
        if (Number.isFinite(sequence)) legacyAsOf = Math.min(legacyAsOf, sequence - 1);
    }
    const readable = record => marked(record)
        ? (!start || (record.provenance.floor ?? 0) >= start)
            && (viewers.every(viewer => canHear(record.provenance.audience, viewer, rules))
                || Number.isFinite(record.provenance.horizon) && record.provenance.horizon <= legacyAsOf)
        : record.asOf <= legacyAsOf;
    let changed = hidden.length > 0;
    // Unreadable versions are blanked rather than dropped, so corrections still count.
    const audit = state.audit.map(entry => {
        if (!entry.before || readable(entry.before)) return entry;
        changed = true;
        return { ...entry, before: null };
    });
    const heldRefs = new Set();
    const records = state.records.flatMap(record => {
        if (readable(record)) return [record];
        changed = true;
        for (const ref of [...record.refs || [], ...record.evidenceRefs || [], ...record.inputRefs || []]) heldRefs.add(ref.id);
        // An earlier version they may read stands in, as when a memory is too new for a prompt.
        const earlier = audit.filter(entry => entry.recordId === record.id && entry.before)
            .map(entry => entry.before).sort((a, b) => b.version - a.version)[0];
        return earlier ? [earlier] : [];
    });
    if (!changed) return null;
    return {
        state: { ...state, excludedSources: [...new Set([...(state.excludedSources || []), ...hidden])], records, audit },
        heldRefs,
        key: hash([...new Set(viewers)].sort()),
    };
}

/**
 * The memory one extraction batch may build on: only what every member who heard the batch may
 * read, so a new memory never carries a line to someone who missed it. A batch from before the
 * chat's memory starting point sees the story as if there were none, since what it writes stays
 * behind that point anyway.
 * @param {object} state Mewmory state
 * @param {object|null} audience Who heard the batch
 * @param {number} [sequence] The batch's first line
 * @returns {object|null} Narrowed state, or null when nothing is held back
 */
export function batchState(state, audience, sequence = Infinity) {
    const members = groupMembers(state).map(member => member.avatar);
    if (!state.locator?.group || !members.length) return null;
    const listeners = members.filter(avatar => canHear(audience, avatar));
    if (!listeners.length) return { ...state, records: [], audit: [] };
    return viewerState(state, listeners, {}, { fromStart: !(sequence < state.groupStart) })?.state ?? null;
}

/**
 * The memory every group member may read, for things that reach all of them at once, such as a
 * lorebook or a memory shared with other chats. Outside a group chat this is the whole story.
 * @param {object} state Mewmory state
 * @returns {object} Narrowed state
 */
export function everyoneState(state) {
    const members = state.locator?.group ? groupMembers(state).map(member => member.avatar) : [];
    return members.length ? viewerState(state, members)?.state ?? state : state;
}

/**
 * Whether a saved line must stay in the chat because a member who heard it cannot read the
 * memory that would replace it.
 * @param {object} state Mewmory state
 * @param {{ seesAll?: string[] }} [rules] The chat's scene rules
 * @returns {(ref: object) => boolean} Check for one timeline line
 */
export function groupLineHeld(state, rules = {}) {
    const members = state.locator?.group ? groupMembers(state).map(member => member.avatar) : [];
    const views = members.map(avatar => [avatar, viewerState(state, [avatar], rules)]).filter(([, view]) => view?.heldRefs.size);
    if (!views.length) return () => false;
    return ref => !beforeStart(state, ref) && views.some(([avatar, view]) => view.heldRefs.has(ref.id) && canHear(sourceAudience(state, ref), avatar, rules));
}

/** Whether a group member heard a batch, by the entity a memory names them with. */
export function memberHeard(state, audience, entityId) {
    const member = groupMembers(state).find(entry => entry.entityId === entityId);
    return !member || canHear(audience, member.avatar);
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
