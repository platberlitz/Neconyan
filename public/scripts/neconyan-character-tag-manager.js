/**
 * Pure data helpers for Neconyan's native Character Tag Manager.
 *
 * This module deliberately has no DOM access, no imports from the application and no
 * top-level side effects. The popup code in `tags.js` owns rendering and settings writes;
 * everything here can be unit tested in isolation.
 */

/** @typedef {import('./tags.js').Tag} Tag */

export const TAG_SORT_MODES = Object.freeze({
    MANUAL: 'manual',
    ALPHABETICAL: 'alphabetical',
    ALPHABETICAL_DESC: 'alphabetical_desc',
    BY_ENTRIES: 'by_entries',
    BY_ENTRIES_ASC: 'by_entries_asc',
});

export const TAG_FILTER_MODES = Object.freeze({
    ALL: 'all',
    FOLDERS: 'folders',
    OPEN_FOLDER: 'open_folder',
    CLOSED_FOLDER: 'closed_folder',
    NO_FOLDER: 'no_folder',
    UNUSED: 'unused',
    WITH_NOTES: 'with_notes',
});

export const ENTITY_FILTER_MODES = Object.freeze({
    ALL: 'all',
    CHARACTERS: 'characters',
    GROUPS: 'groups',
    UNTAGGED: 'untagged',
    TAGGED: 'tagged',
    IN_FOLDER: 'in_folder',
    NO_FOLDER: 'no_folder',
    WITH_NOTES: 'with_notes',
    WITHOUT_NOTES: 'without_notes',
    FAVORITES: 'favorites',
});

export const ENTITY_SORT_MODES = Object.freeze({
    ALPHA_ASC: 'alpha_asc',
    ALPHA_DESC: 'alpha_desc',
    TAG_COUNT_DESC: 'tag_count_desc',
    TAG_COUNT_ASC: 'tag_count_asc',
});

