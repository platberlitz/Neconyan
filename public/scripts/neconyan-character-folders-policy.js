/**
 * Dependency-free rules for character folder tabs, import auto-sort and AI sorting.
 * Kept free of DOM and app imports so Jest can load it directly.
 */

export const CHARACTER_FOLDER_SETTINGS_KEY = 'character_folder_sort';
export const CHARACTER_FOLDER_SETTINGS_VERSION = 1;

export const AUTO_SORT_FOLDER_TYPES = Object.freeze(['OPEN', 'CLOSED']);
export const AI_SORT_SCOPES = Object.freeze(['unsorted', 'all']);
export const AI_SORT_BATCH_MIN = 5;
export const AI_SORT_BATCH_MAX = 60;
export const AI_SORT_DEFAULT_BATCH = 25;
export const AI_SORT_MAX_CUSTOM_PROMPTS = 30;
export const AI_SORT_MAX_PROMPT_LENGTH = 4000;
export const AI_SORT_MAX_FOLDER_NAME_LENGTH = 48;
const CARD_EXCERPT_LENGTH = 280;

/**
 * Sites a character card can come from. `hosts` match the host name itself or any
 * subdomain of it; `markers` are `data.extensions` keys some sites leave on cards.
 */
export const IMPORT_SOURCES = Object.freeze([
    { id: 'janitorai', label: 'JanitorAI', hosts: ['janitorai.com', 'jani.com', 'janitorai.ai'] },
    { id: 'jannyai', label: 'JannyAI', hosts: ['jannyai.com'] },
    { id: 'chub', label: 'Chub', hosts: ['chub.ai', 'characterhub.org', 'charhub.io'], markers: ['chub'] },
    { id: 'botbooru', label: 'Botbooru', hosts: ['botbooru.com'] },
    { id: 'pygmalion', label: 'Pygmalion', hosts: ['pygmalion.chat'] },
    { id: 'risurealm', label: 'RisuRealm', hosts: ['realm.risuai.net', 'risuai.xyz'], markers: ['risuai'] },
    { id: 'aicharactercards', label: 'AI Character Cards', hosts: ['aicharactercards.com'] },
    { id: 'perchance', label: 'Perchance', hosts: ['perchance.org'], markers: ['perchance_data'] },
    { id: 'wyvern', label: 'Wyvern', hosts: ['wyvern.chat'] },
    { id: 'saucepan', label: 'Saucepan.ai', hosts: ['saucepan.ai'] },
    { id: 'quillgen', label: 'Quillgen', hosts: ['quillgen.app'] },
    { id: 'charactertavern', label: 'Character Tavern', hosts: ['character-tavern.com'] },
    { id: 'backyard', label: 'Backyard AI', hosts: ['backyard.ai'], extensions: ['byaf'] },
]);

const SOURCE_BY_ID = new Map(IMPORT_SOURCES.map(source => [source.id, source]));

export const AI_SORT_PRESETS = Object.freeze([
    {
        id: 'genre',
        label: 'Genre',
        prompt: 'Sort each character into a folder named after the genre of their story, such as Fantasy, Sci-fi, Horror, Romance, Slice of life, Mystery, Historical or Comedy. Pick the single genre that fits best.',
    },
    {
        id: 'fandom',
        label: 'Fandom or original',
        prompt: 'Sort each character by where they come from. Characters from an existing game, anime, film, book or show go into a folder named after that franchise. Characters invented for the card go into a folder named Original.',
    },
    {
        id: 'role',
        label: 'Role',
        prompt: 'Sort each character by the role they play in a chat: Companion, Adventure, Game master or Narrator, Assistant or Utility, Group scenario, or Roleplay partner. Pick the one that fits best.',
    },
    {
        id: 'setting',
        label: 'Setting',
        prompt: 'Sort each character by the world their story takes place in: Modern day, Historical, Fantasy world, Space or Future, Post-apocalyptic, School, or Workplace. Pick the closest match.',
    },
    {
        id: 'existing',
        label: 'My existing folders',
        prompt: 'Sort each character into whichever of my existing folders suits them best. Use only the folders listed, and leave a character out when none of them fits.',
        existingOnly: true,
    },
]);

