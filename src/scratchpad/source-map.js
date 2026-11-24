// A small source map v3 reader with no dependencies. It answers one question:
// which original file, line and column produced a given spot in a minified file.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map([...BASE64].map((char, index) => [char, index]));
const MAX_MAPPINGS_CHARS = 32 * 1024 * 1024;

/** Decodes one segment of base64 VLQ numbers, such as 'AAAA' or 'gBAAC'. */
export function decodeVlqSegment(segment) {
    const values = [];
    let value = 0;
    let shift = 0;
    for (const char of segment) {
        const digit = BASE64_VALUES.get(char);
        if (digit === undefined) return null;
        value += (digit & 31) << shift;
        if (digit & 32) {
            shift += 5;
            if (shift > 30) return null;
            continue;
        }
        values.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
    }
    return shift ? null : values;
}

/**
 * Reads the mappings of one generated line. Lines are decoded on demand, so a
 * large map only costs the line that is asked about plus the running offsets.
 */
function parseMap(map) {
    if (!map || typeof map !== 'object' || map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null;
    if (map.mappings.length > MAX_MAPPINGS_CHARS) return null;
    return map;
}

/**
 * Finds the original position for a generated position.
 * `line` is 1-based and `column` is 1-based, as browsers print them in stack traces.
 * Returns { source, line, column, name } with a 1-based line and column, or null.
 */
export function originalPositionFor(rawMap, { line, column }) {
    const map = parseMap(rawMap);
    if (!map || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return null;
    const targetLine = line - 1;
    const targetColumn = column - 1;
    let source = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let name = 0;
    let best = null;
    const lines = map.mappings.split(';');
    if (targetLine >= lines.length) return null;
    for (let index = 0; index <= targetLine; index++) {
        let generatedColumn = 0;
        if (!lines[index]) continue;
        for (const segment of lines[index].split(',')) {
            if (!segment) continue;
            const values = decodeVlqSegment(segment);
            if (!values || !values.length) return null;
            generatedColumn += values[0];
            if (values.length >= 4) {
                source += values[1];
                originalLine += values[2];
                originalColumn += values[3];
                if (values.length >= 5) name += values[4];
            }
            if (index !== targetLine || values.length < 4) continue;
            if (generatedColumn > targetColumn) {
                if (!best) best = { source, originalLine, originalColumn, name: values.length >= 5 ? name : -1 };
                break;
            }
            best = { source, originalLine, originalColumn, name: values.length >= 5 ? name : -1 };
        }
    }
    if (!best) return null;
    const file = map.sources[best.source];
    if (typeof file !== 'string' || !file) return null;
    const prefix = typeof map.sourceRoot === 'string' && map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
    const symbol = best.name >= 0 && Array.isArray(map.names) && typeof map.names[best.name] === 'string' ? map.names[best.name] : '';
    return { source: `${prefix}${file}`, line: best.originalLine + 1, column: best.originalColumn + 1, ...(symbol ? { name: symbol } : {}) };
}