const FOLDER_TYPES = new Set(['OPEN', 'CLOSED']);
const SEARCH_TOKEN_PATTERN = /(?:[^\s"]+|"[^"]*")+/g;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePlain(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
    return isPlainObject(object) && Object.hasOwn(object, key);
}

function setOwn(object, key, value) {
    Object.defineProperty(object, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
    });
}

function asTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function contains(value, needle) {
    return String(value ?? '').toLowerCase().includes(needle);
}

function splitOrGroups(rawQuery) {
    return String(rawQuery ?? '')
        .split(',')
        .map(group => group.trim())
        .filter(Boolean);
}

function tokenizeGroup(group) {
    return group.match(SEARCH_TOKEN_PATTERN) ?? [];
}

function stripQuotes(value) {
    return String(value ?? '').replace(/^"|"$/g, '').trim();
}

function parseSearchTerm(rawToken, prefixes) {
    let token = String(rawToken ?? '').trim();
    let negated = false;

    if (token.startsWith('-')) {
        negated = true;
        token = token.slice(1);
    }

    if (!token) {
        return null;
    }

    let prefix = null;
    let value = token;
    const prefixMatch = token.match(/^([a-z]):(.*)$/is);

    if (prefixMatch && prefixes.has(prefixMatch[1].toLowerCase())) {
        prefix = prefixMatch[1].toLowerCase();
        value = prefixMatch[2];
    }

    value = stripQuotes(value);

    if (!value) {
        return null;
    }

    return { raw: rawToken, value, negated, prefix };
}

/**
 * Parses a tag search query into comma-separated OR groups of AND terms.
 *
 * Supported terms: `name`, `note`, and `c:<character or group name>`.
 * A leading `-` negates a term. Double quotes keep a phrase together.
 *
 * @param {string} rawQuery Search text
 * @returns {{groups: Array<Array<{raw: string, value: string, negated: boolean, prefix: string|null}>>}}
 */
export function parseTagSearchQuery(rawQuery) {
    const groups = splitOrGroups(rawQuery)
        .map(group => tokenizeGroup(group)
            .map(token => parseSearchTerm(token, new Set(['c'])))
            .filter(Boolean))
        .filter(group => group.length > 0);

    return { groups };
}

/**
 * Parses a character and group search query into comma-separated OR groups of AND terms.
 *
 * Supported prefixes: `t:` assigned tag, `f:` assigned folder tag, `a:` all searchable
 * fields, `n:` organiser note. A leading `-` negates a term. Double quotes keep a phrase
 * together.
 *
 * @param {string} rawQuery Search text
 * @returns {{groups: Array<Array<{raw: string, value: string, negated: boolean, prefix: string|null}>>}}
 */
export function parseEntitySearchQuery(rawQuery) {
    const groups = splitOrGroups(rawQuery)
        .map(group => tokenizeGroup(group)
            .map(token => parseSearchTerm(token, new Set(['t', 'f', 'a', 'n'])))
            .filter(Boolean))
        .filter(group => group.length > 0);

    return { groups };
}

function getTagNoteValue(tag) {
    return asTrimmedString(tag?.note);
}

/**
 * Reads a tag note. A tag without a note always returns an empty string.
 *
 * @param {Tag} tag Tag
 * @returns {string} Trimmed note
 */
export function getTagNote(tag) {
    return getTagNoteValue(tag);
}

/**
 * Writes or removes a tag note. The property is deleted when the note is empty so a fresh
 * account never gets an empty `note` property written into its settings.
 *
 * @param {Tag} tag Tag
 * @param {string} noteText Note text
 * @returns {boolean} Whether the tag changed
 */
export function setTagNote(tag, noteText) {
    if (!tag || typeof tag !== 'object') {
        return false;
    }

    const next = asTrimmedString(noteText);
    const current = getTagNoteValue(tag);

    if (next) {
        if (current === next && Object.hasOwn(tag, 'note')) {
            return false;
        }
        tag.note = next;
        return true;
    }

    if (!Object.hasOwn(tag, 'note')) {
        return false;
    }

    delete tag.note;
    return true;
}

function getEntityNotesBucket(powerUser) {
    return isPlainObject(powerUser?.character_tag_notes) ? powerUser.character_tag_notes : null;
}

/**
 * Reads one character or group organiser note.
 *
 * @param {object} powerUser Power user settings
 * @param {string|number} entityKey Character avatar or group id
 * @returns {string} Trimmed note
 */
export function getEntityOrganizerNote(powerUser, entityKey) {
    if (entityKey === undefined || entityKey === null) {
        return '';
    }
    const notes = getEntityNotesBucket(powerUser);
    const key = String(entityKey);
    return notes && hasOwn(notes, key) ? asTrimmedString(notes[key]) : '';
}

/**
 * Writes or removes one character or group organiser note. The whole notes bucket is
 * removed when the last note goes, keeping startup settings identical for fresh accounts.
 *
 * @param {object} powerUser Power user settings
 * @param {string|number} entityKey Character avatar or group id
 * @param {string} noteText Note text
 * @returns {boolean} Whether the settings changed
 */
export function setEntityOrganizerNote(powerUser, entityKey, noteText) {
    if (!powerUser || typeof powerUser !== 'object' || entityKey === undefined || entityKey === null) {
        return false;
    }

    const key = String(entityKey);
    const next = asTrimmedString(noteText);
    let notes = getEntityNotesBucket(powerUser);

    if (next) {
        if (!notes) {
            notes = {};
            powerUser.character_tag_notes = notes;
        }
        if (hasOwn(notes, key) && asTrimmedString(notes[key]) === next) {
            return false;
        }
        setOwn(notes, key, next);
        return true;
    }

    if (!notes || !hasOwn(notes, key)) {
        return false;
    }

    delete notes[key];

    if (Object.keys(notes).length === 0) {
        delete powerUser.character_tag_notes;
    }

    return true;
}

/**
 * Moves an organiser note when a character avatar or group key changes.
 *
 * @param {object} powerUser Power user settings
 * @param {string|number} oldKey Old entity key
 * @param {string|number} newKey New entity key
 * @returns {boolean} Whether anything changed
 */
export function renameEntityOrganizerNoteKey(powerUser, oldKey, newKey) {
    const notes = getEntityNotesBucket(powerUser);
    if (!notes || oldKey === undefined || newKey === undefined || newKey === null) {
        return false;
    }

    const oldKeyString = String(oldKey);
    const newKeyString = String(newKey);

    if (oldKeyString === newKeyString || !hasOwn(notes, oldKeyString)) {
        return false;
    }

    const note = asTrimmedString(notes[oldKeyString]);

    if (!hasOwn(notes, newKeyString) || !asTrimmedString(notes[newKeyString])) {
        setOwn(notes, newKeyString, note);
    }

    delete notes[oldKeyString];

    if (Object.keys(notes).length === 0) {
        delete powerUser.character_tag_notes;
    }

    return true;
}

/**
 * Removes organiser notes for characters and groups that no longer exist.
 *
 * @param {object} powerUser Power user settings
 * @param {Iterable<string|number>} validEntityKeys Existing character avatars and group ids
 * @returns {number} Number of notes removed
 */
export function pruneEntityOrganizerNotes(powerUser, validEntityKeys) {
    const notes = getEntityNotesBucket(powerUser);
    if (!notes) {
        return 0;
    }

    const valid = new Set(Array.from(validEntityKeys ?? [], key => String(key)));
    let removed = 0;

    for (const key of Object.keys(notes)) {
        if (!valid.has(key)) {
            delete notes[key];
            removed++;
        }
    }

    if (removed > 0 && Object.keys(notes).length === 0) {
        delete powerUser.character_tag_notes;
    }

    return removed;
}

/**
 * Builds the JSON backup written by the manager. Tag notes live on the tag objects; the
 * character and group notes are a separate map.
 *
 * @param {object} options Backup source
 * @param {Tag[]} [options.tags] Tags
 * @param {Record<string, string[]>} [options.tagMap] Tag assignments
 * @param {object} [options.powerUser] Power user settings
 * @returns {{tags: Tag[], tag_map: Record<string, string[]>, character_tag_notes: Record<string, string>}}
 */
export function buildTagManagerBackupPayload({ tags = [], tagMap = {}, powerUser = null } = {}) {
    const notes = getEntityNotesBucket(powerUser);

    return {
        tags: clonePlain(Array.isArray(tags) ? tags : []),
        tag_map: clonePlain(isPlainObject(tagMap) ? tagMap : {}),
        character_tag_notes: clonePlain(notes ?? {}),
    };
}

/**
 * Resolves a character, group or tag key without touching settings. Explicit wrappers win,
 * numbers are character indices first, and strings are avatars first, then group ids, then
 * string character indices. That keeps numeric group ids from hijacking character indices.
 *
 * @param {object|number|string} entityOrKey Entity wrapper, entity object, index, id or key
 * @param {object} options Lookup data
 * @param {object[]} [options.characters] Characters
 * @param {object[]} [options.groups] Groups
 * @param {Record<string, string[]>} [options.tagMap] Existing keys
 * @returns {string|undefined} Resolved key
 */
export function resolveTagKeyForEntity(entityOrKey, { characters = [], groups = [], tagMap = null } = {}) {
    const characterList = Array.isArray(characters) ? characters : [];
    const groupList = Array.isArray(groups) ? groups : [];
    const map = isPlainObject(tagMap) ? tagMap : null;
    const hasMapKey = key => key !== undefined && key !== null && map !== null && Object.hasOwn(map, String(key));

    const resolveCharacter = candidate => {
        const item = candidate?.item ?? candidate;
        if (!item || typeof item !== 'object' || typeof item.avatar !== 'string' || !item.avatar) {
            return undefined;
        }

        const known = characterList.includes(item)
            || characterList.some(character => String(character.avatar) === String(item.avatar))
            || hasMapKey(item.avatar);
        return known ? String(item.avatar) : undefined;
    };

    const resolveGroup = candidate => {
        const item = candidate?.item ?? candidate;
        if (!item || typeof item !== 'object' || item.id === undefined || item.id === null) {
            return undefined;
        }

        const known = groupList.includes(item)
            || groupList.some(group => String(group.id) === String(item.id))
            || hasMapKey(item.id);
        return known ? String(item.id) : undefined;
    };

    if (typeof entityOrKey === 'object' && entityOrKey !== null) {
        if (entityOrKey.type === 'tag') {
            return hasMapKey(entityOrKey.id) ? String(entityOrKey.id) : undefined;
        }

        if (entityOrKey.type === 'character') {
            const wrapperKey = resolveCharacter(entityOrKey);
            if (wrapperKey) {
                return wrapperKey;
            }
            const indexedCharacter = entityOrKey.id !== undefined ? characterList[entityOrKey.id] : undefined;
            return indexedCharacter ? String(indexedCharacter.avatar) : undefined;
        }

        if (entityOrKey.type === 'group') {
            const wrapperKey = resolveGroup(entityOrKey);
            if (wrapperKey) {
                return wrapperKey;
            }
            return hasMapKey(entityOrKey.id) ? String(entityOrKey.id) : undefined;
        }

        if ('avatar' in entityOrKey) {
            const characterKey = resolveCharacter(entityOrKey);
            if (characterKey) {
                return characterKey;
            }
        }

        if (groupList.includes(entityOrKey)) {
            const groupKey = resolveGroup(entityOrKey);
            if (groupKey) {
                return groupKey;
            }
        }

        if (entityOrKey.id !== undefined && entityOrKey.id !== null) {
            if (groupList.some(group => String(group.id) === String(entityOrKey.id))) {
                return String(entityOrKey.id);
            }

            const indexedCharacter = characterList[entityOrKey.id];
            if (indexedCharacter) {
                return String(indexedCharacter.avatar);
            }

            if (hasMapKey(entityOrKey.id)) {
                return String(entityOrKey.id);
            }
        }

        return undefined;
    }

    if (typeof entityOrKey === 'number') {
        const character = characterList[entityOrKey];
        if (character) {
            return String(character.avatar);
        }

        const group = groupList.find(item => String(item.id) === String(entityOrKey));
        if (group) {
            return String(group.id);
        }

        return hasMapKey(entityOrKey) ? String(entityOrKey) : undefined;
    }

    if (typeof entityOrKey === 'string') {
        const character = characterList.find(item => String(item.avatar) === entityOrKey);
        if (character) {
            return String(character.avatar);
        }

        const group = groupList.find(item => String(item.id) === entityOrKey);
        if (group) {
            return String(group.id);
        }

        const indexedCharacter = characterList[entityOrKey];
        if (indexedCharacter) {
            return String(indexedCharacter.avatar);
        }

        return hasMapKey(entityOrKey) ? entityOrKey : undefined;
    }

    return undefined;
}

function buildEntityLookup(characters, groups) {
    const lookup = new Map();

    for (const character of Array.isArray(characters) ? characters : []) {
        if (character?.avatar === undefined || character.avatar === null) {
            continue;
        }
        lookup.set(String(character.avatar), {
            key: String(character.avatar),
            name: String(character.name ?? ''),
            type: 'character',
        });
    }

    for (const group of Array.isArray(groups) ? groups : []) {
        if (group?.id === undefined || group.id === null) {
            continue;
        }
        lookup.set(String(group.id), {
            key: String(group.id),
            name: String(group.name ?? ''),
            type: 'group',
        });
    }

    return lookup;
}

function buildAssignedEntitiesByTag(tags, tagMap, characters, groups) {
    const lookup = buildEntityLookup(characters, groups);
    const assigned = new Map(tags.map(tag => [String(tag.id), []]));

    for (const [entityKey, tagIds] of Object.entries(isPlainObject(tagMap) ? tagMap : {})) {
        const entity = lookup.get(String(entityKey));
        if (!entity || !Array.isArray(tagIds)) {
            continue;
        }

        for (const tagId of new Set(tagIds.map(id => String(id)))) {
            assigned.get(tagId)?.push(entity);
        }
    }

    return assigned;
}

function matchesTagTerm(record, term) {
    let haystack;

    if (term.prefix === 'c') {
        haystack = record.entities.map(entity => entity.name).join('\n');
    } else {
        haystack = `${record.tag.name ?? ''}\n${getTagNoteValue(record.tag)}`;
    }

    const result = contains(haystack, term.value.toLowerCase());
    return term.negated ? !result : result;
}

function compareTagNames(a, b) {
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
}

function compareManualOrder(a, b) {
    const aOrder = Number(a.sort_order);
    const bOrder = Number(b.sort_order);
    const aHasOrder = Number.isFinite(aOrder);
    const bHasOrder = Number.isFinite(bOrder);

    if (aHasOrder && bHasOrder) {
        return (aOrder - bOrder) || compareTagNames(a, b);
    }
    if (aHasOrder) {
        return -1;
    }
    if (bHasOrder) {
        return 1;
    }
    return 0;
}

/**
 * Filters and sorts tag records for the Tags & Folders tab.
 *
 * @param {Tag[]} tags Tags
 * @param {Record<string, string[]>} tagMap Assignments
 * @param {object[]} characters Characters
 * @param {object[]} groups Groups
 * @param {object} [options] Query and sort options
 * @param {string} [options.query] Search text
 * @param {string} [options.filter] One of TAG_FILTER_MODES
 * @param {string} [options.sortMode] One of TAG_SORT_MODES
 * @param {(a: Tag, b: Tag) => number} [options.compareFallback] Extra comparator for manual sorting
 * @returns {Array<{tag: Tag, count: number, entities: Array<{key: string, name: string, type: string}>}>}
 */
export function filterAndSortTagRecords(tags, tagMap, characters, groups, {
    query = '',
    filter = TAG_FILTER_MODES.ALL,
    sortMode = TAG_SORT_MODES.MANUAL,
    compareFallback = null,
} = {}) {
    const tagList = Array.isArray(tags) ? tags : [];
    const assigned = buildAssignedEntitiesByTag(tagList, tagMap, characters, groups);
    const parsedQuery = parseTagSearchQuery(query);
    const fallback = typeof compareFallback === 'function' ? compareFallback : null;

    let records = tagList.map(tag => {
        const entities = assigned.get(String(tag.id)) ?? [];
        return { tag, count: entities.length, entities };
    });

    records = records.filter(record => {
        const folderType = record.tag.folder_type;

        switch (filter) {
            case TAG_FILTER_MODES.FOLDERS:
                return FOLDER_TYPES.has(folderType);
            case TAG_FILTER_MODES.OPEN_FOLDER:
                return folderType === 'OPEN';
            case TAG_FILTER_MODES.CLOSED_FOLDER:
                return folderType === 'CLOSED';
            case TAG_FILTER_MODES.NO_FOLDER:
                return !folderType || folderType === 'NONE';
            case TAG_FILTER_MODES.UNUSED:
                return record.count === 0;
            case TAG_FILTER_MODES.WITH_NOTES:
                return Boolean(getTagNoteValue(record.tag));
            default:
                return true;
        }
    });

    if (parsedQuery.groups.length > 0) {
        records = records.filter(record => parsedQuery.groups.some(group => group.every(term => matchesTagTerm(record, term))));
    }

    const fallbackCompare = (a, b) => {
        if (fallback) {
            const result = fallback(a.tag, b.tag);
            if (result !== 0) {
                return result;
            }
        }
        return compareTagNames(a.tag, b.tag);
    };

    records.sort((a, b) => {
        switch (sortMode) {
            case TAG_SORT_MODES.ALPHABETICAL:
                return compareTagNames(a.tag, b.tag);
            case TAG_SORT_MODES.ALPHABETICAL_DESC:
                return compareTagNames(b.tag, a.tag);
            case TAG_SORT_MODES.BY_ENTRIES:
                return (b.count - a.count) || fallbackCompare(a, b);
            case TAG_SORT_MODES.BY_ENTRIES_ASC:
                return (a.count - b.count) || fallbackCompare(a, b);
            case TAG_SORT_MODES.MANUAL:
            default:
                return compareManualOrder(a.tag, b.tag) || fallbackCompare(a, b);
        }
    });

    return records;
}

function collectText(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string').join('\n');
    }
    return '';
}

