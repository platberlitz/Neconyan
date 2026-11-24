/**
 * Pure, dependency-free parser, serializer and section catalogue for Memory Shard notes.
 *
 * Keeps zero imports so tests that partially mock host modules can load it cleanly.
 */

const MEMORY_SHARD_TEMPLATE_ID_VALUE = 'tpl-memory-shard-companion';
const MEMORY_SHARD_NAME_RE = /memory\s+shard/i;
const MEMORY_SHARD_HEADING_RE = /^\s*#\s*(?:CONSOLIDATED\s+)?MEMORY\s+SHARD\b/im;

/**
 * Standard v3 Memory Shard sections, in human reading order.
 * Every icon is mapped in public/css/neconyan-icons-map.css (Catline).
 */
export const MEMORY_SHARD_STANDARD_SECTIONS = Object.freeze([
    Object.freeze({
        id: 'current-snapshot',
        heading: 'Current Snapshot',
        aliases: Object.freeze(['current state', 'current snapshot', 'now', 'snapshot']),
        icon: 'fa-solid fa-compass',
        tone: 'current',
        placeholder: '- Location: Where the scene stands right now\n- Time: Time of day or passage of time\n- Present: Who is in the room\n- Situation: What is happening at this moment\n- Mood: Emotional atmosphere\n- Physical: Injuries, exhaustion or notable physical state\n- Next up: Immediate unresolved action, question or tension',
        starter: '- Location: \n- Time: \n- Present: \n- Situation: \n- Mood: \n- Physical: \n- Next up: ',
    }),
    Object.freeze({
        id: 'tone-atmosphere',
        heading: 'Tone & Atmosphere',
        aliases: Object.freeze(['tone', 'tone & atmosphere', 'tone and atmosphere', 'atmosphere']),
        icon: 'fa-solid fa-feather-pointed',
        tone: 'tone',
        placeholder: 'Describe the genre, pacing, prose mood and emotional register in one or two plain sentences.',
        starter: '',
    }),
    Object.freeze({
        id: 'characters',
        heading: 'Characters',
        aliases: Object.freeze(['characters', 'character registry', 'cast', 'developments']),
        icon: 'fa-solid fa-users',
        tone: 'characters',
        placeholder: '### Character Name\n- Role: Role in the story\n- Appearance: Key physical details\n- Personality: Core traits\n- Abilities: Notable skills or powers\n- Status: Current condition\n- Growth: Recent changes or turning points',
        starter: '### Character Name\n- Role: \n- Appearance: \n- Personality: \n- Abilities: \n- Status: \n- Growth: ',
    }),
    Object.freeze({
        id: 'relationships',
        heading: 'Relationships',
        aliases: Object.freeze(['relationships', 'bonds', 'dynamics']),
        icon: 'fa-solid fa-heart-pulse',
        tone: 'relationships',
        placeholder: '- Character A -> Character B: Trust, closeness, tension and what changed between them.',
        starter: '- Character A -> Character B: ',
    }),
    Object.freeze({
        id: 'world-setting',
        heading: 'World & Setting',
        aliases: Object.freeze(['world & setting', 'world and setting', 'world state', 'setting', 'world']),
        icon: 'fa-solid fa-globe',
        tone: 'world',
        placeholder: '- Locations: Important places and their current state\n- Factions: Active groups and alliances\n- Rules: World rules, magic or tech limits\n- Items: Key objects and who holds them',
        starter: '- Locations: \n- Factions: \n- Items: ',
    }),
    Object.freeze({
        id: 'story-events',
        heading: 'Story Events',
        aliases: Object.freeze(['story events', 'events', 'timeline', 'states']),
        icon: 'fa-solid fa-clock-rotate-left',
        tone: 'events',
        placeholder: '### 1. [Major] Short event title (Location)\n- What happened: Action, consequence and outcome.\n- Aftermath: Emotional and physical state of those involved.',
        starter: '### 1. [Major] Event Title (Location)\n- What happened: \n- Aftermath: ',
    }),
    Object.freeze({
        id: 'key-scenes',
        heading: 'Key Scenes',
        aliases: Object.freeze(['key scenes', 'scenes expanded', 'expanded scenes']),
        icon: 'fa-solid fa-clapperboard',
        tone: 'scenes',
        placeholder: '### Scene Title\nA short prose paragraph capturing a turning point worth keeping vivid.',
        starter: '### Scene Title\n',
    }),
    Object.freeze({
        id: 'memorable-quotes',
        heading: 'Memorable Quotes & Voices',
        aliases: Object.freeze(['memorable quotes & voices', 'memorable quotes and voices', 'dialogue keys', 'voice samples', 'quotes']),
        icon: 'fa-solid fa-quote-left',
        tone: 'quotes',
        placeholder: '- Speaker (context): "Exact memorable line."',
        starter: '- Speaker (context): ""',
    }),
    Object.freeze({
        id: 'sensory-anchors',
        heading: 'Sensory Anchors',
        aliases: Object.freeze(['sensory anchors', 'sensory details', 'motifs']),
        icon: 'fa-solid fa-eye',
        tone: 'sensory',
        placeholder: '- Detail (smell, sound, texture, sight): Why it matters and when it appeared.',
        starter: '- Detail (sense): ',
    }),
    Object.freeze({
        id: 'callbacks-threads',
        heading: 'Callbacks & Loose Threads',
        aliases: Object.freeze(['callbacks & loose threads', 'callbacks and loose threads', 'callbacks', 'loose threads', 'open threads']),
        icon: 'fa-solid fa-link',
        tone: 'threads',
        placeholder: '- [Open] Mystery or promise still waiting for payoff.\n- [Planted] Subtle detail set up for later.\n- [Resolved] Thread that has already paid off.',
        starter: '- [Open] ',
    }),
    Object.freeze({
        id: 'intimate-moments',
        heading: 'Intimate Moments',
        aliases: Object.freeze(['intimate moments', 'nsfw registry', 'intimate scenes']),
        icon: 'fa-solid fa-fire',
        tone: 'intimate',
        placeholder: 'Optional section for explicit or intimate scenes when present in the story.',
        starter: '### Scene Title (Participants)\n',
    }),
]);

