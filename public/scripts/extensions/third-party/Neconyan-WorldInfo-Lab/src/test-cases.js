import {
    DEFAULT_SCAN_SETTINGS,
    GENERATION_TRIGGERS,
    METADATA_KEY,
} from './constants.js';
import { countTokens, getContext, loadHost, mutateWorldInfo } from './host.js';
import { buildSimulationRequest } from './scan-input.js';
import { getSettings } from './settings.js';
import { simulateWorldInfo } from './simulator/engine.js';
import { getActiveBookPlan, normalizeScanSettings, snapshotLorebooks } from './sources.js';

const TEST_CASE_VERSION = 2;
const MAX_CASE_BYTES = 2 * 1024 * 1024;

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Saved test canceled.', 'AbortError');
    }
}

function makeId(context) {
    return context?.uuidv4?.()
        ?? globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function storedCases(book) {
    const canonical = book?.originalData?.extensions?.[METADATA_KEY]?.testCases;
    const topLevel = book?.extensions?.[METADATA_KEY]?.testCases;
    return clone(Array.isArray(canonical) ? canonical : Array.isArray(topLevel) ? topLevel : []);
}

function writeStoredCases(book, cases) {
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

async function discoverBooks(context) {
    const host = await loadHost();
    const active = host.ok ? getActiveBookPlan(context, host).all : [];
    const selected = getSettings().selectedBook;
    let known = [];
    const failures = [];
    if (typeof context?.getWorldInfoNames === 'function') {
        try {
            const names = await context.getWorldInfoNames();
            known = Array.isArray(names) ? names : [];
        } catch (error) {
            failures.push({ bookName: 'Lorebook list', message: String(error?.message ?? error) });
        }
    }
    return { names: [...new Set([
        ...known,
        ...active,
        ...(selected ? [selected] : []),
    ].map(String).filter(Boolean))], failures };
}

async function loadCasesFromBook(context, bookName) {
    try {
        const book = await context.loadWorldInfo(bookName);
        if (!book?.entries || typeof book.entries !== 'object' || Array.isArray(book.entries)) {
            throw new Error('The lorebook could not be loaded or returned invalid entry data.');
        }
        return {
            cases: storedCases(book).map(item => ({ ...clone(item), bookName })),
            failure: null,
        };
    } catch (error) {
        return {
            cases: [],
            failure: { bookName, message: String(error?.message ?? error) },
        };
    }
}

export async function listTestCases({ bookNames = null } = {}) {
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function') {
        throw new Error("Neconyan's lorebook loader is unavailable. Reload and try again.");
    }
    const discovery = bookNames === null ? await discoverBooks(context) : { names: bookNames, failures: [] };
    const names = discovery.names;
    const groups = await Promise.all(names.map(name => loadCasesFromBook(context, name)));
    return {
        cases: groups.flatMap(group => group.cases).sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '')
            .localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))),
        failures: [...discovery.failures, ...groups.flatMap(group => group.failure ? [group.failure] : [])],
    };
}

function expectedFrom(result) {
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

async function saveCaseNow(input) {
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function' || typeof context?.saveWorldInfo !== 'function') {
        throw new Error('Neconyan cannot save lorebooks in this session. Reload and try again.');
    }
    const result = input?.result;
    if (result?.kind !== 'simulated' || !result.replay) {
        throw new TypeError('There is no scan result to save. Run a scan first.');
    }
    if (result.replay.macroReplaySafe !== true) {
        throw new TypeError('This scan uses experimental variable shorthand macros that cannot be frozen reliably, so it cannot be saved as a replay test.');
    }
    if (input?.confirmReplayStorage !== true) {
        throw new TypeError('Check the privacy acknowledgment before saving this test.');
    }
    const name = String(input.name ?? '').trim();
    if (!name) {
        throw new TypeError('Enter a name for this saved test.');
    }
    const sourceBooks = result.replay.sourcePlan?.all ?? [];
    const preferred = String(input.bookName ?? getSettings().selectedBook ?? '');
    const bookName = preferred || sourceBooks[0];
    if (!bookName) {
        throw new Error('Choose a lorebook in which to store this test.');
    }
    const now = new Date().toISOString();
    const item = {
        id: makeId(context),
        version: TEST_CASE_VERSION,
        name: name.slice(0, 120),
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        replay: clone(result.replay),
        expected: expectedFrom(result),
    };
    if (new TextEncoder().encode(JSON.stringify(item)).length > MAX_CASE_BYTES) {
        throw new RangeError('This saved test is larger than 2 MB. Use shorter pasted text or a smaller scan, then save it again.');
    }
    await mutateWorldInfo(bookName, (next) => {
        if (!next?.entries || typeof next.entries !== 'object' || Array.isArray(next.entries)) {
            throw new Error(`The lorebook "${bookName}" could not be loaded. Reload the lorebook and try again.`);
        }
        writeStoredCases(next, [...storedCases(next), item]);
    });
    let refreshWarning = '';
    try {
        await context.reloadWorldInfoEditor?.(bookName, true);
    } catch (error) {
        refreshWarning = `The test was saved, but Neconyan could not refresh its lorebook editor. Reload the lorebook before retrying. Technical details: ${error?.message ?? error}`;
    }
    return { ...clone(item), bookName, refreshWarning };
}

