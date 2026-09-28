import {
    EXPORT_FORMAT,
    LEGACY_EXPORT_FORMAT,
    EXPORT_VERSION,
    MAX_EXPORT_BYTES,
    MAX_EXPORT_WITH_BASELINES_BYTES,
} from './constants.js';
import {
    migrateCase,
    migrateDraft,
    migrateRun,
    migrateSuite,
    newId,
    normalizeAssertion,
    normalizeCase,
    normalizeDraft,
    normalizeSuite,
    validateAssertion,
    validateCase,
    validateDraft,
} from './schema.js';

/**
 * Moves suites between installations as a plain JSON file.
 *
 * A suite is meant to be shared, so an imported file is treated as untrusted:
 * every object is rebuilt through the schema, unknown fields are dropped, and a
 * file written by a newer version is refused rather than half-understood.
 */

export const KIND = Object.freeze({
    SUITE: 'suite',
    SUITE_WITH_BASELINES: 'suite-with-baselines',
});

function byteLength(text) {
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(text).length;
    }
    return Buffer.byteLength(text, 'utf8');
}

/**
 * Builds the file contents for a suite.
 *
 * @param {object} suite the suite to export
 * @param {object[]} cases its test cases
 * @param {object[]} baselineRuns baseline runs, when they are being included
 */
export function buildExport(suite, cases, baselineRuns = null, presets = null) {
    const normalizedSuite = normalizeSuite(suite);
    const suiteCaseIds = new Set(normalizedSuite.caseIds);
    const availableRuns = Array.isArray(baselineRuns) ? baselineRuns : [];
    const baselines = {};
    const includedRuns = [];
    for (const [caseId, runId] of Object.entries(normalizedSuite.baselines)) {
        const run = availableRuns.find(item => item?.id === runId && item?.caseId === caseId);
        if (suiteCaseIds.has(caseId) && run) {
            baselines[caseId] = runId;
            includedRuns.push(run);
        }
    }
    const includeBaselines = includedRuns.length > 0;
    const includePresets = Array.isArray(presets) && presets.length > 0;
    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        kind: includeBaselines ? KIND.SUITE_WITH_BASELINES : KIND.SUITE,
        exportedAt: new Date().toISOString(),
        suite: normalizeSuite({ ...normalizedSuite, baselines }),
        cases: cases.map(item => normalizeCase(item)),
        ...(includeBaselines ? { baselineRuns: includedRuns } : {}),
        ...(includePresets ? { presets } : {}),
    };
    const text = JSON.stringify(payload, null, 2);
    const limit = includeBaselines ? MAX_EXPORT_WITH_BASELINES_BYTES : MAX_EXPORT_BYTES;
    const size = byteLength(text);
    if (size > limit) {
        throw new Error(
            `This export is ${formatSize(size)}, which is larger than the ${formatSize(limit)} limit. `
            + (includeBaselines
                ? 'Export without baseline runs, or split the suite into smaller ones.'
                : 'Split the suite into smaller ones.'),
        );
    }
    return { text, size, kind: payload.kind };
}

export function formatSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireEntityId(value, label) {
    if (!plainObject(value)) {
        throw new Error(`The ${label} in that file is missing or damaged.`);
    }
    if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error(`Every ${label} in that file needs an identifier.`);
    }
    return value.id;
}

function collectUniqueIds(values, label) {
    const ids = new Set();
    values.forEach((value, index) => {
        const id = requireEntityId(value, `${label} ${index + 1}`);
        if (ids.has(id)) {
            throw new Error(`That file contains two ${label}s with the identifier "${id}".`);
        }
        ids.add(id);
    });
    return ids;
}

function importCase(value, index, regex) {
    const id = requireEntityId(value, `test case ${index + 1}`);
    if (!Array.isArray(value.assertions)) {
        throw new Error(`Test case "${id}" has a damaged assertion list.`);
    }
    for (const assertion of value.assertions) {
        if (!plainObject(assertion)) {
            throw new Error(`Test case "${id}" contains an invalid assertion.`);
        }
        const normalized = normalizeAssertion(assertion);
        const problems = validateAssertion(assertion, regex);
        if (!normalized || problems.length || Object.entries(normalized).some(([key, item]) => (
            !Object.hasOwn(assertion, key) || !Object.is(assertion[key], item)
        ))) {
            throw new Error(`Test case "${id}" contains an invalid assertion${problems.length ? `: ${problems.join(' ')}` : '.'}`);
        }
    }
    const migrated = migrateCase(value);
    if (!migrated) {
        throw new Error(`Test case "${id}" was made by a newer version of Prompting Lab.`);
    }
    const problems = validateCase(migrated, regex);
    if (problems.length) {
        throw new Error(`Test case "${id}" is invalid: ${problems.join(' ')}`);
    }
    return migrated;
}