function buildEntityHaystack(entity, assignedTags, note) {
    const allText = collectText(entity.allText);
    const textFields = allText
        ? [allText]
        : [
            entity.description,
            entity.personality,
            entity.scenario,
            entity.first_mes,
            entity.firstMessage,
            entity.creator_notes,
            entity.creatorNotes,
        ];

    return [
        ...textFields,
        entity.name,
        note,
        ...assignedTags.map(tag => tag.name),
    ].map(collectText).filter(Boolean).join('\n').toLowerCase();
}

function entityMatchesTerm(entity, term) {
    let result;

    switch (term.prefix) {
        case 't':
            result = entity.assignedTags.some(tag => contains(tag.name, term.value.toLowerCase()));
            break;
        case 'f':
            result = entity.folderTags.some(tag => contains(tag.name, term.value.toLowerCase()));
            break;
        case 'a':
            result = entity.allText.includes(term.value.toLowerCase());
            break;
        case 'n':
            result = contains(entity.note, term.value.toLowerCase());
            break;
        default:
            result = contains(entity.name, term.value.toLowerCase());
            break;
    }

    return term.negated ? !result : result;
}

function compareEntityNames(a, b) {
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
}

/**
 * Filters and sorts characters and groups for the Characters & Groups tab.
 *
 * @param {object[]} entities Normalized entities from the manager (`key`, `name`, `type`, `fav`, and optional card text)
 * @param {Tag[]} tags Tags
 * @param {Record<string, string[]>} tagMap Assignments
 * @param {Record<string, string>} charNotes Organiser notes by entity key
 * @param {object} [options] Query and sort options
 * @param {string} [options.query] Search text
 * @param {string} [options.filter] One of ENTITY_FILTER_MODES
 * @param {string} [options.sortMode] One of ENTITY_SORT_MODES
 * @returns {object[]} Enriched entity records
 */
