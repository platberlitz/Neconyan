function shortKey(value) {
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < value.length; index++) {
        first = Math.imul(first ^ value.charCodeAt(index), 16777619);
        second = Math.imul(second, 33) ^ value.charCodeAt(index);
    }
    return `h_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Use the store's property-block boundaries without parsing or rewriting its contents. */
export function splitNoteFrontmatter(text) {
    const source = String(text ?? '');
    const bom = source.startsWith('\uFEFF') ? 1 : 0;
    const ordinary = { frontmatter: '', body: source.slice(bom), bodyStart: bom, hasFrontmatter: false };
    const open = /^---[ \t]*\r?\n/.exec(source.slice(bom));
    if (!open) return ordinary;
    const start = bom + open[0].length;
    const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
    close.lastIndex = start;
    const end = close.exec(source);
    if (!end) return ordinary;
    const bodyStart = end.index + end[0].length;
    return { frontmatter: source.slice(start, end.index).replace(/\r?\n$/, ''), body: source.slice(bodyStart), bodyStart, hasFrontmatter: true };
}

/** Heading locations are presentation data. The Markdown string is never changed. */
export function headingSections(source) {
    const text = String(source ?? '');
    const lines = [];
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
        if (!match[0]) break;
        const content = match[0].replace(/(?:\r\n|\n|\r)$/, '');
        const bom = match.index === 0 && content.startsWith('\uFEFF') ? 1 : 0;
        lines.push({ text: content.slice(bom), start: match.index, contentEnd: match.index + content.length, end: match.index + match[0].length });
    }
    const front = splitNoteFrontmatter(text);
    const bodyStart = front.hasFrontmatter ? front.bodyStart : 0;
    const headings = [];
    const ancestors = [];
    const occurrences = new Map();
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.start < bodyStart) continue;
        const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
        if (fence) {
            if (fenced && fenced[1][0] === fence.char && fenced[1].length >= fence.length && !fenced[2].trim()) fence = null;
            continue;
        }
        if (fenced && !(fenced[1][0] === '`' && fenced[2].includes('`'))) {
            fence = { char: fenced[1][0], length: fenced[1].length };
            continue;
        }
        const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line.text);
        const underline = !atx && line.text.trim() && !/^ {4}|^\t|^ {0,3}[>\-+*]\s/.test(line.text)
            ? /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index + 1]?.text ?? '') : null;
        if (!atx && !underline) continue;
        const level = atx ? atx[1].length : underline[1][0] === '=' ? 1 : 2;
        const title = (atx ? (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '') : line.text.trim()).replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '').trim();
        const lastLine = underline ? lines[++index] : line;
        while (ancestors.length && ancestors.at(-1).level >= level) ancestors.pop();
        const identity = JSON.stringify([ancestors.map(item => item.key), level, title]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const key = shortKey(JSON.stringify([ancestors.map(item => item.key), level, title, occurrence]));
        const heading = { level, text: title, offset: line.start, from: lastLine.contentEnd, to: text.length, end: text.length, key };
        headings.push(heading);
        ancestors.push(heading);
    }
    const open = [];
    for (const heading of headings) {
        while (open.length && open.at(-1).level >= heading.level) {
            const previous = open.pop();
            previous.end = heading.offset;
            const newline = text.slice(Math.max(0, heading.offset - 2), heading.offset).endsWith('\r\n') ? 2 : 1;
            previous.to = Math.max(previous.from, heading.offset - newline);
        }
        open.push(heading);
    }
    return headings;
}

export function topLevelSections(headings) {
    const result = [];
    let end = -1;
    for (const heading of headings) {
        if (heading.offset < end || heading.to <= heading.from) continue;
        result.push(heading);
        end = heading.end;
    }
    return result;
}
