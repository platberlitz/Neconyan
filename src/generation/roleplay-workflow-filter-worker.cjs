const { parentPort, workerData } = require('node:worker_threads');

function countMatches(terms, text, threshold) {
    const regex = new RegExp(`\\b(${terms.join('|')})\\b`, 'gi');
    let found = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (++found >= threshold) return true;
        if (match[0].length === 0) regex.lastIndex++;
    }
    return false;
}

if (workerData.mode === 'probe') {
    const state = new Int32Array(workerData.shared);
    try {
        const regex = new RegExp(`\\b(${workerData.terms.join('|')})\\b`, 'gi');
        if (regex.test('z'.repeat(90) + '!')) throw new Error('unsafe');
        for (const char of ['a', 'b', 'x', 'z', '0']) {
            countMatches(workerData.terms, `${char.repeat(90)}!`, workerData.threshold);
            countMatches(workerData.terms, `${char.repeat(90)}${char === 'a' ? 'b' : 'a'}`, workerData.threshold);
        }
        Atomics.store(state, 1, 1);
    } catch {
        Atomics.store(state, 1, -1);
    } finally {
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
    }
} else {
    try {
        parentPort.postMessage({ filtered: countMatches(workerData.terms, workerData.text, workerData.threshold) });
    } catch {
        parentPort.postMessage({ error: true });
    }
}
