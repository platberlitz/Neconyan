/**
 * Validation, real-model defaults and plain-word labels for Scratchpad lorebook
 * activation settings. Kept free of core/DOM imports so both browser modules
 * and tests can load it cleanly.
 */

export const LOREBOOK_POSITIONS = Object.freeze({
    0: 'Before Char Defs',
    1: 'After Char Defs',
    2: 'Before AN',
    3: 'After AN',
    4: 'At Depth',
    5: 'Before EM',
    6: 'After EM',
    7: 'Outlet',
});

export const LOREBOOK_ROLES = Object.freeze({
    0: 'System',
    1: 'User',
    2: 'Assistant',
});

export const LOREBOOK_SELECTIVE_LOGIC = Object.freeze({
    0: 'AND ANY',
    1: 'NOT ALL',
    2: 'NOT ANY',
    3: 'AND ALL',
});

export const LOREBOOK_ACTIVATION_FIELDS = Object.freeze([
    'keys',
    'keysecondary',
    'selective',
    'selectiveLogic',
    'constant',
    'probability',
    'useProbability',
    'order',
    'position',
    'role',
    'outletName',
    'depth',
    'scanDepth',
    'caseSensitive',
    'matchWholeWords',
    'excludeRecursion',
    'preventRecursion',
    'delayUntilRecursion',
    'group',
    'groupOverride',
    'groupWeight',
    'useGroupScoring',
    'ignoreBudget',
    'sticky',
    'cooldown',
    'delay',
    'disable',
]);

// Activation fields beyond the legacy keys/constant fields handled by formatEntry.
export const EXTRA_ACTIVATION_FIELDS = Object.freeze(
    LOREBOOK_ACTIVATION_FIELDS.filter(field => field !== 'keys' && field !== 'constant'),
);

export const LOREBOOK_EDITABLE_FIELDS = Object.freeze([
    'title',
    'content',
    ...LOREBOOK_ACTIVATION_FIELDS,
]);

// Proposal field name -> storage key on a World Info entry (public/scripts/world-info-entry.js).
export const LOREBOOK_STORAGE_KEY = Object.freeze({
    title: 'comment',
    keys: 'key',
    content: 'content',
    keysecondary: 'keysecondary',
    selective: 'selective',
    selectiveLogic: 'selectiveLogic',
    constant: 'constant',
    probability: 'probability',
    useProbability: 'useProbability',
    order: 'order',
    position: 'position',
    role: 'role',
    outletName: 'outletName',
    depth: 'depth',
    scanDepth: 'scanDepth',
    caseSensitive: 'caseSensitive',
    matchWholeWords: 'matchWholeWords',
    excludeRecursion: 'excludeRecursion',
    preventRecursion: 'preventRecursion',
    delayUntilRecursion: 'delayUntilRecursion',
    group: 'group',
    groupOverride: 'groupOverride',
    groupWeight: 'groupWeight',
    useGroupScoring: 'useGroupScoring',
    ignoreBudget: 'ignoreBudget',
    sticky: 'sticky',
    cooldown: 'cooldown',
    delay: 'delay',
    disable: 'disable',
});

// Matches newWorldInfoEntryDefinition in public/scripts/world-info-entry.js.
export const LOREBOOK_FIELD_DEFAULTS = Object.freeze({
    title: '',
    keys: Object.freeze([]),
    content: '',
    keysecondary: Object.freeze([]),
    selective: true,
    selectiveLogic: 0,
    constant: false,
    probability: 100,
    useProbability: true,
    order: 100,
    position: 0,
    role: 0,
    outletName: '',
    depth: 4,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    useGroupScoring: null,
    ignoreBudget: false,
    sticky: null,
    cooldown: null,
    delay: null,
    disable: false,
});

// Labels matching the lorebook editor controls in public/index.html.
export const LOREBOOK_FIELD_LABELS = Object.freeze({
    keys: 'Primary Keywords',
    keysecondary: 'Optional Filter',
    selective: 'Selective',
    selectiveLogic: 'Logic',
    constant: 'Constant',
    probability: 'Trigger probability',
    useProbability: 'Use Probability',
    order: 'Order',
    position: 'Position',
    role: 'Role',
    outletName: 'Outlet Name',
    depth: 'Depth',
    scanDepth: 'Scan Depth',
    caseSensitive: 'Case-Sensitive',
    matchWholeWords: 'Whole Words',
    excludeRecursion: 'Non-recursable',
    preventRecursion: 'Prevent further recursion',
    delayUntilRecursion: 'Delay until recursion',
    group: 'Inclusion Group',
    groupOverride: 'Prioritize',
    groupWeight: 'Group Weight',
    useGroupScoring: 'Group Scoring',
    ignoreBudget: 'Ignore budget',
    sticky: 'Sticky',
    cooldown: 'Cooldown',
    delay: 'Delay',
    disable: 'Status',
});