const PRESET_BY_ID = new Map(AI_SORT_PRESETS.map(preset => [preset.id, preset]));

/**
 * @typedef {object} CharacterFolderSettings
 * @property {number} version
 * @property {{ collapsed: boolean, hidden: string[] }} tabs
 * @property {{ enabled: boolean, createFolders: boolean, folderType: 'OPEN'|'CLOSED', sources: Record<string, string> }} autoSort
 * @property {{ promptId: string, customPrompts: { id: string, name: string, prompt: string }[], scope: 'unsorted'|'all', allowNewFolders: boolean, batchSize: number }} ai
 */

/** @returns {CharacterFolderSettings} */
export function defaultCharacterFolderSettings() {
    return {
        version: CHARACTER_FOLDER_SETTINGS_VERSION,
        tabs: { collapsed: false, hidden: [] },
        autoSort: { enabled: false, createFolders: true, folderType: 'OPEN', sources: {} },
        ai: { promptId: 'genre', customPrompts: [], scope: 'unsorted', allowNewFolders: true, batchSize: AI_SORT_DEFAULT_BATCH },
    };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, maxLength = 200) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Fills in missing or invalid settings without dropping anything valid.
 * @param {any} raw
 * @returns {CharacterFolderSettings}
 */
export function normalizeCharacterFolderSettings(raw) {
    const defaults = defaultCharacterFolderSettings();
    const source = isPlainObject(raw) ? raw : {};
    const tabs = isPlainObject(source.tabs) ? source.tabs : {};
    const autoSort = isPlainObject(source.autoSort) ? source.autoSort : {};
    const ai = isPlainObject(source.ai) ? source.ai : {};

    const hidden = Array.isArray(tabs.hidden)
        ? [...new Set(tabs.hidden.filter(id => typeof id === 'string' && id))]
        : [];

    const sources = {};
    if (isPlainObject(autoSort.sources)) {
        for (const [sourceId, tagId] of Object.entries(autoSort.sources)) {
            if (SOURCE_BY_ID.has(sourceId) && typeof tagId === 'string' && tagId) {
                sources[sourceId] = tagId;
            }
        }
    }

    const seenPromptIds = new Set();
    const customPrompts = (Array.isArray(ai.customPrompts) ? ai.customPrompts : [])
        .filter(isPlainObject)
        .map(item => ({
            id: cleanString(item.id, 80),
            name: cleanString(item.name, 80),
            prompt: cleanString(item.prompt, AI_SORT_MAX_PROMPT_LENGTH),
        }))
        .filter(item => {
            if (!item.id || !item.name || !item.prompt || seenPromptIds.has(item.id) || PRESET_BY_ID.has(item.id)) return false;
            seenPromptIds.add(item.id);
            return true;
        })
        .slice(0, AI_SORT_MAX_CUSTOM_PROMPTS);

    const promptId = cleanString(ai.promptId, 80);
    const knownPrompt = PRESET_BY_ID.has(promptId) || customPrompts.some(item => item.id === promptId);

    return {
        version: CHARACTER_FOLDER_SETTINGS_VERSION,
        tabs: {
            collapsed: typeof tabs.collapsed === 'boolean' ? tabs.collapsed : defaults.tabs.collapsed,
            hidden,
        },
        autoSort: {
            enabled: typeof autoSort.enabled === 'boolean' ? autoSort.enabled : defaults.autoSort.enabled,
            createFolders: typeof autoSort.createFolders === 'boolean' ? autoSort.createFolders : defaults.autoSort.createFolders,
            folderType: AUTO_SORT_FOLDER_TYPES.includes(autoSort.folderType) ? autoSort.folderType : defaults.autoSort.folderType,
            sources,
        },
        ai: {
            promptId: knownPrompt ? promptId : defaults.ai.promptId,
            customPrompts,
            scope: AI_SORT_SCOPES.includes(ai.scope) ? ai.scope : defaults.ai.scope,
            allowNewFolders: typeof ai.allowNewFolders === 'boolean' ? ai.allowNewFolders : defaults.ai.allowNewFolders,
            batchSize: clampInteger(ai.batchSize, AI_SORT_BATCH_MIN, AI_SORT_BATCH_MAX, defaults.ai.batchSize),
        },
    };
}