export function saveTestCase(input) {
    return saveCaseNow(input);
}

async function deleteCaseNow(id, bookName = '') {
    const context = getContext();
    let names = bookName ? [bookName] : [];
    if (!names.length) {
        const listed = await listTestCases();
        const owners = [...new Set(listed.cases.filter(item => item?.id === id).map(item => item.bookName))];
        if (owners.length > 1) {
            throw new Error(`The test ID exists in multiple lorebooks: ${owners.join(', ')}. Choose the lorebook to delete from.`);
        }
        const owner = owners[0];
        if (!owner && listed.failures.length) {
            throw new Error(`The test could not be located because some lorebooks were unavailable: ${listed.failures.map(failure => failure.bookName).join(', ')}.`);
        }
        names = owner ? [owner] : [];
    }
    for (const name of names) {
        const deleted = await mutateWorldInfo(name, (next) => {
            const cases = storedCases(next);
            const nextCases = cases.filter(item => item?.id !== id);
            if (nextCases.length === cases.length) {
                return false;
            }
            writeStoredCases(next, nextCases);
            return true;
        });
        if (!deleted) continue;
        let refreshWarning = '';
        try {
            await context.reloadWorldInfoEditor?.(name, true);
        } catch (error) {
            refreshWarning = `The test was deleted, but Neconyan could not refresh its lorebook editor. Reload the lorebook before retrying. Technical details: ${error?.message ?? error}`;
        }
        return { deleted: true, refreshWarning };
    }
    return { deleted: false, refreshWarning: '' };
}

export function deleteTestCase(id, { bookName = '' } = {}) {
    return deleteCaseNow(id, bookName);
}

function compare(caseItem, result) {
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

function validateReplay(value) {
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

export async function runTestCase(caseItem, { signal } = {}) {
    checkAbort(signal);
    if (caseItem?.version !== TEST_CASE_VERSION || !caseItem.replay) {
        throw new TypeError('This saved test was created by an incompatible version of World Info Lab. Update the extension and try again.');
    }
    const replay = validateReplay(caseItem.replay);
    const context = getContext();
    const macroEngine = context?.powerUserSettings?.experimental_macro_engine ? 'experimental' : 'legacy';
    if (replay.macroEngine !== macroEngine) {
        throw new Error(`This saved test used the ${replay.macroEngine} macro engine, but Neconyan is using the ${macroEngine} engine. Switch back or recreate the test.`);
    }
    const snapshot = await snapshotLorebooks({
        context,
        sourcePlan: replay.sourcePlan,
        settings: replay.settings,
    });
    const unavailable = replay.sourcePlan.all.filter(name => !snapshot.books.has(name));
    if (unavailable.length) {
        throw new Error(`This saved test could not run because these frozen lorebooks are unavailable or invalid: ${unavailable.join(', ')}.`);
    }
    checkAbort(signal);
    const request = await buildSimulationRequest(snapshot, {
        context,
        mode: replay.mode,
        messages: replay.messages,
        injections: replay.injections,
        settings: replay.settings,
        maxContext: replay.maxContext,
        trigger: replay.trigger,
        seed: replay.seed,
        forcedRefs: replay.forcedRefs,
        timedEffects: replay.timedEffects,
        character: replay.character,
        globalScanData: replay.globalScanData,
        macroSnapshot: replay.macroSnapshot,
        macroEngine: replay.macroEngine,
        tokenCount: countTokens,
    });
    const result = await simulateWorldInfo(request, { signal });
    const comparison = compare(caseItem, result);
    return {
        ...comparison,
        result,
        summary: comparison.passed
            ? `"${caseItem.name}" passed. Activated entries, token use, and insertion results match the saved scan.`
            : `"${caseItem.name}" did not match the saved scan. Changed: ${comparison.differences.map(item => ({
                fingerprint: 'scan inputs or overall result',
                placements: 'insertion locations or rendered content',
                'token budget': 'token use or limit',
            })[item] ?? item).join(', ')}. Open Scan and Trace to inspect the new result.`,
    };
}