const LEGACY_EXTRA_SECTION_META = Object.freeze({
    'shard reference key': Object.freeze({
        id: 'shard-reference-key',
        heading: 'Shard Reference Key',
        icon: 'fa-solid fa-key',
        tone: 'meta',
        placeholder: 'Optional legacy notation legend.',
        starter: '',
    }),
});

const DEFAULT_SECTION_META = Object.freeze({
    id: 'custom',
    heading: 'Section',
    icon: 'fa-solid fa-bookmark',
    tone: 'custom',
    placeholder: 'Write notes in plain text or Markdown.',
    starter: '',
});

/**
 * Look up display metadata (icon, tone, placeholder) for a section heading.
 * Matches both v3 headings and legacy v2 headings case-insensitively.
 *
 * @param {string} heading
 * @returns {{ id: string, heading: string, icon: string, tone: string, placeholder: string, starter: string }}
 */
export function getMemoryShardSectionMeta(heading) {
    const normalized = String(heading || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) {
        return DEFAULT_SECTION_META;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_EXTRA_SECTION_META, normalized)) {
        return LEGACY_EXTRA_SECTION_META[normalized];
    }
    for (const entry of MEMORY_SHARD_STANDARD_SECTIONS) {
        if (entry.heading.toLowerCase() === normalized || entry.aliases.includes(normalized)) {
            return entry;
        }
    }
    return {
        ...DEFAULT_SECTION_META,
        heading: String(heading || '').trim() || DEFAULT_SECTION_META.heading,
    };
}

/**
 * Decide whether a companion agent/result should open the section-aware Memory Shard editor.
 *
 * @param {{ agent?: { sourceTemplateId?: string, name?: string } | null, content?: string }} target
 * @returns {boolean}
 */
export function isMemoryShardTarget({ agent = null, content = '' } = {}) {
    if (agent?.sourceTemplateId === MEMORY_SHARD_TEMPLATE_ID_VALUE) {
        return true;
    }
    if (typeof agent?.name === 'string' && MEMORY_SHARD_NAME_RE.test(agent.name)) {
        return true;
    }
    if (typeof content === 'string' && MEMORY_SHARD_HEADING_RE.test(content)) {
        return true;
    }
    return false;
}

/**
 * Parse a Memory Shard Markdown string into structured editable pieces:
 * an optional top-level `# ` heading, optional preamble lines before the first `## `,
 * and an ordered array of `{ heading, body }` sections.
 *
 * Fenced code blocks (` ``` ` or `~~~`) are ignored when detecting headings.
 *
 * @param {string} raw
 * @returns {{
 *   title: string,
 *   hasTitle: boolean,
 *   isConsolidated: boolean,
 *   preamble: string,
 *   sections: Array<{ heading: string, body: string }>,
 * }}
 */
