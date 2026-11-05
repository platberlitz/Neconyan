import os from 'node:os';
import v8 from 'node:v8';

const reclaimers = new Set();
const MIB = 1024 * 1024;

/** Register module-owned, read-only caches only. Never register jobs, locks or pending writes. */
export function registerMemoryReclaimer(reclaim) {
    reclaimers.add(reclaim);
    return () => reclaimers.delete(reclaim);
}

export function isMemoryPressure({ available, total, heapUsed, heapLimit }) {
    const lowAvailable = Number.isFinite(available) && available >= 0 && Number.isFinite(total) && total > 0
        && available < Math.min(256 * MIB, total * 0.1);
    const highHeap = Number.isFinite(heapUsed) && heapUsed > 0 && Number.isFinite(heapLimit) && heapLimit > 0
        && heapUsed / heapLimit >= 0.8;
    return lowAvailable || highHeap;
}

function readMemory() {
    return {
        available: typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem(),
        total: os.totalmem(),
        heapUsed: process.memoryUsage().heapUsed,
        heapLimit: v8.getHeapStatistics().heap_size_limit,
    };
}

/** Shared by desktop, Termux and both native local servers. No forced GC or heap-limit changes. */
export function createMemoryPressureCheck({ sample = readMemory, now = Date.now, clients = reclaimers, cooldownMs = 30_000 } = {}) {
    let lastRelease = -Infinity;
    return () => {
        const time = now();
        if (time - lastRelease < cooldownMs) return false;
        try {
            if (!isMemoryPressure(sample())) return false;
        } catch { return false; } // Some runtimes cannot provide every memory counter.
        lastRelease = time;
        for (const reclaim of clients) {
            try { reclaim(); } catch (error) { console.warn('Memory cache cleanup failed:', error); }
        }
        return true;
    };
}

let timer;
export function startMemoryPressureMonitor() {
    if (timer) return;
    const check = createMemoryPressureCheck();
    timer = setInterval(check, 10_000);
    timer.unref?.();
    check();
}
