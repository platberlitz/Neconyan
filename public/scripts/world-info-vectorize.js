/**
 * Plan entry-state changes across a whole lorebook without changing its data.
 * Disabled entries overlap the state counts and keep their disabled flag.
 * @param {object} data Lorebook data.
 * @param {object} [options] Conversion options.
 * @param {boolean} [options.includeConstants=false] Convert always-inserted entries too.
 * @returns {object} State counts and the storage keys and UIDs to change.
 */
export function planWorldInfoVectorization(data, { includeConstants = false } = {}) {
    const plan = { keywordCount: 0, constantCount: 0, vectorizedCount: 0, disabledCount: 0, changes: [] };
    for (const [key, entry] of Object.entries(data?.entries ?? {})) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (entry.disable) plan.disabledCount++;
        if (entry.constant === true) {
            plan.constantCount++;
            if (!includeConstants) continue;
        } else if (entry.vectorized === true) {
            plan.vectorizedCount++;
            continue;
        } else {
            plan.keywordCount++;
        }
        plan.changes.push({ key, uid: entry.uid ?? key });
    }
    return plan;
}
