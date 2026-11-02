/* A disposable worker keeps pathological preview patterns off the UI thread. */
self.onmessage = ({ data }) => {
    try {
        const { pattern, replacement, sample } = data;
        const literal = pattern.match(/^\/(.*)\/([dgimsuvy]*)$/s);
        const regex = literal ? new RegExp(literal[1], literal[2]) : new RegExp(pattern);
        let matches = 0;
        const output = sample.replace(regex, (...args) => {
            matches++;
            return replacement.replace(/{{match}}/gi, '$0').replace(/\$(\d+)|\$<([^>]+)>/g, (_, number, name) => {
                const groups = args.at(-1);
                const value = number ? args[Number(number)] : typeof groups === 'object' ? groups[name] : '';
                return typeof value === 'string' ? value : '';
            });
        });
        if (output.length > 500000) throw new Error('The replacement is too large to preview.');
        self.postMessage({ output, matches });
    } catch (error) { self.postMessage({ error: error.message }); }
};