/** @param {string} id */
export function getImportSource(id) {
    return SOURCE_BY_ID.get(String(id || '').toLowerCase()) ?? null;
}

/** @param {string} id */
export function getImportSourceLabel(id) {
    return getImportSource(id)?.label ?? '';
}

/**
 * @param {string} host
 * @param {string} pattern
 */
function hostMatches(host, pattern) {
    return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * Finds the import source for a URL or bare host name.
 * @param {string} value
 * @returns {string} source id, or an empty string
 */
export function detectSourceFromUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let host = '';
    try {
        host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname;
    } catch {
        return '';
    }
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host) return '';
    // JanitorAI runs several mirrors whose names all contain 'janitorai'.
    if (host.split('.').some(label => label === 'janitorai')) return 'janitorai';
    for (const source of IMPORT_SOURCES) {
        if (source.hosts.some(pattern => hostMatches(host, pattern))) return source.id;
    }
    return '';
}

/**
 * Finds where an imported card came from, using the strongest evidence first:
 * the import URL, a site id passed by the importer, a site prefix on the file
 * name (Bot Browser names files `<site>-<slug>`), the file type, and finally
 * markers some sites leave inside the card.
 *
 * @param {object} input
 * @param {string} [input.sourceUrl]
 * @param {string} [input.sourceId]
 * @param {string} [input.fileName]
 * @param {any} [input.card] Character object or card data
 * @returns {string} source id, or an empty string when unknown
 */
export function detectImportSource({ sourceUrl = '', sourceId = '', fileName = '', card = null } = {}) {
    const fromUrl = detectSourceFromUrl(sourceUrl);
    if (fromUrl) return fromUrl;

    const explicit = getImportSource(sourceId);
    if (explicit) return explicit.id;

    const name = String(fileName || '').toLowerCase().split(/[\\/]/).pop() || '';
    const prefix = name.match(/^([a-z0-9]+)-/)?.[1] || '';
    if (prefix && SOURCE_BY_ID.has(prefix)) return prefix;

    const extension = name.includes('.') ? name.split('.').pop() : '';
    if (extension) {
        const byExtension = IMPORT_SOURCES.find(source => source.extensions?.includes(extension));
        if (byExtension) return byExtension.id;
    }

    const extensions = card?.data?.extensions;
    if (isPlainObject(extensions)) {
        for (const source of IMPORT_SOURCES) {
            if (source.markers?.some(marker => extensions[marker] !== undefined && extensions[marker] !== null && extensions[marker] !== '')) {
                return source.id;
            }
        }
    }

    return '';
}

