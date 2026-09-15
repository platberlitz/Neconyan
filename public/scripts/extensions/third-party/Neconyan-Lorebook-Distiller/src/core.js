// Pure logic: no host, no network, no DOM.

export const MAX_KEYS = 6;
export const MAX_CONTENT_CHARS = 1200;

/** "Alice and Bob", "Sword & Sorcery", "he/him" — likely two concepts in one title. */
const CONJUNCTION = /\band\b|&|\w\s*\/\s*\w/i;

/** Turns chat messages into "Name: text" transcript lines. */
export function messageLines(messages, { userName = 'User', characterName = 'Character' } = {}) {
    return (messages ?? [])
        .filter(message => message && !message.is_system && typeof message.mes === 'string' && message.mes)
        .map(message => `${message.name || (message.is_user ? userName : characterName)}: ${message.mes}`);
}

/**
 * Groups transcript lines into chunks whose complete wrapped text fits a
 * token budget, splitting only at message boundaries.
 */
export async function chunkLines(lines, tokenOf, budget, wrap = text => text) {
    const chunks = [];
    let current = [];
    for (const line of lines) {
        const candidate = [...current, line].join('\n');
        const tokens = Math.max(1, Number(await tokenOf(wrap(candidate))) || 0);
        if (tokens <= budget) {
            current.push(line);
            continue;
        }
        if (!current.length) {
            throw new Error('One chat message is too large for the selected connection context.');
        }
        chunks.push(current.join('\n'));
        current = [line];
        const singleTokens = Math.max(1, Number(await tokenOf(wrap(line))) || 0);
        if (singleTokens > budget) {
            throw new Error('One chat message is too large for the selected connection context.');
        }
    }
    if (current.length) {
        chunks.push(current.join('\n'));
    }
    return chunks;
}

export function buildDistillPrompt(chunk) {
    return `You are extracting lorebook entries from a roleplay chat transcript.

Rules:
- Each entry covers exactly ONE character, place, object, or concept. Never combine two subjects in one entry: "X and Y" is two entries.
- Keep only durable facts worth remembering in future scenes: identities, traits, relationships, places, established events. Skip greetings, moment-to-moment actions, and anything true only right now.
- "content": 2 to 4 plain declarative sentences, third person, no markdown.
- "keys": 2 to ${MAX_KEYS} lowercase words or short phrases that would naturally appear in a message when this entry matters. Include the subject's name.

Reply with ONLY a JSON array in this exact shape, and no other text:
[{"title": "Subject", "content": "Facts about the subject.", "keys": ["subject"]}]
If the transcript contains nothing worth keeping, reply with [].

Transcript:
${chunk}`;
}

/** Pulls the JSON array out of a model reply that may wrap it in prose or fences. */
export function parseProposals(text) {
    const raw = String(text ?? '').trim();
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = unfenced.indexOf('[');
    const end = unfenced.lastIndexOf(']');
    if (start === -1 || end <= start) {
        throw new Error('The reply contained no JSON list.');
    }
    let parsed;
    try {
        parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch {
        throw new Error('The reply\'s JSON list could not be read.');
    }
    if (!Array.isArray(parsed)) {
        throw new Error('The reply was not a JSON list.');
    }
    return parsed;
}

/**
 * Cleans raw model proposals into a uniform shape and drops unusable ones.
 * Flags rather than rejects the judgment calls: a conjunction title is a
 * warning for the reviewer, not an error.
 */
export function normalizeProposals(rawList) {
    const proposals = [];
    let dropped = 0;
    for (const raw of rawList ?? []) {
        const title = String(raw?.title ?? '').trim();
        const content = String(raw?.content ?? '').trim().slice(0, MAX_CONTENT_CHARS);
        const keys = [...new Set((Array.isArray(raw?.keys) ? raw.keys : [])
            .filter(key => typeof key === 'string')
            .map(key => key.trim().toLowerCase())
            .filter(Boolean))].slice(0, MAX_KEYS);
        if (!title || !content || !keys.length) {
            dropped++;
            continue;
        }
        proposals.push({
            title,
            content,
            keys,
            multiConcept: CONJUNCTION.test(title),
            duplicateOf: '',
        });
    }
    return { proposals, dropped };
}

function normalTitle(value) {
    return String(value ?? '').trim().toLowerCase();
}

/** Merges proposals from different chunks that clearly describe the same subject. */
export function mergeProposals(proposals) {
    const byTitle = new Map();
    for (const proposal of proposals) {
        const key = normalTitle(proposal.title);
        const existing = byTitle.get(key);
        if (!existing) {
            byTitle.set(key, { ...proposal, keys: [...proposal.keys] });
            continue;
        }
        existing.keys = [...new Set([...existing.keys, ...proposal.keys])].slice(0, MAX_KEYS);
        if (proposal.content.length > existing.content.length) {
            existing.content = proposal.content;
        }
    }
    return [...byTitle.values()];
}

/**
 * Marks proposals that likely duplicate an entry already in the lorebook:
 * a shared activation key or the same title. Marks, never drops — the
 * reviewer decides.
 */
export function markDuplicates(proposals, existingEntries) {
    const keyOwners = new Map();
    const titleOwners = new Map();
    for (const entry of existingEntries ?? []) {
        const label = String(entry?.comment ?? '').trim() || `Entry ${entry?.uid}`;
        for (const key of Array.isArray(entry?.key) ? entry.key : []) {
            const normalized = String(key ?? '').trim().toLowerCase();
            if (normalized && !keyOwners.has(normalized)) {
                keyOwners.set(normalized, label);
            }
        }
        titleOwners.set(normalTitle(label), label);
    }
    return proposals.map((proposal) => {
        const byTitle = titleOwners.get(normalTitle(proposal.title));
        const byKey = proposal.keys.map(key => keyOwners.get(key)).find(Boolean);
        return { ...proposal, duplicateOf: byTitle ?? byKey ?? '' };
    });
}
