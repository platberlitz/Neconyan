import {
    ASSERTION,
    CASE_VERSION,
    DRAFT_VERSION,
    LEDGER_VERSION,
    MAX_REGEX_LENGTH,
    PROMPT_DRAFT_VERSION,
    RUN_VERSION,
    STATUS,
    SUITE_VERSION,
} from './constants.js';
import { ANCHOR_LENGTH } from './compare.js';
import { isSupportedApiId, modeOf, validatePresetPayload } from './presets.js';
import { regexSafetyProblem } from './safe-regex.js';

/**
 * Pure data helpers for every stored object. No host imports: everything here
 * must run under plain Node for the unit tests.
 */

const ASSERTION_TYPES = new Set(Object.values(ASSERTION));
const STATUS_VALUES = new Set(Object.values(STATUS));

export function newId() {
    const uuid = globalThis.crypto?.randomUUID;
    if (typeof uuid === 'function') {
        return globalThis.crypto.randomUUID();
    }
    let text = '';
    for (let index = 0; index < 32; index++) {
        text += Math.floor(Math.random() * 16).toString(16);
    }
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function integer(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeVolatileSpan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const stringFields = ['section', 'text', 'otherText', 'anchorBefore', 'anchorAfter', 'macro', 'class', 'why'];
    const booleanFields = ['aboveBreakpoint'];
    const output = {};
    for (const key of stringFields) {
        if (value[key] === undefined) {
            continue;
        }
        if (typeof value[key] !== 'string') {
            return null;
        }
        output[key] = key === 'anchorBefore' || key === 'anchorAfter'
            ? value[key].slice(0, ANCHOR_LENGTH)
            : value[key];
    }
    for (const key of booleanFields) {
        if (value[key] === undefined) {
            continue;
        }
        if (typeof value[key] !== 'boolean') {
            return null;
        }
        output[key] = value[key];
    }
    if (value.occurrence !== undefined) {
        if (!Number.isInteger(value.occurrence) || value.occurrence < 0) {
            return null;
        }
        output.occurrence = value.occurrence;
    }
    if (typeof output.text !== 'string' || typeof output.otherText !== 'string') {
        return null;
    }
    return output;
}

/* ------------------------------------------------------------------ pins */

/**
 * Collects pinned presets. A version 1 case pinned a single preset and often
 * left the preset type blank, which meant "whatever API happens to be active".
 * Those are kept as-is so the user can see what needs fixing instead of the
 * meaning changing under them.
 */
function normalizePresetRefs(source) {
    const raw = Array.isArray(source.presets)
        ? source.presets
        : (source.preset ? [source.preset] : []);
    const refs = [];
    const seen = new Set();
    for (const item of raw) {
        const ref = plainObject(item);
        const name = text(ref.name);
        if (!name) {
            continue;
        }
        const apiId = text(ref.apiId);
        if (seen.has(apiId)) {
            continue;
        }
        seen.add(apiId);
        refs.push({ apiId, name });
    }
    return refs;
}

export function normalizePins(value) {
    const source = plainObject(value);
    const promptTags = plainObject(source.promptTags);
    return {
        characterAvatar: text(source.characterAvatar),
        personaKey: typeof source.personaKey === 'string' && source.personaKey ? source.personaKey : null,
        connectionProfileId: text(source.connectionProfileId),
        presets: normalizePresetRefs(source),
        promptTags: text(promptTags.profileId) || text(promptTags.profileName)
            ? { profileId: text(promptTags.profileId), profileName: text(promptTags.profileName) }
            : null,
        macroEnhanced: source.macroEnhanced === 'off' ? 'off' : 'record',
    };
}

/**
 * The prompt mode a case will run in, judged only from what it pins. Returns
 * null when the pinned presets do not say.
 */
export function pinnedMode(pins) {
    const modes = new Set(normalizePins(pins).presets
        .filter(ref => isSupportedApiId(ref.apiId))
        .map(ref => modeOf(ref.apiId)));
    return modes.size === 1 ? [...modes][0] : null;
}

/* ------------------------------------------------------------ assertions */

/**
 * Normalizes one assertion. Unknown types are dropped by normalizeAssertions
 * so a suite written by a newer version cannot silently pass here.
 */
export function normalizeAssertion(value) {
    const source = plainObject(value);
    const type = text(source.type);
    if (!ASSERTION_TYPES.has(type)) {
        return null;
    }
    const base = { type };
    switch (type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            return { ...base, section: text(source.section) };
        case ASSERTION.TOKEN_CEILING:
            return {
                ...base,
                scope: text(source.scope, 'total') || 'total',
                max: integer(source.max, 0, 0),
            };
        case ASSERTION.CONTENT_MATCH:
            return {
                ...base,
                scope: text(source.scope, 'final') || 'final',
                mode: source.mode === 'regex' ? 'regex' : 'contains',
                value: text(source.value),
                negate: bool(source.negate),
            };
        case ASSERTION.WI_ACTIVATED:
            return {
                ...base,
                worldName: text(source.worldName),
                entryKey: text(source.entryKey),
                negate: bool(source.negate),
            };
        case ASSERTION.CACHE_PREFIX_STABLE:
            return base;
        default:
            return null;
    }
}

export function normalizeAssertions(value) {
    return list(value).map(item => normalizeAssertion(item)).filter(Boolean);
}

/**
 * Reports why an assertion cannot be evaluated, in words a non-programmer can
 * act on. Returns an empty array when the assertion is usable.
 */
export function validateAssertion(assertion, { safetyProblem = regexSafetyProblem } = {}) {
    const problems = [];
    const normalized = normalizeAssertion(assertion);
    if (!normalized) {
        problems.push('This check type is not supported by this version of Prompting Lab.');
        return problems;
    }
    switch (normalized.type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            if (!normalized.section) {
                problems.push('Choose which prompt section to check.');
            }
            break;
        case ASSERTION.TOKEN_CEILING:
            if (normalized.max <= 0) {
                problems.push('Set a token limit above zero.');
            }
            break;
        case ASSERTION.CONTENT_MATCH:
            if (!normalized.value) {
                problems.push('Enter the text to look for.');
            } else if (normalized.mode === 'regex') {
                if (normalized.value.length > MAX_REGEX_LENGTH) {
                    problems.push(`That search pattern is too long. Keep it to ${MAX_REGEX_LENGTH} characters or fewer.`);
                } else {
                    try {
                        new RegExp(normalized.value);
                    } catch (error) {
                        problems.push(`That search pattern is not valid: ${error?.message ?? error}`);
                    }
                    const unsafe = safetyProblem(normalized.value);
                    if (!problems.length && unsafe) {
                        problems.push(unsafe);
                    }
                }
            }
            break;
        case ASSERTION.WI_ACTIVATED:
            if (!normalized.entryKey) {
                problems.push('Enter which lorebook entry to look for.');
            }
            break;
        default:
            break;
    }
    return problems;
}

/* ----------------------------------------------------------- test cases */

export function createCase(patch = {}) {
    return normalizeCase({
        v: CASE_VERSION,
        id: newId(),
        name: 'New test case',
        notes: '',
        tags: [],
        userMessage: '',
        assertions: [],
        ...patch,
    });
}

export function normalizeCase(value) {
    const source = plainObject(value);
    return {
        v: CASE_VERSION,
        id: text(source.id) || newId(),
        name: text(source.name, 'Untitled test case') || 'Untitled test case',
        notes: text(source.notes),
        tags: list(source.tags).map(tag => text(tag)).filter(Boolean),
        pins: normalizePins(source.pins),
        userMessage: text(source.userMessage),
        assertions: normalizeAssertions(source.assertions),
    };
}

/**
 * Forward-only migration. Objects from a newer version are refused by the
 * callers rather than silently downgraded here.
 */
export function migrateCase(value) {
    const source = plainObject(value);
    const version = integer(source.v, 0, 0);
    if (version > CASE_VERSION) {
        return null;
    }
    return normalizeCase(source);
}

export function validateCase(testCase, regex) {
    const problems = [];
    const normalized = normalizeCase(testCase);
    if (!normalized.name.trim()) {
        problems.push('Give this test case a name.');
    }
    if (!normalized.pins.characterAvatar) {
        problems.push('Choose a character for this test case.');
    }
    const modes = new Set(normalized.pins.presets
        .filter(ref => isSupportedApiId(ref.apiId))
        .map(ref => modeOf(ref.apiId)));
    if (modes.size > 1) {
        problems.push('This test case pins both Chat Completion and Text Completion presets. Only one prompt mode can run at a time.');
    }
    normalized.assertions.forEach((assertion, index) => {
        for (const problem of validateAssertion(assertion, regex)) {
            problems.push(`Check ${index + 1}: ${problem}`);
        }
    });
    return problems;
}

/* -------------------------------------------------------- preset drafts */

/**
 * A preset kept inside Prompting Lab. Drafts are never applied on their own:
 * they have to be published into Neconyan first.
 */
export function createDraft(patch = {}) {
    const now = new Date().toISOString();
    return normalizeDraft({
        v: DRAFT_VERSION,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        ...patch,
    });
}

export function normalizeDraft(value) {
    const source = plainObject(value);
    const origin = plainObject(source.source);
    return {
        v: DRAFT_VERSION,
        id: text(source.id) || newId(),
        apiId: text(source.apiId),
        name: text(source.name, 'Untitled preset') || 'Untitled preset',
        notes: text(source.notes),
        tags: list(source.tags).map(tag => text(tag)).filter(Boolean),
        payload: plainObject(source.payload),
        source: text(origin.name)
            ? { name: text(origin.name), fingerprint: text(origin.fingerprint) }
            : null,
        publishedAs: text(source.publishedAs),
        createdAt: text(source.createdAt),
        updatedAt: text(source.updatedAt),
    };
}

export function migrateDraft(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > DRAFT_VERSION) {
        return null;
    }
    return normalizeDraft(source);
}

