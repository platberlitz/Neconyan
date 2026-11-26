/* A disposable worker keeps pathological preview patterns off the UI thread. */
const MAX_PREVIEW_OUTPUT = 500000;
const TOO_LARGE = 'The replacement is too large to preview.';

function previewRegex({ pattern, replacement, sample }) {
    const literal = pattern.match(/^\/(.*)\/([dgimsuvy]*)$/s);
    const regex = literal ? new RegExp(literal[1], literal[2]) : new RegExp(pattern);
    const template = replacement.replace(/{{match}}/gi, '$0');
    const pieces = [];
    let templateCursor = 0;
    for (const token of template.matchAll(/\$(\d+)|\$<([^>]+)>/g)) {
        pieces.push({ text: template.slice(templateCursor, token.index), number: token[1], name: token[2] });
        templateCursor = token.index + token[0].length;
    }
    const tail = template.slice(templateCursor);
    let matches = 0;
    let produced = 0;
    let lastEnd = 0;
    const output = sample.replace(regex, (...args) => {
        matches++;
        const match = args[0];
        const groups = args.at(-1) && typeof args.at(-1) === 'object' ? args.at(-1) : null;
        /* Trailing callback arguments are the offset, the source and (optionally) named groups. */
        const captureCount = args.length - 3 - (groups ? 1 : 0);
        const offset = args[captureCount + 1];
        produced += Math.max(0, offset - lastEnd);
        lastEnd = offset + match.length;
        let replaced = '';
        const add = value => {
            if (!value) return;
            produced += value.length;
            if (produced > MAX_PREVIEW_OUTPUT) throw new Error(TOO_LARGE);
            replaced += value;
        };
        for (const { text, number, name } of pieces) {
            add(text);
            let value;
            if (number !== undefined) {
                const index = Number(number);
                value = index <= captureCount ? args[index] : undefined;
            } else {
                value = groups && Object.hasOwn(groups, name) ? groups[name] : undefined;
            }
            if (typeof value === 'string') add(value);
        }
        add(tail);
        return replaced;
    });
    if (output.length > MAX_PREVIEW_OUTPUT) throw new Error(TOO_LARGE);
    return { output, matches };
}

if (typeof self !== 'undefined') {
    self.onmessage = ({ data }) => {
        try {
            self.postMessage(previewRegex(data));
        } catch (error) { self.postMessage({ error: error.message }); }
    };
}

export { previewRegex as previewCreatorRegexInWorker };