const MAX_LIST_ITEMS = 200;
const MAX_KEY_LENGTH = 500;
const MAX_GROUP_LENGTH = 300;
const MAX_OUTLET_LENGTH = 120;

const ALLOWED_ADD_KEYS = new Set(['type', 'action', 'book', 'reason', 'uid', ...LOREBOOK_EDITABLE_FIELDS]);
const ALLOWED_EDIT_KEYS = new Set(['type', 'action', 'book', 'uid', 'reason', ...LOREBOOK_EDITABLE_FIELDS]);
const ALLOWED_DELETE_KEYS = new Set(['type', 'action', 'book', 'uid', 'reason', 'content']);

function isStrictInteger(value) {
    return typeof value === 'number' && Number.isInteger(value);
}

function validateKeywordArray(value, label, { allowCommaString = false } = {}, fail) {
    if (allowCommaString && typeof value === 'string') {
        const list = value.split(',').map(item => item.trim()).filter(Boolean);
        if (list.length > MAX_LIST_ITEMS) fail(`${label} cannot have more than ${MAX_LIST_ITEMS} items.`);
        if (list.some(item => item.length > MAX_KEY_LENGTH)) fail(`Each keyword in ${label} must be ${MAX_KEY_LENGTH} characters or fewer.`);
        return list;
    }
    if (!Array.isArray(value)) fail(`${label} must be a list of strings.`);
    if (value.length > MAX_LIST_ITEMS) fail(`${label} cannot have more than ${MAX_LIST_ITEMS} items.`);
    const clean = [];
    for (const item of value) {
        if (typeof item !== 'string') fail(`${label} must contain only strings.`);
        const trimmed = item.trim();
        if (trimmed.length > MAX_KEY_LENGTH) fail(`Each keyword in ${label} must be ${MAX_KEY_LENGTH} characters or fewer.`);
        if (trimmed) clean.push(trimmed);
    }
    return clean;
}

function validateBoolean(value, name, fail) {
    if (typeof value !== 'boolean') fail(`Lorebook ${name} must be true or false.`);
    return value;
}

function validateTriStateBoolean(value, name, fail) {
    if (value !== null && typeof value !== 'boolean') {
        fail(`Lorebook ${name} must be true, false, or null to use the book default.`);
    }
    return value;
}

function validateIntegerRange(value, name, min, max, fail) {
    if (!isStrictInteger(value) || value < min || value > max) {
        fail(`Lorebook ${name} must be a whole number from ${min} to ${max}.`);
    }
    return value;
}

function validateNullableIntegerRange(value, name, min, max, defaultLabel, fail) {
    if (value === null) return null;
    if (!isStrictInteger(value) || value < min || value > max) {
        fail(`Lorebook ${name} must be a whole number from ${min} to ${max}, or null for ${defaultLabel}.`);
    }
    return value;
}

/**
 * Validates one activation setting on a lorebook add/edit proposal.
 * Rejects wrong types, unknown enum values and out-of-range numbers without coercion.
 */