function normalizeFolderName(name) {
    return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Decides which folder an imported card should go into.
 *
 * @param {object} input
 * @param {string} input.sourceId Detected source id
 * @param {CharacterFolderSettings} input.settings
 * @param {{ id: string, name: string, folder_type?: string }[]} input.tags Every tag
 * @returns {{ action: 'none' } | { action: 'existing', tagId: string, makeFolder: boolean } | { action: 'create', name: string }}
 */
export function planImportFolder({ sourceId, settings, tags }) {
    const source = getImportSource(sourceId);
    if (!source || !settings?.autoSort?.enabled) return { action: 'none' };
    const list = Array.isArray(tags) ? tags : [];

    const mappedId = settings.autoSort.sources?.[source.id];
    const mapped = mappedId ? list.find(tag => tag?.id === mappedId) : null;
    if (mapped) {
        return { action: 'existing', tagId: mapped.id, makeFolder: !isFolderTag(mapped) };
    }

    const sameName = list.find(tag => normalizeFolderName(tag?.name) === normalizeFolderName(source.label));
    if (sameName) {
        return { action: 'existing', tagId: sameName.id, makeFolder: !isFolderTag(sameName) };
    }

    if (!settings.autoSort.createFolders) return { action: 'none' };
    return { action: 'create', name: source.label };
}

/** @param {{ folder_type?: string }} tag */
export function isFolderTag(tag) {
    return AUTO_SORT_FOLDER_TYPES.includes(tag?.folder_type);
}

/**
 * Builds the folder tab list: folders in their tag order, with how many
 * characters each one holds.
 *
 * @param {object} input
 * @param {{ id: string, name: string, folder_type?: string }[]} input.tags Tags already in display order
 * @param {Record<string, string[]>} input.tagMap
 * @param {Set<string>|string[]} [input.entityKeys] Keys that still exist; others are not counted
 * @param {string[]} [input.hidden] Tag ids the user hid from the tab rail
 * @param {string[]} [input.selected] Tag ids currently selected in the tag filter
 */
export function buildFolderTabs({ tags, tagMap, entityKeys = null, hidden = [], selected = [] }) {
    const known = entityKeys ? new Set(entityKeys) : null;
    const counts = new Map();
    for (const [key, ids] of Object.entries(tagMap || {})) {
        if (known && !known.has(key)) continue;
        if (!Array.isArray(ids)) continue;
        for (const id of new Set(ids)) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const hiddenSet = new Set(hidden);
    const selectedSet = new Set(selected);
    return (Array.isArray(tags) ? tags : [])
        .filter(isFolderTag)
        .map(tag => ({
            id: tag.id,
            name: tag.name,
            closed: tag.folder_type === 'CLOSED',
            count: counts.get(tag.id) || 0,
            hidden: hiddenSet.has(tag.id),
            selected: selectedSet.has(tag.id),
        }));
}

/**
 * @param {string} promptId
 * @param {CharacterFolderSettings} settings
 * @returns {{ id: string, name: string, prompt: string, custom: boolean, existingOnly: boolean } | null}
 */
export function resolveAiSortPrompt(promptId, settings) {
    const preset = PRESET_BY_ID.get(promptId);
    if (preset) return { id: preset.id, name: preset.label, prompt: preset.prompt, custom: false, existingOnly: Boolean(preset.existingOnly) };
    const custom = settings?.ai?.customPrompts?.find(item => item.id === promptId);
    if (custom) return { id: custom.id, name: custom.name, prompt: custom.prompt, custom: true, existingOnly: false };
    return null;
}

function excerpt(value, length = CARD_EXCERPT_LENGTH) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Turns a character into the short record the model sees.
 * @param {any} character
 * @param {string[]} tagNames
 */
export function summarizeCharacterForSort(character, tagNames = []) {
    const data = character?.data ?? {};
    return {
        name: excerpt(character?.name || data.name, 80),
        description: excerpt(data.description ?? character?.description),
        scenario: excerpt(data.scenario ?? character?.scenario, 160),
        creatorNotes: excerpt(data.creator_notes ?? character?.creatorcomment, 160),
        tags: [...new Set([...(Array.isArray(data.tags) ? data.tags : []), ...tagNames])]
            .map(tag => excerpt(tag, 40))
            .filter(Boolean)
            .slice(0, 12),
    };
}

/**
 * @param {object} input
 * @param {string} input.instructions The chosen preset or custom prompt
 * @param {string[]} input.folders Existing folder names
 * @param {ReturnType<typeof summarizeCharacterForSort>[]} input.characters
 * @param {boolean} input.allowNewFolders
 * @returns {{ systemPrompt: string, prompt: string }}
 */
export function buildAiSortPrompt({ instructions, folders, characters, allowNewFolders }) {
    const folderList = (folders || []).filter(Boolean);
    const systemPrompt = [
        'You organise a library of roleplay character cards into folders.',
        'Read each character and choose one folder for it, following the sorting rule exactly.',
        allowNewFolders
            ? 'Reuse an existing folder whenever one fits. Create a new folder name only when none of the existing folders fits, and keep new names short (one to three words, title case).'
            : 'Choose only from the existing folders, spelled exactly as listed. Skip a character when none of them fits.',
        'Reply with JSON alone, in this form: {"assignments":[{"id":1,"folder":"Folder name"}]}. Use the numeric id given for each character.',
    ].join('\n');

    const characterLines = characters.map((character, index) => {
        const parts = [`#${index + 1} ${character.name || 'Unnamed'}`];
        if (character.tags?.length) parts.push(`Tags: ${character.tags.join(', ')}`);
        if (character.description) parts.push(`Description: ${character.description}`);
        if (character.scenario) parts.push(`Scenario: ${character.scenario}`);
        if (character.creatorNotes) parts.push(`Creator notes: ${character.creatorNotes}`);
        return parts.join('\n');
    });

    const prompt = [
        `Sorting rule:\n${String(instructions || '').trim()}`,
        `Existing folders: ${folderList.length ? folderList.join(', ') : '(none yet)'}`,
        `Characters:\n\n${characterLines.join('\n\n')}`,
        'Return the JSON now.',
    ].join('\n\n');

    return { systemPrompt, prompt };
}

function extractJson(text) {
    const raw = String(text || '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], raw];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const trimmed = candidate.trim();
        try {
            return JSON.parse(trimmed);
        } catch {
            // Fall through to the bracket search below.
        }
        const start = trimmed.search(/[[{]/);
        if (start < 0) continue;
        const open = trimmed[start];
        const close = open === '{' ? '}' : ']';
        const end = trimmed.lastIndexOf(close);
        if (end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                // Try the next candidate.
            }
        }
    }
    return null;
}

/**
 * Cleans a folder name suggested by a model.
 * @param {string} name
 */
export function cleanFolderName(name) {
    return String(name || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/^["'`\s#*-]+|["'`\s*.]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, AI_SORT_MAX_FOLDER_NAME_LENGTH)
        .trim();
}

/**
 * Reads the model reply into assignments for one batch.
 *
 * @param {string} text Raw model reply
 * @param {object} input
 * @param {number} input.count How many characters were in the batch
 * @param {string[]} input.folders Existing folder names
 * @param {boolean} input.allowNewFolders
 * @param {boolean} [input.strict] Report malformed replies rather than treating them as no assignments
 * @returns {{ index: number, folder: string, isNew: boolean }[]} index is 0-based within the batch
 */
export function parseAiSortResponse(text, { count, folders = [], allowNewFolders = true, strict = false }) {
    const parsed = extractJson(text);
    const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.assignments) ? parsed.assignments
            : null;
    if (!list) {
        if (strict) throw Object.assign(new Error('Could not read the sorting reply'), { code: String(text || '').trim() ? 'invalid_model_reply' : 'empty_model_reply' });
        return [];
    }
    const existing = new Map(folders.map(name => [normalizeFolderName(name), name]));
    const seen = new Set();
    const result = [];
    for (const item of list) {
        if (!isPlainObject(item)) continue;
        const index = Number.parseInt(String(item.id ?? item.index ?? '').replace(/^#/, ''), 10) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
        const folder = cleanFolderName(item.folder ?? item.folderName ?? item.name);
        if (!folder) continue;
        const match = existing.get(normalizeFolderName(folder));
        if (!match && !allowNewFolders) continue;
        seen.add(index);
        result.push({ index, folder: match ?? folder, isNew: !match });
    }
    return result;
}

export function describeAiSortPlan({ characterCount, batchSize, allowNewFolders, existingFolderCount }) {
    const count = Math.max(0, Math.floor(Number(characterCount) || 0));
    const size = clampInteger(batchSize, AI_SORT_BATCH_MIN, AI_SORT_BATCH_MAX, AI_SORT_DEFAULT_BATCH);
    const blockedReason = !count ? 'empty_scope' : (!allowNewFolders && !existingFolderCount ? 'no_folders_allowed' : null);
    return { characterCount: count, batchCount: blockedReason ? 0 : Math.ceil(count / size), batchSize: size, blockedReason };
}

export function classifyAiSortError(error) {
    const code = String(error?.code || '').toLowerCase();
    const status = Number(error?.status);
    const detail = String(error?.message || error || '').toLowerCase();
    let message;
    if (error?.name === 'AbortError' || /^(aborted|cancelled|canceled)$/.test(code) || /\b(aborted|cancelled|canceled)\b/.test(detail)) {
        message = 'Sorting stopped.';
    } else if (code === 'settings_conflict') {
        message = 'Reload this page to get the settings saved on another device, then try again.';
    } else if (['active_settings_ack_required', 'settings_save_failed'].includes(code) || /save the (active connection settings|current active provider)|active connection settings are not acknowledged/.test(detail)) {
        message = 'Save your settings in Connections, then try again.';
    } else if (status === 401 || status === 403 || /api[_ -]?key|unauthori[sz]ed|authentication|invalid token/.test(`${code} ${detail}`)) {
        message = 'Check your API key in Connections, reconnect and try again.';
    } else if (status === 429 || /rate.?limit|quota|too many requests|insufficient (credits|balance)/.test(`${code} ${detail}`)) {
        message = 'Wait a moment or check your provider\'s usage limits, then try again.';
    } else if (/reasoning[._ -]?effort/.test(`${code} ${detail}`)) {
        message = 'Change Reasoning Effort in Connections, then try again.';
    } else if (status === 413 || /context[_ -]length|context window|(?:prompt|input|request|context) (?:is )?too (?:long|large)|too many tokens|maximum context/.test(`${code} ${detail}`)) {
        message = 'Lower \'Characters per request\' and try again.';
    } else if (/no_connection|no connection|not connected|unsupported .*backend|not supported by|connect to a model|choose a .*model/.test(`${code} ${detail}`)) {
        message = 'Connect to a model in Connections, then try again.';
    } else if (/offline|network|failed to fetch|load failed|timed? ?out|connection (?:lost|refused|reset)|econnreset|econnrefused/.test(`${code} ${detail}`)) {
        message = 'Check your internet and model connection, then try again.';
    } else if (code === 'empty_model_reply' || /empty (?:reply|response|output)|(?:reply|response|output) (?:was|is) empty|no (?:reply|text|message generated)/.test(detail)) {
        return { message: 'The model sent an empty reply. Try again, or choose another model in Connections.', fatal: false, empty: true };
    } else if (code === 'invalid_model_reply' || /non.json|invalid json|unexpected token/.test(detail)) {
        return { message: 'The model sent a reply that could not be read. Try another prompt or fewer characters per request.', fatal: false };
    } else {
        message = 'Check that your model is available in Connections, then try again.';
    }
    return { message, fatal: true };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function chunkForAiSort(items, size) {
    const step = clampInteger(size, AI_SORT_BATCH_MIN, AI_SORT_BATCH_MAX, AI_SORT_DEFAULT_BATCH);
    const chunks = [];
    for (let index = 0; index < items.length; index += step) {
        chunks.push(items.slice(index, index + step));
    }
    return chunks;
}

/**
 * Gives new folders found across batches one shared spelling, so 'sci-fi' and
 * 'Sci-Fi' from two batches become a single folder.
 *
 * @param {{ folder: string, isNew: boolean }[]} assignments
 */
export function mergeNewFolderSpellings(assignments) {
    const spelling = new Map();
    return assignments.map(item => {
        if (!item.isNew) return item;
        const key = normalizeFolderName(item.folder);
        if (!spelling.has(key)) spelling.set(key, item.folder);
        return { ...item, folder: spelling.get(key) };
    });
}

/**
 * @param {string} name
 * @param {string} prompt
 * @param {string[]} existingIds
 */
export function createCustomPrompt(name, prompt, existingIds = []) {
    const base = `custom-${normalizeFolderName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'prompt'}`;
    const taken = new Set([...existingIds, ...PRESET_BY_ID.keys()]);
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
    return {
        id,
        name: cleanString(name, 80),
        prompt: cleanString(prompt, AI_SORT_MAX_PROMPT_LENGTH),
    };
}

export { normalizeFolderName };
