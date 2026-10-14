/** Storage identity stays separate from the optional context of a General discussion. */
export function sameSourceBucket(source, other) {
    return Boolean(source && other && source.kind === other.kind && source.key === other.key);
}

export function sameSourceContext(source, other) {
    if (!source || !other || source.kind !== other.kind) return false;
    if (source.kind === 'general') {
        return sameSourceBucket(source, other) && ['avatar', 'contextMode', 'personaId'].every(field =>
            (source[field] || '') === (other[field] || ''));
    }
    return source.key === other.key || Boolean(source.legacyKey && source.legacyKey === other.key)
        || Boolean(other.legacyKey && source.key === other.legacyKey);
}
