import {
    DEFAULT_SCAN_SETTINGS,
    GENERATION_TRIGGERS,
    METADATA_KEY,
} from './constants.js';
import { normalizeScanSettings } from './sources.js';

export const TEST_CASE_VERSION = 2;
export const MAX_CASE_BYTES = 2 * 1024 * 1024;

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function storedMetadata(book) {
    return {
        ...clone(record(book?.extensions?.[METADATA_KEY])),
        ...clone(record(book?.originalData?.extensions?.[METADATA_KEY])),
    };
}

export function storedCases(book) {
    const canonical = book?.originalData?.extensions?.[METADATA_KEY]?.testCases;
    const topLevel = book?.extensions?.[METADATA_KEY]?.testCases;
    return clone(Array.isArray(canonical) ? canonical : Array.isArray(topLevel) ? topLevel : []);
}

export function writeStoredCases(book, cases) {
    const metadata = {
        ...storedMetadata(book),
        version: TEST_CASE_VERSION,
        testCases: clone(cases),
    };
    if (!book.extensions || typeof book.extensions !== 'object' || Array.isArray(book.extensions)) {
        book.extensions = {};
    }
    book.extensions[METADATA_KEY] = clone(metadata);
    if (Array.isArray(book?.originalData?.entries)) {
        if (!book.originalData.extensions || typeof book.originalData.extensions !== 'object' || Array.isArray(book.originalData.extensions)) {
            book.originalData.extensions = {};
        }
        book.originalData.extensions[METADATA_KEY] = clone(metadata);
    }
}

export function expectedFrom(result) {
    return {
        fingerprint: String(result.fingerprint ?? ''),
        activated: (result.activated ?? []).map(entry => ({
            id: String(entry.id),
            hash: String(entry.hash),
        })),
        budget: clone(result.budget ?? {}),
        placements: (result.placements?.records ?? []).map(record => ({
            id: String(record.id),
            hash: String(record.hash),
            included: Boolean(record.included),
            position: record.position,
            placementStatus: String(record.placementStatus),
            renderedContent: String(record.renderedContent ?? ''),
        })),
    };
}

export function compare(caseItem, result) {
    const actual = expectedFrom(result);
    const expected = caseItem.expected ?? {};
    const differences = [];
    if (actual.fingerprint !== expected.fingerprint) {
        differences.push('fingerprint');
    }
    if (JSON.stringify(actual.activated) !== JSON.stringify(expected.activated ?? [])) {
        differences.push('activated entries');
    }
    if (JSON.stringify(actual.placements) !== JSON.stringify(expected.placements ?? [])) {
        differences.push('placements');
    }
    if (JSON.stringify(actual.budget) !== JSON.stringify(expected.budget ?? {})) {
        differences.push('token budget');
    }
    return { actual, expected, differences, passed: differences.length === 0 };
}

export function validateReplay(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== TEST_CASE_VERSION) {
        throw new TypeError('This saved test uses an incompatible replay format. Recreate it with this version of World Info Lab.');
    }
    const stringArray = (items, name) => {
        if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
            throw new TypeError(`Saved test ${name} must be a list of text values.`);
        }
        return [...items];
    };
    const referenceArray = (items, name) => {
        if (!Array.isArray(items) || items.some(item => (
            !item || typeof item !== 'object' || Array.isArray(item)
            || typeof item.id !== 'string' || !item.id
            || typeof item.hash !== 'string' || !item.hash
        ))) {
            throw new TypeError(`Saved test ${name} must contain entry IDs and hashes.`);
        }
        return clone(items);
    };
    const plan = value.sourcePlan;
    if (!plan || typeof plan !== 'object' || ['chat', 'persona', 'character', 'global', 'all'].some(key => (
        !Array.isArray(plan[key]) || plan[key].some(item => typeof item !== 'string')
    ))) {
        throw new TypeError('Saved test lorebook sources are invalid.');
    }
    const orderedSources = ['chat', 'persona', 'character', 'global'].flatMap(key => plan[key]);
    if (orderedSources.some(name => !name)
        || new Set(orderedSources).size !== orderedSources.length
        || JSON.stringify(plan.all) !== JSON.stringify(orderedSources)) {
        throw new TypeError('Saved test lorebook sources must be unique and match their saved source order.');
    }
    if (!['chat', 'text'].includes(value.mode)) {
        throw new TypeError('Saved test input mode is invalid.');
    }
    if (!value.settings || typeof value.settings !== 'object'
        || Object.keys(DEFAULT_SCAN_SETTINGS).some(key => !(key in value.settings))) {
        throw new TypeError('Saved test lorebook settings are incomplete.');
    }
    const maxContext = Number(value.maxContext);
    if (!Number.isFinite(maxContext) || maxContext <= 0) {
        throw new TypeError('Saved test context size is invalid.');
    }
    if (!GENERATION_TRIGGERS.includes(value.trigger)) {
        throw new TypeError('Saved test generation trigger is invalid.');
    }
    if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
        throw new TypeError('Saved test random seed is invalid.');
    }
    if (!value.timedEffects || typeof value.timedEffects !== 'object' || Array.isArray(value.timedEffects)) {
        throw new TypeError('Saved test timed effects are invalid.');
    }
    const character = value.character;
    if (!character || typeof character !== 'object' || Array.isArray(character)
        || typeof character.filename !== 'string'
        || !Array.isArray(character.tags) || character.tags.some(tag => typeof tag !== 'string')
        || typeof character.tagsAvailable !== 'boolean') {
        throw new TypeError('Saved test character data is invalid.');
    }
    const globalScanData = value.globalScanData;
    if (!globalScanData || typeof globalScanData !== 'object' || Array.isArray(globalScanData)
        || Object.values(globalScanData).some(item => typeof item !== 'string')) {
        throw new TypeError('Saved test character-card scan data is invalid.');
    }
    const macroSnapshot = value.macroSnapshot;
    if (!macroSnapshot || typeof macroSnapshot !== 'object' || Array.isArray(macroSnapshot)
        || Object.entries(macroSnapshot).some(([key, item]) => !validMacroKey(key) || typeof item !== 'string')) {
        throw new TypeError('Saved test macro values are invalid.');
    }
    if (!['legacy', 'experimental'].includes(value.macroEngine) || value.macroReplaySafe !== true) {
        throw new TypeError('Saved test macro replay settings are invalid. Recreate this saved test.');
    }
    return {
        ...clone(value),
        sourcePlan: clone(plan),
        messages: stringArray(value.messages, 'messages'),
        injections: stringArray(value.injections, 'injections'),
        settings: normalizeScanSettings(value.settings),
        maxContext,
        forcedRefs: referenceArray(value.forcedRefs, 'forced entries'),
        timedEffects: {
            sticky: referenceArray(value.timedEffects.sticky, 'sticky effects'),
            cooldown: referenceArray(value.timedEffects.cooldown, 'cooldown effects'),
            delay: referenceArray(value.timedEffects.delay, 'delay effects'),
        },
        character: clone(character),
        globalScanData: clone(globalScanData),
        macroSnapshot: clone(macroSnapshot),
    };
}

function validMacroKey(key) {
    if (/^prompt:\d+:\d+$/.test(key)) {
        return true;
    }
    const match = key.match(/^entry:(\[.*]):(?:content:\d+|(?:primary|secondary):\d+:\d+)$/);
    if (!match) {
        return false;
    }
    try {
        const reference = JSON.parse(match[1]);
        return Array.isArray(reference) && reference.length === 2
            && reference.every(value => typeof value === 'string' && value);
    } catch {
        return false;
    }
}
