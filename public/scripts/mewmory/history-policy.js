/** Select complete preserved groups while keeping a recent dialogue window. */
export function messageHistoryPlan(indices, recent, batch, preserved) {
    const target = batch * Math.floor(Math.max(0, indices.length - recent) / batch);
    const excluded = [];
    for (let start = 0; start < target; start += batch) {
        const group = indices.slice(start, start + batch);
        if (group.length !== batch || !group.every(preserved)) break;
        excluded.push(...group);
    }
    return { excluded, target, waitingForPreservation: excluded.length < target };
}
