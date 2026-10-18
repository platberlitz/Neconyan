/**
 * Coalesces UI refresh kinds into one animation frame. Data writes can call
 * this from inside prompt assembly without rebuilding DOM synchronously.
 */
export function createRefreshQueue(
    run,
    {
        requestFrame = callback => requestAnimationFrame(callback),
        cancelFrame = handle => cancelAnimationFrame(handle),
    } = {},
) {
    const pending = new Set();
    let frame = null;

    return {
        push(kind) {
            pending.add(kind);
            if (frame !== null) {
                return;
            }
            frame = requestFrame(() => {
                frame = null;
                const kinds = [...pending];
                pending.clear();
                for (const entry of kinds) {
                    run(entry);
                }
            });
        },
        clear() {
            pending.clear();
            if (frame !== null) {
                cancelFrame(frame);
                frame = null;
            }
        },
    };
}
