/*
 * Small line diff shared by the browser review dialog and the server. Pure
 * module: no DOM, no Node APIs. Trims the common prefix and suffix first, then
 * runs a bounded Myers search over the changed middle. When the middle is too
 * large for the bound it reports one replaced block instead of a wrong diff.
 */

const MAX_EDIT_DISTANCE = 4000;

export function splitLines(text) {
    const value = String(text ?? '');
    if (!value) return [];
    const lines = value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function myers(a, b) {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, MAX_EDIT_DISTANCE);
    const offset = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
            else x = v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
        }
    }
    return null;
}

function backtrack(trace, a, b, offset, depth) {
    const ops = [];
    let x = a.length;
    let y = b.length;
    for (let d = depth; d > 0; d--) {
        const v = trace[d];
        const k = x - y;
        const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1;
        const prevX = v[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { ops.push({ type: 'same', text: a[x - 1] }); x--; y--; }
        if (x === prevX) { ops.push({ type: 'add', text: b[y - 1] }); y--; } else { ops.push({ type: 'remove', text: a[x - 1] }); x--; }
    }
    while (x > 0 && y > 0) { ops.push({ type: 'same', text: a[x - 1] }); x--; y--; }
    return ops.reverse();
}

/** Returns [{type:'same'|'add'|'remove', text}] for every line. */
export function diffLines(beforeText, afterText) {
    const a = splitLines(beforeText);
    const b = splitLines(afterText);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const middleA = a.slice(start, endA);
    const middleB = b.slice(start, endB);
    let middle = myers(middleA, middleB);
    let approximate = false;
    if (!middle) {
        approximate = true;
        middle = [...middleA.map(text => ({ type: 'remove', text })), ...middleB.map(text => ({ type: 'add', text }))];
    }
    const ops = [
        ...a.slice(0, start).map(text => ({ type: 'same', text })),
        ...middle,
        ...a.slice(endA).map(text => ({ type: 'same', text })),
    ];
    Object.defineProperty(ops, 'approximate', { value: approximate });
    return ops;
}

/**
 * Groups a diff into hunks with `context` unchanged lines around each change.
 * Line numbers are 1-based. `full` returns one hunk with every line.
 */
export function diffHunks(beforeText, afterText, { context = 3, full = false } = {}) {
    const ops = diffLines(beforeText, afterText);
    let oldLine = 1;
    let newLine = 1;
    const numbered = ops.map(op => {
        const entry = { ...op, oldLine: op.type === 'add' ? null : oldLine, newLine: op.type === 'remove' ? null : newLine };
        if (op.type !== 'add') oldLine++;
        if (op.type !== 'remove') newLine++;
        return entry;
    });
    const added = numbered.filter(op => op.type === 'add').length;
    const removed = numbered.filter(op => op.type === 'remove').length;
    if (full) return { hunks: numbered.length ? [{ lines: numbered }] : [], added, removed, approximate: ops.approximate };
    const keep = new Array(numbered.length).fill(false);
    numbered.forEach((op, index) => {
        if (op.type === 'same') return;
        for (let i = Math.max(0, index - context); i <= Math.min(numbered.length - 1, index + context); i++) keep[i] = true;
    });
    const hunks = [];
    let current = null;
    numbered.forEach((op, index) => {
        if (!keep[index]) { current = null; return; }
        if (!current) { current = { lines: [] }; hunks.push(current); }
        current.lines.push(op);
    });
    return { hunks, added, removed, approximate: ops.approximate };
}

/** Plain unified-style text, used in assistant results and tests. */
export function formatDiff(beforeText, afterText, options = {}) {
    const { hunks } = diffHunks(beforeText, afterText, options);
    return hunks.map(hunk => hunk.lines.map(line => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} ${line.text}`).join('\n')).join('\n...\n');
}