export function parseMemoryShardDocument(raw) {
    const normalized = String(raw ?? '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');

    let title = '';
    let hasTitle = false;
    const preambleLines = [];
    const sections = [];
    let currentSection = null;
    let activeFenceChar = '';
    let activeFenceLength = 0;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            const char = marker[0];
            if (!activeFenceChar) {
                activeFenceChar = char;
                activeFenceLength = marker.length;
            } else if (char === activeFenceChar && marker.length >= activeFenceLength && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) {
                activeFenceChar = '';
                activeFenceLength = 0;
            }
        }

        if (!activeFenceChar) {
            if (!hasTitle && !currentSection && preambleLines.every((entry) => entry.trim() === '')) {
                const h1Match = line.match(/^#\s+(.+?)\s*$/);
                if (h1Match) {
                    title = h1Match[1].trim();
                    hasTitle = true;
                    preambleLines.length = 0;
                    continue;
                }
            }

            const h2Match = line.match(/^##\s+(.+?)\s*$/);
            if (h2Match) {
                if (currentSection) {
                    sections.push({
                        heading: currentSection.heading,
                        body: trimBlankEdges(currentSection.lines).join('\n'),
                    });
                }
                currentSection = {
                    heading: h2Match[1].trim(),
                    lines: [],
                };
                continue;
            }
        }

        if (currentSection) {
            currentSection.lines.push(line);
        } else {
            preambleLines.push(line);
        }
    }

    if (currentSection) {
        sections.push({
            heading: currentSection.heading,
            body: trimBlankEdges(currentSection.lines).join('\n'),
        });
    }

    const preamble = trimBlankEdges(preambleLines).join('\n');
    const isConsolidated = /^CONSOLIDATED\s+MEMORY\s+SHARD\b/i.test(title);

    return {
        title,
        hasTitle,
        isConsolidated,
        preamble,
        sections,
    };
}

/**
 * Serialize a parsed Memory Shard document back into clean, human-readable Markdown.
 *
 * @param {{
 *   title?: string,
 *   preamble?: string,
 *   sections?: Array<{ heading?: string, body?: string }>,
 * }} doc
 * @returns {string}
 */
export function serializeMemoryShardDocument(doc) {
    const blocks = [];
    const title = String(doc?.title ?? '').trim();
    const preamble = trimBlankEdges(String(doc?.preamble ?? '').replace(/\r\n?/g, '\n').split('\n')).join('\n');
    const sections = Array.isArray(doc?.sections) ? doc.sections : [];

    if (title) {
        blocks.push(`# ${title}`);
    }
    if (preamble) {
        blocks.push(preamble);
    }

    for (const section of sections) {
        const heading = String(section?.heading ?? '').trim();
        const body = trimBlankEdges(String(section?.body ?? '').replace(/\r\n?/g, '\n').split('\n')).join('\n');
        if (!heading && !body) {
            continue;
        }
        if (heading) {
            blocks.push(body ? `## ${heading}\n${body}` : `## ${heading}`);
        } else {
            blocks.push(body);
        }
    }

    return blocks.join('\n\n');
}

/**
 * Build a short one-line plain-text preview of a section body for collapsed cards.
 *
 * @param {string} body
 * @param {number} [maxLength=88]
 * @returns {string}
 */
export function summarizeMemoryShardSection(body, maxLength = 88) {
    const lines = String(body || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return '';
    }

    const cleaned = lines
        .slice(0, 2)
        .map((line) => line
            .replace(/^#{1,6}\s+/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/^\d+\.\s+/, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .trim())
        .filter(Boolean)
        .join(' / ');

    if (cleaned.length <= maxLength) {
        return cleaned;
    }
    return `${cleaned.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

/**
 * Count non-empty lines inside a section body for a compact summary pill.
 *
 * @param {string} body
 * @returns {number}
 */
export function countMemoryShardSectionLines(body) {
    return String(body || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
}

/**
 * Return standard section presets not already present in a parsed document.
 *
 * @param {Array<{ heading?: string }>} existingSections
 * @returns {Array<typeof MEMORY_SHARD_STANDARD_SECTIONS[number]>}
 */
export function getMissingMemoryShardStandardSections(existingSections) {
    const present = new Set(
        (Array.isArray(existingSections) ? existingSections : [])
            .map((section) => String(section?.heading || '').trim().toLowerCase().replace(/\s+/g, ' '))
            .filter(Boolean),
    );
    return MEMORY_SHARD_STANDARD_SECTIONS.filter((entry) => {
        if (present.has(entry.heading.toLowerCase())) {
            return false;
        }
        return !entry.aliases.some((alias) => present.has(alias));
    });
}

/**
 * Remove leading and trailing empty lines without altering internal spacing.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function trimBlankEdges(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') {
        start += 1;
    }
    while (end > start && lines[end - 1].trim() === '') {
        end -= 1;
    }
    return lines.slice(start, end);
}