function importRun(value, index) {
    const id = requireEntityId(value, `baseline run ${index + 1}`);
    if (typeof value.caseId !== 'string' || !value.caseId.trim()) {
        throw new Error(`Baseline run "${id}" does not identify its test case.`);
    }
    const migrated = migrateRun(value);
    if (!migrated) {
        throw new Error(`Baseline run "${id}" was made by a newer version of Prompting Lab.`);
    }
    return migrated;
}

function importDraft(value, index) {
    const id = requireEntityId(value, `preset draft ${index + 1}`);
    if (typeof value.name !== 'string' || !value.name.trim() || !plainObject(value.payload)) {
        throw new Error(`Preset draft "${id}" is invalid.`);
    }
    const migrated = migrateDraft(value);
    if (!migrated) {
        throw new Error(`Preset draft "${id}" was made by a newer version of Prompting Lab.`);
    }
    const problems = validateDraft(migrated);
    if (problems.length) {
        throw new Error(`Preset draft "${id}" is invalid: ${problems.join(' ')}`);
    }
    return migrated;
}

/**
 * Reads an export file.
 *
 * Identifiers are always regenerated so importing a suite twice, or importing
 * one that came from a copy of your own, cannot overwrite what is already
 * saved. Baseline pointers are rewritten to follow the new identifiers.
 *
 * Presets travelling with a suite arrive as drafts. They are never installed
 * on their own, so a shared file cannot change the settings you already have.
 *
 * @returns {{suite: object, cases: object[], baselineRuns: object[], presets: object[]}}
 */
