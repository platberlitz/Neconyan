import os from 'node:os';
import v8 from 'node:v8';
import { isConstrainedMobileRuntime } from './runtime.js';
import { SERVER_MEMORY_SAMPLE_MESSAGE } from './server-plugin-update-ipc.js';

const reclaimers = new Set();
const MIB = 1024 * 1024;
const HIGH_HEAP_RATIO = 0.8;
const CONSTRAINED_HEAP_RATIO = 0.65;
const HIGH_RSS_RATIO = 0.85;
const CONSTRAINED_RSS_RATIO = 0.55;
const CONSTRAINED_RSS_CAP_BYTES = 768 * MIB;

/** Register module-owned, read-only caches only. Never register jobs, locks or pending writes. */
export function registerMemoryReclaimer(reclaim) {
    reclaimers.add(reclaim);
    return () => reclaimers.delete(reclaim);
}

export function isMemoryPressure({ available, total, heapUsed, heapLimit, rss, constrained = false }) {
    const lowAvailable = Number.isFinite(available) && available >= 0 && Number.isFinite(total) && total > 0
        && available < Math.min(256 * MIB, total * 0.1);
    const heapThreshold = constrained ? CONSTRAINED_HEAP_RATIO : HIGH_HEAP_RATIO;
    const highHeap = Number.isFinite(heapUsed) && heapUsed > 0 && Number.isFinite(heapLimit) && heapLimit > 0
        && heapUsed / heapLimit >= heapThreshold;
    const rssLimit = constrained
        ? (Number.isFinite(heapLimit) && heapLimit > 0
            ? Math.min(CONSTRAINED_RSS_CAP_BYTES, heapLimit * CONSTRAINED_RSS_RATIO)
            : CONSTRAINED_RSS_CAP_BYTES)
        : (Number.isFinite(heapLimit) && heapLimit > 0 ? heapLimit * HIGH_RSS_RATIO : Infinity);
    const highRss = Number.isFinite(rss) && rss > 0 && Number.isFinite(rssLimit) && rssLimit > 0
        && rss >= rssLimit;
    return lowAvailable || highHeap || highRss;
}

function readMemory() {
    const usage = process.memoryUsage();
    return {
        available: typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem(),
        total: os.totalmem(),
        heapUsed: usage.heapUsed,
        heapLimit: v8.getHeapStatistics().heap_size_limit,
        rss: usage.rss,
        constrained: isConstrainedMobileRuntime(),
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

/** One reading of this process and the device, as plain numbers in bytes. */
export function readMemorySample({ processObject = process } = {}) {
    const usage = processObject.memoryUsage();
    return {
        at: new Date().toISOString(),
        uptimeSeconds: processObject.uptime(),
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        heapLimit: v8.getHeapStatistics().heap_size_limit,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        deviceAvailable: typeof processObject.availableMemory === 'function' ? processObject.availableMemory() : os.freemem(),
        deviceTotal: os.totalmem(),
    };
}

/**
 * Sends each reading to the supervisor, which keeps the newest ones for the crash
 * report if this process dies without being able to describe itself. It does
 * nothing without a connected IPC channel and never throws or holds the process open.
 */
export function createMemorySampleReporter({ processObject = process, read = readMemorySample } = {}) {
    return () => {
        try {
            if (typeof processObject.send !== 'function' || processObject.connected === false) return;
            processObject.send({ type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: read({ processObject }) }, () => { /* A closed channel is the supervisor's concern. */ });
        } catch { /* Some runtimes cannot provide every counter, and the channel may have closed. */ }
    };
}

let timer;
export function startMemoryPressureMonitor() {
    if (timer) return;
    const check = createMemoryPressureCheck();
    const report = createMemorySampleReporter();
    const tick = () => { check(); report(); };
    timer = setInterval(tick, 10_000);
    timer.unref?.();
    tick();
}