export function validateLorebookField(field, value, fail) {
    switch (field) {
        case 'keys':
            return validateKeywordArray(value, 'Lorebook keys', { allowCommaString: true }, fail);
        case 'keysecondary':
            return validateKeywordArray(value, 'Lorebook keysecondary', { allowCommaString: false }, fail);
        case 'selective':
        case 'constant':
        case 'useProbability':
        case 'excludeRecursion':
        case 'preventRecursion':
        case 'groupOverride':
        case 'ignoreBudget':
        case 'disable':
            return validateBoolean(value, field, fail);
        case 'caseSensitive':
        case 'matchWholeWords':
        case 'useGroupScoring':
            return validateTriStateBoolean(value, field, fail);
        case 'selectiveLogic':
            if (!isStrictInteger(value) || !Object.hasOwn(LOREBOOK_SELECTIVE_LOGIC, value)) {
                fail('Lorebook selectiveLogic must be 0 (AND ANY), 1 (NOT ALL), 2 (NOT ANY) or 3 (AND ALL).');
            }
            return value;
        case 'probability':
            return validateIntegerRange(value, 'probability', 0, 100, fail);
        case 'order':
            return validateIntegerRange(value, 'order', 0, 9999, fail);
        case 'position':
            if (!isStrictInteger(value) || !Object.hasOwn(LOREBOOK_POSITIONS, value)) {
                fail('Lorebook position must be an integer from 0 to 7.');
            }
            return value;
        case 'role':
            if (value === null) return null;
            if (!isStrictInteger(value) || !Object.hasOwn(LOREBOOK_ROLES, value)) {
                fail('Lorebook role must be 0 (System), 1 (User), 2 (Assistant) or null.');
            }
            return value;
        case 'outletName':
            if (typeof value !== 'string' || value.length > MAX_OUTLET_LENGTH) {
                fail(`Lorebook outletName must be text up to ${MAX_OUTLET_LENGTH} characters.`);
            }
            return value.trim();
        case 'depth':
            return validateIntegerRange(value, 'depth', 0, 1000, fail);
        case 'scanDepth':
            return validateNullableIntegerRange(value, 'scanDepth', 0, 1000, 'the book default', fail);
        case 'delayUntilRecursion':
            if (typeof value === 'boolean') return value;
            if (isStrictInteger(value) && value >= 0 && value <= 1000) return value;
            fail('Lorebook delayUntilRecursion must be false, true, or a whole number from 0 to 1000.');
            return false;
        case 'group':
            if (typeof value !== 'string' || value.length > MAX_GROUP_LENGTH) {
                fail(`Lorebook group must be text up to ${MAX_GROUP_LENGTH} characters.`);
            }
            return value.trim();
        case 'groupWeight':
            return validateIntegerRange(value, 'groupWeight', 1, 999999, fail);
        case 'sticky':
            return validateNullableIntegerRange(value, 'sticky', 1, 10000, 'off', fail);
        case 'cooldown':
            return validateNullableIntegerRange(value, 'cooldown', 1, 10000, 'off', fail);
        case 'delay':
            return validateNullableIntegerRange(value, 'delay', 1, 10000, 'off', fail);
        default:
            fail(`Unsupported lorebook field: ${field}.`);
            return undefined;
    }
}

/**
 * Checks that a lorebook proposal contains no unknown or disallowed keys for its action.
 */
export function assertAllowedLorebookKeys(value, action, fail) {
    const allowed = action === 'add' ? ALLOWED_ADD_KEYS : action === 'edit' ? ALLOWED_EDIT_KEYS : ALLOWED_DELETE_KEYS;
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(`Unsupported lorebook field: ${key}.`);
    }
}

/**
 * Reads a field's current effective value from a stored World Info entry,
 * matching the real editor and template defaults when absent.
 */
export function readLorebookField(entry, field) {
    const storageKey = LOREBOOK_STORAGE_KEY[field];
    const raw = entry?.[storageKey];
    switch (field) {
        case 'title':
            return String(raw ?? '').trim();
        case 'content':
            return String(raw ?? '');
        case 'keys':
        case 'keysecondary':
            return Array.isArray(raw) ? raw.map(item => String(item ?? '').trim()).filter(Boolean) : [];
        case 'selective':
            return raw === undefined ? true : Boolean(raw);
        case 'useProbability':
            return raw === undefined ? true : Boolean(raw);
        case 'constant':
        case 'excludeRecursion':
        case 'preventRecursion':
        case 'groupOverride':
        case 'ignoreBudget':
        case 'disable':
            return Boolean(raw);
        case 'caseSensitive':
        case 'matchWholeWords':
        case 'useGroupScoring':
            return typeof raw === 'boolean' ? raw : null;
        case 'selectiveLogic':
            return Number.isInteger(raw) && Object.hasOwn(LOREBOOK_SELECTIVE_LOGIC, raw) ? raw : LOREBOOK_FIELD_DEFAULTS.selectiveLogic;
        case 'probability':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : LOREBOOK_FIELD_DEFAULTS.probability;
        case 'order':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : LOREBOOK_FIELD_DEFAULTS.order;
        case 'position':
            return Number.isInteger(raw) && Object.hasOwn(LOREBOOK_POSITIONS, raw) ? raw : LOREBOOK_FIELD_DEFAULTS.position;
        case 'role':
            return raw === null ? null : (Number.isInteger(raw) && Object.hasOwn(LOREBOOK_ROLES, raw) ? raw : LOREBOOK_FIELD_DEFAULTS.role);
        case 'outletName':
            return String(raw ?? '').trim();
        case 'depth':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : LOREBOOK_FIELD_DEFAULTS.depth;
        case 'scanDepth':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        case 'delayUntilRecursion':
            if (raw === true) return 1;
            if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
            return 0;
        case 'group':
            return String(raw ?? '').trim();
        case 'groupWeight':
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : LOREBOOK_FIELD_DEFAULTS.groupWeight;
        case 'sticky':
        case 'cooldown':
        case 'delay':
            return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
        default:
            return raw;
    }
}

function normaliseForCompare(field, value) {
    if (field === 'delayUntilRecursion') {
        if (value === true) return 1;
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
        return 0;
    }
    return value;
}

