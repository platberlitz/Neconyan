/** Plain text carried by a string or a multimodal message content array. */
export function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            return typeof part?.text === 'string'
                && (!part.type || ['text', 'input_text', 'output_text'].includes(part.type))
                ? part.text
                : '';
        })
        .filter(Boolean)
        .join('\n');
}

export function messagesToText(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(message => contentToText(message?.content))
        .filter(Boolean)
        .join('\n');
}

/** Applies a text transform without modifying the caller's content value. */
export function mapContentText(content, transform) {
    if (typeof content === 'string') {
        return transform(content);
    }
    if (!Array.isArray(content)) {
        return content;
    }
    return content.map((part) => {
        if (typeof part === 'string') {
            return transform(part);
        }
        if (typeof part?.text !== 'string'
            || (part.type && !['text', 'input_text', 'output_text'].includes(part.type))) {
            return part;
        }
        return { ...part, text: transform(part.text) };
    });
}

function stableValue(value, ancestors) {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? String(value) : value;
    }
    if (ancestors.has(value)) {
        throw new TypeError('Cannot serialize a circular value.');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(item => stableValue(item, ancestors));
        }
        if (typeof value.toJSON === 'function') {
            return stableValue(value.toJSON(), ancestors);
        }
        const output = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
                output[key] = stableValue(item, ancestors);
            }
        }
        return output;
    } finally {
        ancestors.delete(value);
    }
}

/** JSON with stable object-key order; array order and duplicates are untouched. */
export function stableStringify(value) {
    return JSON.stringify(stableValue(value, new Set()));
}

/** The exact ordered outbound prompt used as comparison identity. */
export function canonicalOutbound(capture, { mapText = null } = {}) {
    if (Array.isArray(capture?.messages) && capture.messages.length) {
        const messages = mapText
            ? capture.messages.map(message => ({
                ...message,
                content: mapContentText(message?.content, mapText),
            }))
            : capture.messages;
        return `messages:${stableStringify(messages)}`;
    }
    if (typeof capture?.combinedPrompt === 'string') {
        const prompt = mapText ? mapText(capture.combinedPrompt) : capture.combinedPrompt;
        return `prompt:${prompt}`;
    }
    return null;
}

export function hasCanonicalCapture(run) {
    try {
        const usable = (Array.isArray(run?.capture?.messages)
                && run.capture.messages.length > 0
                && run.capture.messages.every(message => message && typeof message === 'object'))
            || (typeof run?.capture?.combinedPrompt === 'string'
                && run.capture.combinedPrompt.length > 0);
        return usable && canonicalOutbound(run.capture) !== null;
    } catch {
        return false;
    }
}
