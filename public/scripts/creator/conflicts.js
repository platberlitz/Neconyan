const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Arrays are indivisible: merging their indexes could silently reorder greetings or entries. */
export function compareCreatorChanges(base, local, remote, choices = {}) {
    const conflicts = [];
    function merge(before, ours, theirs, path) {
        if (same(ours, theirs) || same(before, theirs)) return structuredClone(ours);
        if (same(before, ours)) return structuredClone(theirs);
        if (object(before) && object(ours) && object(theirs)) {
            const result = {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(ours), ...Object.keys(theirs)])) {
                const value = merge(before[key], ours[key], theirs[key], [...path, key]);
                if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
            }
            return result;
        }
        const id = JSON.stringify(path);
        if (Object.hasOwn(choices, id) && ['draft', 'library'].includes(choices[id])) return structuredClone(choices[id] === 'draft' ? ours : theirs);
        conflicts.push({ id, path, before, draft: ours, library: theirs });
        return structuredClone(ours);
    }
    return { value: merge(base, local, remote, []), conflicts };
}