export function parseImport(text, { regex } = {}) {
    const source = String(text ?? '');
    const size = byteLength(source);
    if (size > MAX_EXPORT_WITH_BASELINES_BYTES) {
        throw new Error(`That file is ${formatSize(size)}, which is larger than the ${formatSize(MAX_EXPORT_WITH_BASELINES_BYTES)} import limit.`);
    }
    let payload;
    try {
        payload = JSON.parse(source);
    } catch (error) {
        throw new Error(`That file is not readable as JSON: ${error?.message ?? error}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('That file does not contain a Prompting Lab suite.');
    }
    if (payload.format !== EXPORT_FORMAT && payload.format !== LEGACY_EXPORT_FORMAT) {
        throw new Error('That file was not made by Prompting Lab.');
    }
    const version = Number(payload.version);
    if (!Number.isFinite(version)) {
        throw new Error('That file does not say which version of Prompting Lab made it.');
    }
    if (version > EXPORT_VERSION) {
        throw new Error('That file was made by a newer version of Prompting Lab. Update the extension, then import it again.');
    }
    if (payload.kind !== KIND.SUITE && payload.kind !== KIND.SUITE_WITH_BASELINES) {
        throw new Error('That file does not identify a supported Prompting Lab export kind.');
    }
    if (!Array.isArray(payload.cases)) {
        throw new Error('That file is missing its test case list.');
    }
    if (payload.presets !== undefined && !Array.isArray(payload.presets)) {
        throw new Error('That file has a damaged preset draft list.');
    }
    if (payload.kind === KIND.SUITE_WITH_BASELINES && !Array.isArray(payload.baselineRuns)) {
        throw new Error('That file is missing its baseline run list.');
    }
    if (payload.kind === KIND.SUITE && payload.baselineRuns !== undefined
        && (!Array.isArray(payload.baselineRuns) || payload.baselineRuns.length)) {
        throw new Error('That suite-only file unexpectedly contains baseline runs.');
    }
    requireEntityId(payload.suite, 'suite');
    if (!Array.isArray(payload.suite.caseIds) || !plainObject(payload.suite.baselines)) {
        throw new Error('The suite in that file has damaged membership data.');
    }
    const suiteCaseIds = new Set();
    for (const id of payload.suite.caseIds) {
        if (typeof id !== 'string' || !id.trim()) {
            throw new Error('The suite in that file contains an invalid test case identifier.');
        }
        if (suiteCaseIds.has(id)) {
            throw new Error(`The suite in that file lists test case "${id}" more than once.`);
        }
        suiteCaseIds.add(id);
    }
    const caseIds = collectUniqueIds(payload.cases, 'test case');
    if (caseIds.size !== suiteCaseIds.size || [...caseIds].some(id => !suiteCaseIds.has(id))) {
        throw new Error('Every test case in that file must belong to the imported suite, with no missing cases.');
    }
    const suite = migrateSuite(payload.suite);
    if (!suite) {
        throw new Error('The suite in that file could not be read.');
    }
    const cases = payload.cases.map((value, index) => importCase(value, index, regex));
    const rawRuns = Array.isArray(payload.baselineRuns) ? payload.baselineRuns : [];
    collectUniqueIds(rawRuns, 'baseline run');
    const baselineRuns = rawRuns.map(importRun);
    const rawPresets = payload.presets ?? [];
    collectUniqueIds(rawPresets, 'preset draft');
    const presets = rawPresets.map(importDraft);

    const baselineIds = new Set();
    const baselineCases = new Map();
    for (const [caseId, runId] of Object.entries(payload.suite.baselines)) {
        if (!suiteCaseIds.has(caseId) || typeof runId !== 'string' || !runId.trim()) {
            throw new Error('The suite in that file contains an invalid baseline pointer.');
        }
        if (baselineIds.has(runId)) {
            throw new Error(`Baseline run "${runId}" is assigned more than once.`);
        }
        baselineIds.add(runId);
        baselineCases.set(runId, caseId);
    }
    if (payload.kind === KIND.SUITE && baselineIds.size) {
        throw new Error('That suite-only file unexpectedly contains baseline pointers.');
    }
    if (payload.kind === KIND.SUITE_WITH_BASELINES && (!baselineRuns.length || !baselineIds.size)) {
        throw new Error('That baseline export does not contain complete baseline data.');
    }
    const runIds = new Set(baselineRuns.map(run => run.id));
    if (runIds.size !== baselineIds.size || [...runIds].some(id => !baselineIds.has(id))) {
        throw new Error('Every baseline run in that file must be referenced by the suite, with no missing runs.');
    }
    for (const run of baselineRuns) {
        if (!suiteCaseIds.has(run.caseId) || baselineCases.get(run.id) !== run.caseId) {
            throw new Error(`Baseline run "${run.id}" does not belong to its suite baseline.`);
        }
    }

    // Fresh identifiers, with old ones mapped across so the suite still points
    // at its own cases and baselines.
    const suiteId = newId();
    const caseIdMap = new Map();
    const importedCases = cases.map((item) => {
        const id = newId();
        caseIdMap.set(item.id, id);
        return { ...item, id };
    });

    const runIdMap = new Map();
    const suiteRunIdMap = new Map();
    const importedRuns = baselineRuns.map((run) => {
        const id = newId();
        runIdMap.set(run.id, id);
        if (run.suiteRunId && !suiteRunIdMap.has(run.suiteRunId)) {
            suiteRunIdMap.set(run.suiteRunId, newId());
        }
        return {
            ...run,
            id,
            suiteId,
            suiteRunId: run.suiteRunId ? suiteRunIdMap.get(run.suiteRunId) : '',
            caseId: caseIdMap.get(run.caseId),
        };
    });

    const baselines = {};
    for (const [oldCaseId, oldRunId] of Object.entries(suite.baselines ?? {})) {
        const caseId = caseIdMap.get(oldCaseId);
        const runId = runIdMap.get(oldRunId);
        if (caseId && runId) {
            baselines[caseId] = runId;
        }
    }

    return {
        suite: normalizeSuite({
            ...suite,
            id: suiteId,
            caseIds: suite.caseIds.map(id => caseIdMap.get(id)),
            baselines,
        }),
        cases: importedCases,
        baselineRuns: importedRuns,
        presets: presets.map(draft => normalizeDraft({ ...draft, id: newId(), publishedAs: '' })),
    };
}

/** Offers a file to the browser for download. */
export function downloadExport(fileName, text, mimeType = 'application/json') {
    if (typeof globalThis.Blob !== 'function' || typeof document === 'undefined') {
        throw new Error('This browser cannot download files.');
    }
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function suggestedFileName(suite) {
    const safe = String(suite?.name ?? 'suite')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'suite';
    return `prompting-lab-${safe}.json`;
}