export function filterAndSortEntities(entities, tags, tagMap, charNotes, {
    query = '',
    filter = ENTITY_FILTER_MODES.ALL,
    sortMode = ENTITY_SORT_MODES.ALPHA_ASC,
} = {}) {
    const tagById = new Map((Array.isArray(tags) ? tags : []).map(tag => [String(tag.id), tag]));
    const notes = isPlainObject(charNotes) ? charNotes : {};
    const parsedQuery = parseEntitySearchQuery(query);

    let records = (Array.isArray(entities) ? entities : []).map(entity => {
        const key = String(entity.key);
        const rawTagIds = isPlainObject(tagMap) && Array.isArray(tagMap[key]) ? tagMap[key] : [];
        const tagIds = [...new Set(rawTagIds.map(id => String(id)))].filter(id => tagById.has(id));
        const assignedTags = tagIds.map(id => tagById.get(id));
        const note = hasOwn(notes, key) ? asTrimmedString(notes[key]) : '';

        return {
            ...entity,
            key,
            name: String(entity.name ?? ''),
            fav: entity.fav === true || entity.fav === 'true',
            note,
            tagIds,
            assignedTags,
            folderTags: assignedTags.filter(tag => FOLDER_TYPES.has(tag.folder_type)),
            allText: buildEntityHaystack(entity, assignedTags, note),
        };
    });

    records = records.filter(record => {
        switch (filter) {
            case ENTITY_FILTER_MODES.CHARACTERS:
                return record.type === 'character';
            case ENTITY_FILTER_MODES.GROUPS:
                return record.type === 'group';
            case ENTITY_FILTER_MODES.UNTAGGED:
                return record.tagIds.length === 0;
            case ENTITY_FILTER_MODES.TAGGED:
                return record.tagIds.length > 0;
            case ENTITY_FILTER_MODES.IN_FOLDER:
                return record.folderTags.length > 0;
            case ENTITY_FILTER_MODES.NO_FOLDER:
                return record.folderTags.length === 0;
            case ENTITY_FILTER_MODES.WITH_NOTES:
                return Boolean(record.note);
            case ENTITY_FILTER_MODES.WITHOUT_NOTES:
                return !record.note;
            case ENTITY_FILTER_MODES.FAVORITES:
                return record.fav;
            default:
                return true;
        }
    });

    if (parsedQuery.groups.length > 0) {
        records = records.filter(record => parsedQuery.groups.some(group => group.every(term => entityMatchesTerm(record, term))));
    }

    records.sort((a, b) => {
        switch (sortMode) {
            case ENTITY_SORT_MODES.ALPHA_DESC:
                return compareEntityNames(b, a) || (b.tagIds.length - a.tagIds.length);
            case ENTITY_SORT_MODES.TAG_COUNT_DESC:
                return (b.tagIds.length - a.tagIds.length) || compareEntityNames(a, b);
            case ENTITY_SORT_MODES.TAG_COUNT_ASC:
                return (a.tagIds.length - b.tagIds.length) || compareEntityNames(a, b);
            case ENTITY_SORT_MODES.ALPHA_ASC:
            default:
                return compareEntityNames(a, b) || (a.tagIds.length - b.tagIds.length);
        }
    });

    return records;
}

