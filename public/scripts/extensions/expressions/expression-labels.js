/** Shared naming rules for the editor, uploads and saved sprite jobs. */
export function isExpressionLabel(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value)
        && !['constructor', 'prototype', '__proto__'].includes(value);
}

export function isExpressionSpriteName(label, name, labels) {
    return isExpressionLabel(label) && typeof name === 'string' && !/[\\/\0]/.test(name)
        && (name === label || name.startsWith(`${label}-`) || name.startsWith(`${label}.`))
        && (!labels || expressionLabelFromFilename(`${name}.png`, [...labels, label]) === label);
}

/** Known hyphenated labels win over the legacy dash/dot variant convention. */
export function expressionLabelFromFilename(filename, labels = []) {
    const stem = filename.replace(/\.[^/.]+$/, '').toLowerCase();
    return (Array.isArray(labels) ? labels : []).filter(isExpressionLabel).sort((a, b) => b.length - a.length)
        .find(label => isExpressionSpriteName(label, stem)) ?? stem.split(/[-.]/)[0];
}

export function parseExpressionLabels(text, existing = []) {
    const labels = [...new Set(String(text).split(/[,\n]+/).map(value => value.trim().toLowerCase()).filter(Boolean))];
    return { added: labels.filter(label => isExpressionLabel(label) && !existing.includes(label)),
        invalid: labels.filter(label => !isExpressionLabel(label)) };
}

/** Reserve both existing files and empty custom-expression slots before choosing a variant. */
export function nextExpressionSpriteName(label, filenames, labels = []) {
    if (!isExpressionLabel(label)) throw new Error('Invalid expression label.');
    const occupied = new Set(filenames.map(name => name.replace(/\.[^/.]+$/, '').toLowerCase()));
    const knownLabels = [...labels, label];
    for (let index = 0; ; index++) {
        const name = index ? `${label}-${index}` : label;
        if (!occupied.has(name) && expressionLabelFromFilename(`${name}.png`, knownLabels) === label) return name;
    }
}
