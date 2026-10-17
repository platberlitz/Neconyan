/**
 * Roleplay live-preview wire frames, shared by the server endpoint and the
 * browser observer. Pure protocol code: no imports, no DOM, no I/O.
 *
 * A frame on the wire is one of:
 * - `{ preview }` - a complete snapshot, sent first on every connection and
 *   whenever a delta cannot describe the change (a new candidate, or text or
 *   reasoning rewritten rather than appended);
 * - `{ delta }` - `text`/`reasoning` hold only the appended suffix, `set` holds
 *   changed metadata fields, and `unset` names fields that disappeared.
 *   Unchanged fields are omitted. A delta applies to the snapshot the reader
 *   last reconstructed; without that base it cannot be used and the reader must
 *   reconnect for a fresh full snapshot.
 *
 * Both sides treat `undefined` as absent, matching what JSON puts on the wire,
 * so the server can diff against the object it wrote without normalising it.
 *
 * Snapshots must treat nested objects as immutable: a field whose reference is
 * unchanged is skipped without re-serialising it, so mutating a nested object
 * in place after publishing it would go unseen. Every current publisher builds
 * a fresh merged snapshot per publish and never edits one it handed over.
 */

const sameMetadata = (before, after) => {
    if (Object.is(before, after)) return true;
    if (typeof before !== 'object' || typeof after !== 'object' || before === null || after === null) return false;
    if (Array.isArray(before) !== Array.isArray(after)) return false;
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (beforeKeys.length !== afterKeys.length) return false;
    return beforeKeys.every(key => Object.hasOwn(after, key) && sameMetadata(before[key], after[key]));
};

/**
 * Builds the smallest frame that carries `value` to a reader whose last
 * complete snapshot was `sent`. A missing base, a candidate change or a
 * non-append rewrite produces a full `{ preview: value }` frame.
 * @param {object|null} sent Snapshot last written to this connection
 * @param {object|null} value Current complete preview snapshot
 * @returns {{preview?: object|null, delta?: object}}
 */
export function buildRoleplayPreviewFrame(sent, value) {
    if (!sent || typeof sent !== 'object' || !value || typeof value !== 'object') return { preview: value ?? null };
    // Another candidate is another reply; its text is never an append of this one.
    if (sent.childId !== value.childId) return { preview: value };
    const delta = {};
    for (const field of ['text', 'reasoning']) {
        const before = typeof sent[field] === 'string' ? sent[field] : '';
        const after = typeof value[field] === 'string' ? value[field] : '';
        if (before === after) continue;
        // A rewrite (an Agent edit, a swipe) invalidates the reader's base.
        if (!after.startsWith(before)) return { preview: value };
        delta[field] = after.slice(before.length);
    }
    const set = {};
    const unset = [];
    const keys = new Set([...Object.keys(sent), ...Object.keys(value)]);
    keys.delete('text');
    keys.delete('reasoning');
    for (const key of keys) {
        const before = sent[key];
        const after = value[key];
        if (before === after) continue;
        const hadBefore = before !== undefined;
        const hasAfter = after !== undefined;
        if (hadBefore && hasAfter && sameMetadata(before, after)) continue;
        if (hasAfter) set[key] = after;
        else if (hadBefore) unset.push(key);
    }
    if (Object.keys(set).length) delta.set = set;
    if (unset.length) delta.unset = unset;
    return { delta };
}

/**
 * Reconstructs the complete current snapshot from the reader's last snapshot
 * and one received frame. Full frames replace the base; deltas extend it.
 * @param {object|null} latest Snapshot the reader last reconstructed
 * @param {object|null} frame Received frame (`{ preview }` or `{ delta }`)
 * @returns {object|null} The current snapshot, or null when a delta arrived
 *   without a base (the caller must reconnect) or the frame carried none.
 */
export function applyRoleplayPreviewFrame(latest, frame) {
    if (!frame || typeof frame !== 'object') return latest ?? null;
    if (!frame.delta) return frame.preview ?? null;
    if (!latest || typeof latest !== 'object') return null;
    const next = { ...latest };
    if (typeof frame.delta.text === 'string') next.text = (typeof next.text === 'string' ? next.text : '') + frame.delta.text;
    if (typeof frame.delta.reasoning === 'string') next.reasoning = (typeof next.reasoning === 'string' ? next.reasoning : '') + frame.delta.reasoning;
    if (frame.delta.set && typeof frame.delta.set === 'object') Object.assign(next, frame.delta.set);
    if (Array.isArray(frame.delta.unset)) for (const key of frame.delta.unset) delete next[key];
    return next;
}