export function validateDraft(draft) {
    const normalized = normalizeDraft(draft);
    const problems = [];
    if (!normalized.name.trim()) {
        problems.push('Give this preset a name.');
    }
    if (!isSupportedApiId(normalized.apiId)) {
        problems.push('Choose which kind of preset this is.');
    }
    problems.push(...validatePresetPayload(normalized.apiId, normalized.payload));
    return problems;
}

/* -------------------------------------------------------- prompt drafts */

const PROMPT_ROLES = new Set(['system', 'user', 'assistant']);

function normalizePromptVersion(value) {
    const source = plainObject(value);
    if (typeof source.content !== 'string') {
        return null;
    }
    return {
        id: text(source.id) || newId(),
        label: text(source.label, 'Draft') || 'Draft',
        content: source.content,
        createdAt: text(source.createdAt),
        updatedAt: text(source.updatedAt),
    };
}

/**
 * A titled prompt kept in the Prompts space. One prompt can hold several
 * draft versions of its text; exactly one of them is the selected version,
 * which is what gets sent to presets and offered to comparisons.
 */
export function createPromptDraft(patch = {}) {
    const now = new Date().toISOString();
    return normalizePromptDraft({
        v: PROMPT_DRAFT_VERSION,
        id: newId(),
        title: 'New prompt',
        versions: [{ id: newId(), label: 'Draft 1', content: '', createdAt: now, updatedAt: now }],
        createdAt: now,
        updatedAt: now,
        ...patch,
    });
}