export function lorebookFieldEqual(field, left, right) {
    const a = normaliseForCompare(field, left);
    const b = normaliseForCompare(field, right);
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => item === b[index]);
    }
    return a === b;
}

/**
 * Formats one activation field value in plain words matching the lorebook editor.
 */
export function formatLorebookFieldValue(field, value) {
    switch (field) {
        case 'keys':
        case 'keysecondary':
            return Array.isArray(value) && value.length ? value.join(', ') : 'None';
        case 'selective':
        case 'useProbability':
        case 'excludeRecursion':
        case 'preventRecursion':
        case 'groupOverride':
        case 'ignoreBudget':
            return value ? 'Yes' : 'No';
        case 'constant':
            return value ? 'Always active' : 'Keyword-triggered';
        case 'disable':
            return value ? 'Disabled' : 'Enabled';
        case 'caseSensitive':
        case 'matchWholeWords':
        case 'useGroupScoring':
            return value === null ? 'Use global' : value ? 'Yes' : 'No';
        case 'selectiveLogic':
            return LOREBOOK_SELECTIVE_LOGIC[value] ?? String(value);
        case 'probability':
            return `${value}%`;
        case 'position':
            return LOREBOOK_POSITIONS[value] ?? String(value);
        case 'role':
            return value === null ? 'Unset' : (LOREBOOK_ROLES[value] ?? String(value));
        case 'outletName':
        case 'group':
            return value ? String(value) : 'None';
        case 'scanDepth':
            return value === null ? 'Use global setting' : String(value);
        case 'delayUntilRecursion': {
            const level = normaliseForCompare('delayUntilRecursion', value);
            return level === 0 ? 'Off' : `Level ${level}`;
        }
        case 'sticky':
            return value === null ? 'Non-sticky' : String(value);
        case 'cooldown':
            return value === null ? 'No cooldown' : String(value);
        case 'delay':
            return value === null ? 'No delay' : String(value);
        default:
            return String(value ?? '');
    }
}

/**
 * Builds the list of changed activation settings for a review card.
 * Unchanged settings are never listed.
 */
export function describeLorebookSettingChanges(currentEntry, patch, { isAdd = false, includeTitle = false } = {}) {
    const rows = [];
    if (includeTitle && Object.hasOwn(patch, 'title')) {
        const beforeTitle = readLorebookField(currentEntry, 'title');
        if (beforeTitle !== patch.title) {
            rows.push({
                field: 'title',
                label: 'Title',
                before: beforeTitle || 'Untitled',
                after: patch.title || 'Untitled',
            });
        }
    }
    for (const field of LOREBOOK_ACTIVATION_FIELDS) {
        if (!Object.hasOwn(patch, field)) continue;
        // On add, keys are already shown in the editable text preview.
        if (isAdd && field === 'keys') continue;
        const beforeValue = readLorebookField(currentEntry, field);
        const afterValue = patch[field];
        if (lorebookFieldEqual(field, beforeValue, afterValue)) continue;
        rows.push({
            field,
            label: LOREBOOK_FIELD_LABELS[field],
            before: formatLorebookFieldValue(field, beforeValue),
            after: formatLorebookFieldValue(field, afterValue),
        });
    }
    return rows;
}

/**
 * Applies validated activation settings onto a real World Info entry object,
 * matching public/scripts/world-info.js storage conventions.
 */
export function applyLorebookActivationFields(entry, patch) {
    for (const field of LOREBOOK_ACTIVATION_FIELDS) {
        if (!Object.hasOwn(patch, field)) continue;
        const storageKey = LOREBOOK_STORAGE_KEY[field];
        const value = patch[field];
        if (field === 'keys' || field === 'keysecondary') {
            entry[storageKey] = [...value];
        } else if (field === 'constant') {
            entry.constant = value;
            if (value) entry.vectorized = false;
        } else if (field === 'delayUntilRecursion') {
            if (value === false || value === 0) entry.delayUntilRecursion = false;
            else if (value === true || value === 1) entry.delayUntilRecursion = true;
            else entry.delayUntilRecursion = value;
        } else {
            entry[storageKey] = value;
        }
    }
    if (Object.hasOwn(patch, 'position') && !Object.hasOwn(patch, 'role')) {
        if (patch.position === 4 && (entry.role === null || entry.role === undefined)) entry.role = 0;
        if (patch.position !== 4) entry.role = null;
    }
}

/**
 * Stable JSON snapshot of every editable field on an entry for staleness checks.
 */
export function snapshotLorebookEntry(entry) {
    const state = {};
    for (const field of LOREBOOK_EDITABLE_FIELDS) {
        state[field] = readLorebookField(entry, field);
    }
    return JSON.stringify(state);
}