/**
 * Applies a drag result to a full manual order. Visible tags take the display slots they
 * already occupied, so a filtered drag never disturbs hidden tags and every tag gets a
 * numeric sort order.
 *
 * @param {object} options Drag data
 * @param {Tag[]} options.tags All tags
 * @param {Tag[]} [options.orderedTags] Tags in their current display order before the drag
 * @param {Iterable<string>} [options.visibleTagIds] Tag ids in their new displayed order
 * @returns {Tag[]} The new full order
 */
export function applyTagDragOrder({ tags = [], orderedTags = null, visibleTagIds = [] } = {}) {
    const tagList = Array.isArray(tags) ? tags : [];
    const ordered = Array.isArray(orderedTags) ? orderedTags : tagList.slice();
    const nextOrder = ordered.slice();
    const visibleIds = uniqueStrings(visibleTagIds);
    const targetIndices = visibleIds
        .map(id => ordered.findIndex(tag => String(tag.id) === id))
        .filter(index => index >= 0)
        .sort((a, b) => a - b);

    targetIndices.forEach((slotIndex, index) => {
        const movedTag = tagList.find(tag => String(tag.id) === visibleIds[index]);
        if (movedTag) {
            nextOrder[slotIndex] = movedTag;
        }
    });

    nextOrder.forEach((tag, index) => {
        tag.sort_order = index;
    });

    if (Array.isArray(orderedTags)) {
        orderedTags.splice(0, orderedTags.length, ...nextOrder);
    }

    return nextOrder;
}

/**
 * Imports tags and tag assignments from a backup without creating duplicate ids.
 *
 * The import is deliberately defensive: invalid entries are skipped with a warning, all
 * live assignments are remapped when an overwritten tag changes id, and existing tag maps
 * are filtered back to tags that exist afterwards.
 *
 * @param {object} options Restore data
 * @param {object} options.data Parsed backup
 * @param {Tag[]} options.tags Live tags (mutated)
 * @param {Record<string, string[]>} options.tagMap Live assignments (mutated)
 * @param {object[]} options.characters Characters
 * @param {object[]} options.groups Groups
 * @param {boolean} [options.overwrite] Replace existing tags matched by id or name
 * @returns {{warnings: string[], importedTags: number, replacedTags: number, remappedAssignments: number, importedMapKeys: number}}
 */
export function restoreTagsFromBackup({ data = null, tags = [], tagMap = {}, characters = [], groups = [], overwrite = false } = {}) {
    const result = {
        warnings: [],
        importedTags: 0,
        replacedTags: 0,
        remappedAssignments: 0,
        importedMapKeys: 0,
    };

    if (!isPlainObject(data) || !Array.isArray(data.tags)) {
        result.warnings.push('The file has no tag list.');
        return result;
    }

    const tagList = Array.isArray(tags) ? tags : [];
    const map = isPlainObject(tagMap) ? tagMap : {};
    const entityKeys = new Set([
        ...(Array.isArray(characters) ? characters : []).map(character => String(character?.avatar)),
        ...(Array.isArray(groups) ? groups : []).map(group => String(group?.id)),
    ]);
    const idMap = new Map();
    const nameKey = value => String(value ?? '').trim().toLowerCase();
    const findById = id => tagList.find(tag => String(tag.id) === String(id));
    const findByName = name => tagList.find(tag => nameKey(tag.name) === nameKey(name));

    for (const rawTag of data.tags) {
        if (!rawTag || typeof rawTag !== 'object' || Array.isArray(rawTag)) {
            result.warnings.push(`Tag entry is invalid: ${JSON.stringify(rawTag)}.`);
            continue;
        }

        const id = rawTag.id;
        const name = typeof rawTag.name === 'string' ? rawTag.name.trim() : '';

        if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim() || !name) {
            result.warnings.push(`Tag entry is invalid: ${JSON.stringify(rawTag)}.`);
            continue;
        }

        const importedTag = { ...rawTag, name };
        setTagNote(importedTag, rawTag.note);

        if (!overwrite) {
            const existing = findById(id) ?? findByName(name);
            if (existing) {
                if (!getTagNote(existing) && getTagNote(importedTag)) {
                    setTagNote(existing, importedTag.note);
                }
                idMap.set(String(id), existing.id);
                continue;
            }

            tagList.push(importedTag);
            idMap.set(String(id), importedTag.id);
            result.importedTags++;
            continue;
        }

        const removed = [];
        for (let index = tagList.length - 1; index >= 0; index--) {
            const current = tagList[index];
            if (String(current.id) === String(id) || nameKey(current.name) === nameKey(name)) {
                removed.push(current);
                tagList.splice(index, 1);
            }
        }

        for (const previous of removed) {
            if (String(previous.id) !== String(importedTag.id)) {
                idMap.set(String(previous.id), importedTag.id);
            }
        }

        tagList.push(importedTag);
        idMap.set(String(id), importedTag.id);
        result.replacedTags += removed.length;
        result.importedTags++;
    }

    if (idMap.size > 0) {
        for (const key of Object.keys(map)) {
            if (!Array.isArray(map[key])) {
                continue;
            }

            let changed = false;
            const remapped = [];
            const seen = new Set();

            for (const id of map[key]) {
                const nextId = idMap.get(String(id)) ?? id;
                if (String(nextId) !== String(id)) {
                    changed = true;
                }
                if (!seen.has(String(nextId))) {
                    seen.add(String(nextId));
                    remapped.push(nextId);
                } else {
                    changed = true;
                }
            }

            if (changed) {
                map[key] = remapped;
                result.remappedAssignments++;
            }
        }
    }

    for (const key of Object.keys(isPlainObject(data.tag_map) ? data.tag_map : {})) {
        if (!entityKeys.has(String(key))) {
            result.warnings.push(`Tag map key ${key} does not exist as character or group.`);
            continue;
        }

        const tagIds = data.tag_map[key];
        if (!Array.isArray(tagIds)) {
            result.warnings.push(`Tag map for key ${key} is invalid: ${JSON.stringify(tagIds)}.`);
            continue;
        }

        const existing = Array.isArray(map[key]) ? map[key] : [];
        const combined = [];
        const seen = new Set();

        for (const id of [...existing, ...tagIds.map(tagId => idMap.get(String(tagId)) ?? tagId)]) {
            if (!seen.has(String(id))) {
                seen.add(String(id));
                combined.push(id);
            }
        }

        map[key] = combined.filter(id => tagList.some(tag => String(tag.id) === String(id)));
        result.importedMapKeys++;
    }

    return result;
}