export function normalizePromptDraft(value) {
    const source = plainObject(value);
    const versions = list(source.versions)
        .map(version => normalizePromptVersion(version))
        .filter(Boolean);
    if (!versions.length) {
        versions.push({ id: newId(), label: 'Draft 1', content: '', createdAt: '', updatedAt: '' });
    }
    const selected = text(source.selectedVersionId);
    return {
        v: PROMPT_DRAFT_VERSION,
        id: text(source.id) || newId(),
        title: text(source.title, 'Untitled prompt') || 'Untitled prompt',
        notes: text(source.notes),
        tags: list(source.tags).map(tag => text(tag)).filter(Boolean),
        role: PROMPT_ROLES.has(source.role) ? source.role : 'system',
        versions,
        selectedVersionId: versions.some(version => version.id === selected)
            ? selected
            : versions[0].id,
        createdAt: text(source.createdAt),
        updatedAt: text(source.updatedAt),
    };
}

export function migratePromptDraft(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > PROMPT_DRAFT_VERSION) {
        return null;
    }
    return normalizePromptDraft(source);
}

export function validatePromptDraft(draft) {
    const normalized = normalizePromptDraft(draft);
    const problems = [];
    if (!normalized.title.trim()) {
        problems.push('Give this prompt a title.');
    }
    const labels = new Set();
    for (const version of normalized.versions) {
        if (!version.label.trim()) {
            problems.push('Every draft version needs a label.');
            break;
        }
        const key = version.label.trim().toLowerCase();
        if (labels.has(key)) {
            problems.push(`Two draft versions share the label "${version.label.trim()}".`);
            break;
        }
        labels.add(key);
    }
    return problems;
}

