/**
 * Exact, bounded token counts for one generation's repeated budget checks.
 * The caller binds one tokenizer to this cache. Whole-prompt tokenizers must
 * still count their complete prompt, as token boundaries can cross messages.
 */
export function createTextTokenCache({ maxCharacters = 1024 * 1024, maxEntries = 2048 } = {}) {
    const counts = new Map();
    let characters = 0;
    return (text, tokenizer) => {
        if (counts.has(text)) return counts.get(text);
        const count = tokenizer.encode(text).length;
        if (typeof text !== 'string' || text.length > maxCharacters || maxEntries <= 0) return count;
        while (counts.size && (characters + text.length > maxCharacters || counts.size >= maxEntries)) {
            const oldest = counts.keys().next().value;
            characters -= oldest.length;
            counts.delete(oldest);
        }
        counts.set(text, count);
        characters += text.length;
        return count;
    };
}
