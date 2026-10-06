/* Plain Markdown edits shared by the editor and formatting buttons. */
const ITEM = /^([ \t]*)(?:(\d{1,9})([.)])|([-+*]))[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;

export function listItem(line) {
    const match = ITEM.exec(line);
    if (!match) return null;
    return { indent: match[1], number: match[2] === undefined ? null : Number(match[2]),
        marker: match[3] || match[4], task: match[5] !== undefined, body: match[6],
        prefixLength: line.length - match[6].length };
}

export function selectedLines(text, start, end = start) {
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start, Math.min(end, text.length));
    const from = start ? text.lastIndexOf('\n', start - 1) + 1 : 0;
    const newline = text.indexOf('\n', Math.max(from, end - (end > start ? 1 : 0)));
    return { from, to: newline < 0 ? text.length : newline };
}

/** A marker inside a fenced example or the properties block is not a list. */
export function literalAt(text, offset) {
    let frontmatter = /^\uFEFF?---[ \t]*\n/.test(text);
    let fence = null;
    let from = 0;
    for (const line of text.slice(0, offset).split('\n')) {
        if (frontmatter) {
            if (from && /^(?:---|\.\.\.)[ \t]*$/.test(line)) frontmatter = false;
        } else {
            const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            if (fence) {
                if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
            } else if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
                fence = { char: match[1][0], length: match[1].length };
            }
        }
        from += line.length + 1;
    }
    return frontmatter || Boolean(fence);
}

export function continueList(text, start, end = start) {
    const { from, to } = selectedLines(text, start, start);
    if (end > to || literalAt(text, from)) return null;
    const item = listItem(text.slice(from, to));
    if (!item || start < from + item.prefixLength) return null;
    if (!item.body.trim()) return { from, to, insert: '', selection: { anchor: from } };
    const marker = item.number === null ? item.marker : `${item.number + 1}${item.marker}`;
    const insert = `\n${item.indent}${marker} ${item.task ? '[ ] ' : ''}`;
    return { from: start, to: end, insert, selection: { anchor: start + insert.length } };
}

export function formatList(text, start, end, kind) {
    if (!['bullet', 'ordered', 'task'].includes(kind)) throw new Error('Unknown list type.');
    const { from, to } = selectedLines(text, start, end);
    const lines = text.slice(from, to).split('\n');
    if (literalAt(text, from) || lines.some(line => /^ {0,3}(?:`{3,}|~{3,})/.test(line))) return null;
    const nonempty = lines.filter(line => line.trim());
    const matches = item => item && (kind === 'task' ? item.task : kind === 'ordered' ? item.number !== null && !item.task : item.number === null && !item.task);
    const remove = nonempty.length > 0 && nonempty.every(line => matches(listItem(line)));
    const numbers = new Map();
    const insert = lines.map(line => {
        if (!line.trim() && lines.length > 1) return line;
        const item = listItem(line);
        const indent = item?.indent ?? /^[ \t]*/.exec(line)[0];
        const body = item?.body ?? line.slice(indent.length);
        if (remove) return indent + body;
        let marker = kind === 'task' ? '- [ ] ' : '- ';
        if (kind === 'ordered') {
            const depth = indent.replace(/\t/g, '    ').length;
            for (const key of numbers.keys()) if (key > depth) numbers.delete(key);
            const number = (numbers.get(depth) ?? 0) + 1;
            numbers.set(depth, number);
            marker = `${number}. `;
        }
        return indent + marker + body;
    }).join('\n');
    return { from, to, insert, selection: end > start ? { anchor: from, head: from + insert.length } : { anchor: from + insert.length } };
}

export function indentLines(text, start, end, outdent = false, { listsOnly = false } = {}) {
    const { from, to } = selectedLines(text, start, end);
    const lines = text.slice(from, to).split('\n');
    if (listsOnly && (literalAt(text, from) || !lines.some(line => listItem(line)))) return null;
    const edits = lines.map(line => ({ line, remove: outdent ? (/^(?:\t| {1,4})/.exec(line)?.[0].length ?? 0) : 0 }));
    const insert = edits.map(({ line, remove }) => outdent ? line.slice(remove) : `    ${line}`).join('\n');
    if (insert === text.slice(from, to)) return null;
    function position(offset) {
        let old = from;
        let next = from;
        for (const { line, remove } of edits) {
            if (offset <= old + line.length) return next + (outdent ? Math.max(0, offset - old - remove) : offset - old + 4);
            old += line.length + 1;
            next += line.length + 1 + (outdent ? -remove : 4);
        }
        return from + insert.length;
    }
    return { from, to, insert, selection: { anchor: position(start), head: position(end) } };
}