/* --------------------------------------------------------------- suites */

export function createSuite(patch = {}) {
    return normalizeSuite({
        v: SUITE_VERSION,
        id: newId(),
        name: 'New suite',
        description: '',
        caseIds: [],
        baselines: {},
        ...patch,
    });
}

export function normalizeSuite(value) {
    const source = plainObject(value);
    const baselines = {};
    for (const [caseId, runId] of Object.entries(plainObject(source.baselines))) {
        if (typeof runId === 'string' && runId) {
            baselines[caseId] = runId;
        }
    }
    const seen = new Set();
    const caseIds = list(source.caseIds).map(id => text(id)).filter((id) => {
        if (!id || seen.has(id)) {
            return false;
        }
        seen.add(id);
        return true;
    });
    return {
        v: SUITE_VERSION,
        id: text(source.id) || newId(),
        name: text(source.name, 'Untitled suite') || 'Untitled suite',
        description: text(source.description),
        caseIds,
        baselines,
        createdAt: text(source.createdAt),
        updatedAt: text(source.updatedAt),
    };
}

export function migrateSuite(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > SUITE_VERSION) {
        return null;
    }
    return normalizeSuite(source);
}

/* ------------------------------------------------------------ run record */

export function createRun(patch = {}) {
    return normalizeRun({
        v: RUN_VERSION,
        id: newId(),
        status: STATUS.ERROR,
        ...patch,
    });
}

