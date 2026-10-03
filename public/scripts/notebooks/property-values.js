function boundedValue(value) {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) {
        throw new Error('Keep the saved value within 4096 bytes. Edit larger values in Write instead.');
    }
    return value;
}

/** Property types are explicit. Never turn a numeric-looking string into a number. */
export function parsePropertyValue(kind, text) {
    if (kind === 'remove' || kind === 'null') return null;
    if (new TextEncoder().encode(String(text)).byteLength > 65536) throw new Error('Keep the saved value within 4096 bytes. Edit larger values in Write instead.');
    if (kind === 'text') return boundedValue(String(text));
    if (kind === 'number') {
        const source = String(text).trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source) || !Number.isFinite(Number(source))) {
            throw new Error('Enter a finite number, such as 2 or 2.5.');
        }
        return Number(source);
    }
    if (kind === 'boolean') {
        if (String(text).trim() === 'true') return true;
        if (String(text).trim() === 'false') return false;
        throw new Error('Enter true or false.');
    }
    if (kind === 'list') {
        let value;
        try { value = JSON.parse(String(text)); } catch { throw new Error('Enter a list such as ["one", 2, true].'); }
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) {
            throw new Error('Use a list of text, finite numbers or true/false values, without nested values.');
        }
        return boundedValue(value);
    }
    throw new Error('Choose a property type.');
}

export function propertyInput(cell) {
    if (!cell || cell.kind === 'missing' || cell.kind === 'null') return '';
    return cell.kind === 'text' ? String(cell.value ?? '') : JSON.stringify(cell.value, null, cell.kind === 'list' ? 2 : 0);
}
