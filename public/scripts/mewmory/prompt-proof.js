/** Put a unique, inert boundary around the one memory block that can be replaced. */
export function wrapMewmoryContext(text, marker) {
    return marker.open + '\n' + (text || '') + '\n' + marker.close;
}

/** Remove only the exact known slot boundaries, preserving its content. */
export function cleanMewmoryCountView(prompt, marker) {
    if (!marker) return prompt;
    const clean = value => {
        if (typeof value !== 'string') return value;
        const start = value.indexOf(marker.open), close = value.indexOf(marker.close);
        if (start < 0 || close < start) return value;
        let inner = value.slice(start + marker.open.length, close);
        if (inner.startsWith('\r\n')) inner = inner.slice(2);
        else if (inner.startsWith('\n')) inner = inner.slice(1);
        if (inner.endsWith('\r\n')) inner = inner.slice(0, -2);
        else if (inner.endsWith('\n')) inner = inner.slice(0, -1);
        return value.slice(0, start) + inner + value.slice(close + marker.close.length);
    };
    if (typeof prompt === 'string') return clean(prompt);
    if (!Array.isArray(prompt)) return prompt;
    return prompt.map(message => {
        if (!message || !Object.hasOwn(message, 'content')) return message;
        const content = Array.isArray(message.content)
            ? message.content.map(part => part.type === 'text' ? { ...part, text: clean(part.text) } : part)
            : clean(message.content);
        return { ...message, content };
    });
}

/** Keep the working slot intact while charging only the clean text to the prompt budget. */
export async function createMewmoryBudgetMessage(create, content, identifier, marker) {
    const countContent = identifier === 'mewmory-context' ? cleanMewmoryCountView(content, marker) : content;
    return create('system', content, identifier, countContent);
}

/** Select a prepared assembly; only terminal payloads omit private proof markers. */
export function finaliseMewmoryContext(prompt, context, { phase = 'terminal' } = {}) {
    const suppression = context?.suppression;
    if (!suppression) return { prompt, memoryText: context?.memoryText || '', choice: 'primary', skipped: 0 };
    const { marker, proof, fallbackMemoryText } = suppression;
    const parts = typeof prompt === 'string' ? [prompt] : prompt.flatMap(message => typeof message.content === 'string'
        ? [message.content] : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text) : []);
    const matching = parts.filter(part => part.includes(marker.open) || part.includes(marker.close));
    if (matching.length !== 1 || matching[0].indexOf(marker.open) !== matching[0].lastIndexOf(marker.open)
        || matching[0].indexOf(marker.close) !== matching[0].lastIndexOf(marker.close)
        || matching[0].indexOf(marker.open) < 0 || matching[0].indexOf(marker.close) < matching[0].indexOf(marker.open)) {
        throw new Error('Your prompt settings removed or changed the memories Mewmory added. Check that your prompt template keeps the Mewmory block.');
    }
    const slot = matching[0];
    const start = slot.indexOf(marker.open), end = slot.indexOf(marker.close) + marker.close.length;
    const outside = parts.map(part => (part === slot ? part.slice(0, start) + part.slice(end) : part)
        .replace(context.npcText || '\u0000', '')).join('\n').replace(/\r\n/g, '\n');
    const present = context.presentationChoice !== 'fallback' && !context.mewmoryMacrosUsed && proof.every(item => outside.includes(item.passageText.replace(/\r\n/g, '\n')));
    const marked = present ? slot.slice(start, end) : fallbackMemoryText;
    const replacement = phase === 'working' ? marked : cleanMewmoryCountView(marked, marker);
    const nextSlot = slot.slice(0, start) + replacement + slot.slice(end);
    let next = prompt;
    if (typeof prompt === 'string') next = nextSlot;
    else next = prompt.map(message => {
        if (message.content === slot) return { ...message, content: nextSlot };
        if (!Array.isArray(message.content)) return message;
        return { ...message, content: message.content.map(part => part.type === 'text' && part.text === slot ? { ...part, text: nextSlot } : part) };
    });
    return { prompt: next, memoryText: replacement, choice: present ? 'primary' : 'fallback',
        skipped: present ? suppression.proposedPassagesSkipped : 0 };
}