export function normalizeRun(value) {
    const source = plainObject(value);
    const sourceVersion = integer(source.v, 0, 0);
    const capture = plainObject(source.capture);
    const cache = plainObject(source.cache);
    const environment = plainObject(source.environment);
    const ab = plainObject(source.ab);
    const assertionResults = list(source.assertionResults).map(result => ({
        index: integer(result?.index, 0, 0),
        type: text(result?.type),
        pass: result?.pass === null ? null : bool(result?.pass),
        actual: result?.actual ?? null,
        message: text(result?.message),
    }));
    let status = STATUS_VALUES.has(source.status) ? source.status : STATUS.ERROR;
    if ((status === STATUS.PASS || status === STATUS.CHANGED)
        && assertionResults.some(result => result.pass === null)) {
        status = STATUS.UNCHECKED;
    }
    return {
        v: RUN_VERSION,
        id: text(source.id) || newId(),
        suiteRunId: text(source.suiteRunId),
        suiteId: text(source.suiteId),
        caseId: text(source.caseId),
        caseName: text(source.caseName),
        // Set when this run is one setup of a setup comparison: the preset and
        // connection it was built with, so two runs of one case can be told
        // apart by what was changed rather than by the time they ran.
        variantLabel: text(source.variantLabel),
        startedAt: text(source.startedAt),
        durationMs: integer(source.durationMs, 0, 0),
        status,
        environment: {
            forkVersion: text(environment.forkVersion),
            apiType: environment.apiType === 'tc' ? 'tc' : 'cc',
            api: text(environment.api),
            model: text(environment.model),
            profileName: text(environment.profileName),
            presetName: text(environment.presetName),
            presets: list(environment.presets).map((entry) => {
                const ref = plainObject(entry);
                return {
                    apiId: text(ref.apiId),
                    name: text(ref.name),
                    // Whether the test case pinned this preset or it happened
                    // to be active; the runner records it, so keep it.
                    pinned: bool(ref.pinned),
                    fingerprint: text(ref.fingerprint),
                };
            }).filter(ref => ref.apiId && ref.name),
            personaName: text(environment.personaName),
            characterName: text(environment.characterName),
            characterAvatar: text(environment.characterAvatar),
            promptTagsProfile: environment.promptTagsProfile ?? null,
            macroEnhanced: environment.macroEnhanced ?? null,
        },
        capture: {
            messages: Array.isArray(capture.messages) ? capture.messages : null,
            combinedPrompt: typeof capture.combinedPrompt === 'string' ? capture.combinedPrompt : null,
            sections: list(capture.sections).map(section => ({
                id: text(section?.id),
                label: text(section?.label),
                content: text(section?.content),
                tokens: integer(section?.tokens, 0, 0),
            })),
            tokenTable: {
                total: integer(plainObject(capture.tokenTable).total, 0, 0),
                perSection: plainObject(plainObject(capture.tokenTable).perSection),
            },
            wiPasses: list(capture.wiPasses).map(pass => list(pass)),
            squashedMessages: Array.isArray(capture.squashedMessages) ? capture.squashedMessages : null,
            metricsComplete: sourceVersion >= RUN_VERSION
                ? bool(capture.metricsComplete, true)
                : false,
            capabilities: {
                syntheticMessagesIsolated: bool(plainObject(capture.capabilities).syntheticMessagesIsolated),
                macroStateSandboxed: bool(plainObject(capture.capabilities).macroStateSandboxed),
                localMacroStateRestored: bool(plainObject(capture.capabilities).localMacroStateRestored),
            },
        },
        cache: {
            predictedBreakpoints: list(cache.predictedBreakpoints)
                .map(index => integer(index, -1, -1))
                .filter(index => index >= 0),
            prefixHash: text(cache.prefixHash),
            volatileSpans: list(cache.volatileSpans)
                .map(item => normalizeVolatileSpan(item))
                .filter(Boolean),
            source: text(cache.source, 'unknown') || 'unknown',
        },
        caveats: list(source.caveats).map(item => text(item)).filter(Boolean),
        assertionResults,
        diffVsBaseline: source.diffVsBaseline ?? null,
        ab: Array.isArray(ab.runs) ? { runs: ab.runs } : null,
        error: source.error ?? null,
    };
}

export function migrateRun(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > RUN_VERSION) {
        return null;
    }
    return normalizeRun(source);
}

/* ---------------------------------------------------------- ledger entry */

export function createLedgerEntry(patch = {}) {
    return normalizeLedgerEntry({
        v: LEDGER_VERSION,
        id: newId(),
        at: new Date().toISOString(),
        ...patch,
    });
}

export function normalizeLedgerEntry(value) {
    const source = plainObject(value);
    return {
        v: LEDGER_VERSION,
        id: text(source.id) || newId(),
        at: text(source.at),
        kind: text(source.kind, 'normal') || 'normal',
        apiType: source.apiType === 'tc' ? 'tc' : 'cc',
        api: text(source.api),
        characterName: text(source.characterName),
        total: integer(source.total, 0, 0),
        estimated: bool(source.estimated),
        sections: list(source.sections).map(section => ({
            id: text(section?.id),
            label: text(section?.label),
            tokens: integer(section?.tokens, 0, 0),
        })).filter(section => section.id),
        wiEntryCount: integer(source.wiEntryCount, 0, 0),
    };
}

export function migrateLedgerEntry(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > LEDGER_VERSION) {
        return null;
    }
    return normalizeLedgerEntry(source);
}

/**
 * A run's headline status. Assertion failures always win over a content
 * difference, because a failed check is a definite problem while a difference
 * only asks the user to look.
 */
export function resolveStatus({ assertionResults = [], hasBaseline = false, diffIsEmpty = true, error = null } = {}) {
    if (error) {
        return STATUS.ERROR;
    }
    if (assertionResults.some(result => result && result.pass === false)) {
        return STATUS.FAIL;
    }
    if (assertionResults.some(result => result && result.pass === null)) {
        return STATUS.UNCHECKED;
    }
    if (hasBaseline && !diffIsEmpty) {
        return STATUS.CHANGED;
    }
    return STATUS.PASS;
}