/**
 * Captures everything needed to undo a tag deletion or merge. Only the affected tags and
 * tag map entries are copied, so unrelated changes made afterwards survive an undo.
 *
 * @param {object} options Snapshot source
 * @param {Tag[]} options.tags Tags
 * @param {Record<string, string[]>} options.tagMap Assignments
 * @param {Iterable<string>} options.tagIds Affected tag ids
 * @returns {object} Snapshot
 */
export function createTagDeletionSnapshot({ tags = [], tagMap = {}, tagIds = [] } = {}) {
    const affectedTagIds = [...new Set(Array.from(tagIds ?? [], id => String(id)))];
    const affected = new Set(affectedTagIds);
    const tagEntries = [];

    (Array.isArray(tags) ? tags : []).forEach((tag, index) => {
        if (affected.has(String(tag.id))) {
            tagEntries.push({ index, tag: clonePlain(tag) });
        }
    });

    const mapEntries = {};
    const mapKeys = [];

    for (const [key, ids] of Object.entries(isPlainObject(tagMap) ? tagMap : {})) {
        if (!Array.isArray(ids) || !ids.some(id => affected.has(String(id)))) {
            continue;
        }
        setOwn(mapEntries, key, clonePlain(ids));
        mapKeys.push(key);
    }

    return {
        tagIds: affectedTagIds,
        tags: tagEntries,
        tagMap: mapEntries,
        tagMapKeys: mapKeys,
        addedTagIdsByKey: {},
        orphanTagMapEntries: {},
        characterTagNotes: {},
        operation: 'delete',
        primaryTagId: null,
    };
}

function uniqueStrings(values) {
    return [...new Set(Array.from(values ?? [], value => String(value)))];
}

/**
 * Restores a snapshot made by `createTagDeletionSnapshot`.
 *
 * @param {object} options Restore target
 * @param {Tag[]} options.tags Tags
 * @param {Record<string, string[]>} options.tagMap Assignments
 * @param {object} options.snapshot Snapshot
 * @param {object} [options.powerUser] Power user settings for pruned organiser notes
 * @returns {{restoredTags: number, restoredAssignments: number, restoredNotes: number}}
 */
export function restoreTagDeletionSnapshot({ tags = [], tagMap = {}, snapshot = null, powerUser = null } = {}) {
    if (!snapshot || !Array.isArray(tags) || !isPlainObject(tagMap)) {
        return { restoredTags: 0, restoredAssignments: 0, restoredNotes: 0 };
    }

    const affected = new Set(uniqueStrings(snapshot.tagIds));
    const isMerge = snapshot.operation === 'merge';
    const primaryTagId = isMerge && snapshot.primaryTagId !== undefined && snapshot.primaryTagId !== null
        ? String(snapshot.primaryTagId)
        : null;
    let restoredTags = 0;

    const entries = [...(snapshot.tags ?? [])].sort((a, b) => Number(a.index) - Number(b.index));
    for (const entry of entries) {
        const tag = entry?.tag;
        if (!tag || tag.id === undefined) {
            continue;
        }

        const tagId = String(tag.id);
        const existingIndex = tags.findIndex(item => String(item.id) === tagId);

        if (isMerge && primaryTagId !== null && tagId === primaryTagId) {
            // The primary tag was never deleted by a merge. Undo restores its note, but
            // leaves later name, colour and folder edits alone.
            if (existingIndex !== -1) {
                setTagNote(tags[existingIndex], tag.note ?? '');
            }
            continue;
        }

        if (existingIndex !== -1) {
            // A deleted tag that already exists again keeps its current identity, but the
            // snapshot properties are put back so a half-restored tag cannot linger.
            const current = tags[existingIndex];
            for (const key of Object.keys(current)) {
                if (!Object.hasOwn(tag, key)) {
                    delete current[key];
                }
            }
            Object.assign(current, clonePlain(tag));
            restoredTags++;
            continue;
        }

        const index = Math.min(Math.max(Number(entry.index) || 0, 0), tags.length);
        tags.splice(index, 0, clonePlain(tag));
        restoredTags++;
    }

    let restoredAssignments = 0;

    for (const key of uniqueStrings(Object.keys(snapshot.tagMap ?? {}))) {
        const original = Array.isArray(snapshot.tagMap[key]) ? snapshot.tagMap[key] : [];
        const added = new Set(uniqueStrings(snapshot.addedTagIdsByKey?.[key] ?? []));
        const current = Array.isArray(tagMap[key]) ? tagMap[key] : [];

        // A deletion restores the deleted tags. A merge restores only the merged source
        // tags; the primary tag stays wherever the user left it after the merge.
        const restoreIds = original.filter(id => {
            if (!affected.has(String(id))) {
                return false;
            }
            return !(isMerge && primaryTagId !== null && String(id) === primaryTagId);
        });

        // Remove primary assignments the merge itself introduced, but never resurrect
        // unrelated tags the user removed after the snapshot was taken.
        const restored = current.filter(id => !added.has(String(id)));

        for (const id of restoreIds) {
            if (!restored.some(currentId => String(currentId) === String(id))) {
                restored.push(id);
                restoredAssignments++;
            }
        }

        if (restored.length !== current.length || restored.some((id, index) => String(id) !== String(current[index]))) {
            tagMap[key] = restored;
        }
    }

    for (const key of uniqueStrings(Object.keys(snapshot.orphanTagMapEntries ?? {}))) {
        if (Object.hasOwn(tagMap, key)) {
            continue;
        }
        tagMap[key] = clonePlain(snapshot.orphanTagMapEntries[key]);
        restoredAssignments++;
    }

    let restoredNotes = 0;

    for (const key of uniqueStrings(Object.keys(snapshot.characterTagNotes ?? {}))) {
        if (!powerUser) {
            break;
        }
        if (setEntityOrganizerNote(powerUser, key, snapshot.characterTagNotes[key])) {
            restoredNotes++;
        }
    }

    return { restoredTags, restoredAssignments, restoredNotes };
}

