// Parallel Append Agents and Companions each send their own model request. Sending a large batch at
// once trips provider rate limits, so at most this many run together and the rest wait their turn.
export const PARALLEL_AGENT_REQUEST_LIMIT = 4;

/**
 * Runs `worker` over `items` with at most `limit` calls in flight, resolving to the results in input order.
 * Like Promise.all it rejects with the first failure; no new item starts after one has failed.
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R> | R} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
    const list = Array.from(items ?? []);
    const results = new Array(list.length);
    const lanes = Math.min(list.length, Math.max(1, Math.floor(Number(limit)) || 1));
    let next = 0;
    let failed = false;
    const runLane = async () => {
        while (!failed && next < list.length) {
            const index = next++;
            try {
                results[index] = await worker(list[index], index);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: lanes }, runLane));
    return results;
}