/**
 * Merges one or more source tags into a primary tag, moving every assignment and keeping
 * the notes of both tags. The primary tag is never removed.
 *
 * @param {object} options Merge source
 * @param {Tag[]} options.tags Tags
 * @param {Record<string, string[]>} options.tagMap Assignments
 * @param {string} options.primaryTagId Tag to keep
 * @param {Iterable<string>} options.sourceTagIds Tags to merge into the primary
 * @returns {{mergedCount: number, affectedEntities: number, snapshot: object|null}}
 */
export function mergeTagsIntoPrimary({ tags = [], tagMap = {}, primaryTagId = null, sourceTagIds = [] } = {}) {
    const tagList = Array.isArray(tags) ? tags : [];
    const primary = tagList.find(tag => String(tag.id) === String(primaryTagId));

    if (!primary) {
        return { mergedCount: 0, affectedEntities: 0, snapshot: null };
    }

    const sourceIds = uniqueStrings(sourceTagIds).filter(id => id !== String(primary.id));
    const sources = sourceIds
        .map(id => tagList.find(tag => String(tag.id) === id))
        .filter(Boolean);

    if (sources.length === 0) {
        return { mergedCount: 0, affectedEntities: 0, snapshot: null };
    }

    const snapshot = createTagDeletionSnapshot({
        tags: tagList,
        tagMap,
        tagIds: [String(primary.id), ...sources.map(tag => String(tag.id))],
    });

    const sourceIdSet = new Set(sources.map(tag => String(tag.id)));
    const addedTagIdsByKey = {};
    let affectedEntities = 0;

    for (const key of Object.keys(isPlainObject(tagMap) ? tagMap : {})) {
        const ids = tagMap[key];
        if (!Array.isArray(ids) || !ids.some(id => sourceIdSet.has(String(id)))) {
            continue;
        }

        const original = ids.map(id => String(id));
        const hadPrimary = original.includes(String(primary.id));
        const next = original.filter(id => !sourceIdSet.has(String(id)));

        if (!hadPrimary) {
            next.push(String(primary.id));
            setOwn(addedTagIdsByKey, key, [String(primary.id)]);
        }

        tagMap[key] = [...new Set(next)];
        affectedEntities++;
    }

    const mergedNotes = [];
    const addNote = note => {
        if (note && !mergedNotes.some(existing => existing.toLowerCase() === note.toLowerCase())) {
            mergedNotes.push(note);
        }
    };

    addNote(getTagNoteValue(primary));
    for (const source of sources) {
        addNote(getTagNoteValue(source));
    }
    setTagNote(primary, mergedNotes.join('\n'));

    for (const source of sources) {
        const index = tagList.indexOf(source);
        if (index !== -1) {
            tagList.splice(index, 1);
        }
    }

    snapshot.addedTagIdsByKey = addedTagIdsByKey;
    snapshot.operation = 'merge';
    snapshot.primaryTagId = String(primary.id);

    return { mergedCount: sources.length, affectedEntities, snapshot };
}

/**
 * Adds one or more tags to a set of character and group keys.
 *
 * @param {object} options Assign source
 * @param {Record<string, string[]>} options.tagMap Assignments
 * @param {Iterable<string>} options.tagIds Tags to add
 * @param {Iterable<string>} options.entityKeys Entity keys
 * @returns {{entityCount: number, assignmentCount: number}}
 */
export function bulkAssignTagsToEntities({ tagMap = {}, tagIds = [], entityKeys = [] } = {}) {
    const keys = uniqueStrings(entityKeys);
    const ids = uniqueStrings(tagIds);
    let entityCount = 0;
    let assignmentCount = 0;

    if (!isPlainObject(tagMap) || keys.length === 0 || ids.length === 0) {
        return { entityCount, assignmentCount };
    }

    for (const key of keys) {
        const current = Array.isArray(tagMap[key]) ? tagMap[key] : [];
        const next = [...current];
        let added = 0;

        for (const id of ids) {
            if (!next.some(currentId => String(currentId) === id)) {
                next.push(id);
                added++;
            }
        }

        if (added > 0 || !Array.isArray(tagMap[key])) {
            tagMap[key] = next;
            entityCount++;
            assignmentCount += added;
        }
    }

    return { entityCount, assignmentCount };
}

/**
 * Removes one or more tags from a set of character and group keys.
 *
 * @param {object} options Remove source
 * @param {Record<string, string[]>} options.tagMap Assignments
 * @param {Iterable<string>} options.tagIds Tags to remove
 * @param {Iterable<string>} options.entityKeys Entity keys
 * @returns {{entityCount: number, assignmentCount: number}}
 */
export function bulkRemoveTagsFromEntities({ tagMap = {}, tagIds = [], entityKeys = [] } = {}) {
    const keys = uniqueStrings(entityKeys);
    const ids = new Set(uniqueStrings(tagIds));
    let entityCount = 0;
    let assignmentCount = 0;

    if (!isPlainObject(tagMap) || keys.length === 0 || ids.size === 0) {
        return { entityCount, assignmentCount };
    }

    for (const key of keys) {
        if (!Array.isArray(tagMap[key])) {
            continue;
        }

        const current = tagMap[key];
        const next = current.filter(id => !ids.has(String(id)));
        const removed = current.length - next.length;

        if (removed > 0) {
            tagMap[key] = next;
            entityCount++;
            assignmentCount += removed;
        }
    }

    return { entityCount, assignmentCount };
}

function resolveEntityKeyForNotes(importKey, characters, groups) {
    const key = String(importKey ?? '');
    if (!key) {
        return null;
    }

    const character = Array.isArray(characters) ? characters : [];
    const group = Array.isArray(groups) ? groups : [];
    const lowerKey = key.toLowerCase();

    const exactCharacter = character.find(item => String(item?.avatar ?? '') === key);
    if (exactCharacter?.avatar !== undefined) {
        return String(exactCharacter.avatar);
    }

    const exactGroup = group.find(item => String(item?.id ?? '') === key);
    if (exactGroup?.id !== undefined) {
        return String(exactGroup.id);
    }

    const basename = lowerKey.replace(/\.(?:png|webp|jpe?g|gif|avif)$/i, '');
    if (basename !== lowerKey) {
        const basenameMatch = character.find(item => String(item?.avatar ?? '').replace(/\.(?:png|webp|jpe?g|gif|avif)$/i, '').toLowerCase() === basename);
        if (basenameMatch?.avatar !== undefined) {
            return String(basenameMatch.avatar);
        }
    }

    const characterNameMatch = character.find(item => String(item?.name ?? '').toLowerCase() === lowerKey);
    if (characterNameMatch?.avatar !== undefined) {
        return String(characterNameMatch.avatar);
    }

    const groupNameMatch = group.find(item => String(item?.name ?? '').toLowerCase() === lowerKey);
    return groupNameMatch?.id !== undefined ? String(groupNameMatch.id) : null;
}

function copyImportedNote({ targetKey, note, currentNote, overwrite, powerUser }) {
    if (!note) {
        return false;
    }

    if (!overwrite && asTrimmedString(currentNote)) {
        return false;
    }

    return setEntityOrganizerNote(powerUser, targetKey, note);
}

/**
 * Imports notes from this manager's backup shape or from a Character Tag Manager notes
 * export (`{ tagNotes, charNotes }`). Character notes match by avatar key, avatar
 * basename, or name; tag notes match by id first, then by tag name.
 *
 * @param {object} options Import source
 * @param {object} options.payload Parsed JSON
 * @param {Tag[]} options.tags Tags
 * @param {object[]} options.characters Characters
 * @param {object[]} options.groups Groups
 * @param {object} options.powerUser Power user settings
 * @param {boolean} [options.overwrite] Replace notes that already exist
 * @returns {{importedTagNotes: number, importedEntityNotes: number, skipped: string[]}}
 */
export function applyNotesImportPayload({ payload, tags = [], characters = [], groups = [], powerUser = null, overwrite = false }) {
    const result = { importedTagNotes: 0, importedEntityNotes: 0, skipped: [] };
    const tagList = Array.isArray(tags) ? tags : [];

    if (!isPlainObject(payload) || !powerUser) {
        return result;
    }

    const tagNotes = isPlainObject(payload.tagNotes) ? payload.tagNotes : {};

    for (const [key, rawNote] of Object.entries(tagNotes)) {
        const note = asTrimmedString(rawNote);
        if (!note) {
            continue;
        }

        const tag = tagList.find(item => String(item.id) === String(key))
            ?? tagList.find(item => String(item.name ?? '').toLowerCase() === String(key).toLowerCase());

        if (!tag) {
            result.skipped.push(`Tag note for unknown tag '${key}'.`);
            continue;
        }

        if (!overwrite && getTagNoteValue(tag)) {
            continue;
        }

        if (setTagNote(tag, note)) {
            result.importedTagNotes++;
        }
    }

    const charNotes = isPlainObject(payload.charNotes) ? payload.charNotes : {};

    for (const [key, rawNote] of Object.entries(charNotes)) {
        const note = asTrimmedString(rawNote);
        if (!note) {
            continue;
        }

        const targetKey = resolveEntityKeyForNotes(key, characters, groups);
        if (!targetKey) {
            result.skipped.push(`Character note for unknown character or group '${key}'.`);
            continue;
        }

        if (copyImportedNote({
            targetKey,
            note,
            currentNote: getEntityOrganizerNote(powerUser, targetKey),
            overwrite,
            powerUser,
        })) {
            result.importedEntityNotes++;
        }
    }

    const directEntityNotes = isPlainObject(payload.character_tag_notes) ? payload.character_tag_notes : {};

    for (const [key, rawNote] of Object.entries(directEntityNotes)) {
        const note = asTrimmedString(rawNote);
        if (!note) {
            continue;
        }

        const targetKey = resolveEntityKeyForNotes(key, characters, groups);
        if (!targetKey) {
            result.skipped.push(`Organiser note for unknown character or group '${key}'.`);
            continue;
        }

        if (copyImportedNote({
            targetKey,
            note,
            currentNote: getEntityOrganizerNote(powerUser, targetKey),
            overwrite,
            powerUser,
        })) {
            result.importedEntityNotes++;
        }
    }

    return result;
}
