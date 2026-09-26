import { STATUS } from './constants.js';
import { getContext, listInstalledPresets } from './host.js';
import { listPromptTagsProfiles } from './integrations/prompttags.js';
import { hasCanonicalCapture } from './message-content.js';
import { registerActiveTask } from './operations.js';
import { PRESET_API_IDS } from './presets.js';
import { runPromptingLab } from './native.js';
import * as storage from './storage.js';

function isUsableBaseline(run, caseId, { promotion = false } = {}) {
    if (!run
        || run.caseId !== caseId
        || !hasCanonicalCapture(run)
        || run.status === STATUS.ERROR
        || run.status === STATUS.SKIPPED) {
        return false;
    }
    return promotion
        ? run.status === STATUS.PASS || run.status === STATUS.CHANGED
        : true;
}

export async function getSuiteCases(suite) {
    const cases = [];
    for (const caseId of suite?.caseIds ?? []) {
        const testCase = await storage.getCase(caseId);
        if (testCase) {
            cases.push(testCase);
        }
    }
    return cases;
}

/** Checks a suite before anything is changed. */
export async function preflightSuite(suite, options = {}) {
    return runPromptingLab('preflight', { suiteId: suite.id }, options);
}

/**
 * Runs a suite end to end and stores the results.
 * @returns {Promise<object>} the runner result, with runs already saved.
 */
async function runSuiteTracked(suite, {
    signal = null,
    onProgress = null,
    cases = null,
    blocked = [],
    setups,
} = {}) {
    const caseIds = cases ? [...new Set([...cases.map(item => item.id), ...blocked.map(item => item.caseId)])] : undefined;
    return runPromptingLab('suite', { suiteId: suite.id, ...(caseIds ? { caseIds } : {}), ...(setups ? { setups } : {}) }, {
        signal, onProgress: progress => onProgress?.({ status: 'running', caseName: progress.stage.replace(/^Testing /, ''),
            index: progress.completed, total: progress.total }),
    });
}

export async function runSuite(suite, options = {}) {
    const task = registerActiveTask('suite orchestration', { signal: options.signal });
    try {
        return await runSuiteTracked(suite, { ...options, signal: task.signal });
    } finally {
        task.release();
    }
}

/* ---------------------------------------------------- setup comparison */

/** Names a setup by what it changes, for the run list to show. */
export function describeSetup(setup = {}) {
    return [setup.presetName, setup.profileName].filter(Boolean).join(' · ') || 'As the test case is saved';
}

/**
 * One test case as it would run under a different preset or connection
 * profile. The scenario itself — character, persona, message, checks — is left
 * alone, so the setup is the only difference between two of these.
 *
 * A preset replaces the pin of its own kind only: a Text Completion case pins
 * five presets, and swapping the sampler must not drop the instruct template.
 */
export function caseWithSetup(testCase, setup = {}) {
    const pins = { ...testCase?.pins };
    if (setup.presetName) {
        const apiId = setup.presetApiId ?? '';
        pins.presets = [
            ...(pins.presets ?? []).filter(ref => ref?.apiId !== apiId),
            { apiId, name: setup.presetName },
        ];
    }
    if (setup.connectionProfileId) {
        pins.connectionProfileId = setup.connectionProfileId;
    }
    return { ...testCase, pins, variantLabel: describeSetup(setup) };
}

/**
 * One row per setup: what it was, what it cost, and how its checks went.
 *
 * The first setup that produced a prompt is the point of comparison, so its own
 * difference is null rather than zero: there is nothing for it to differ from.
 */
export function summarizeSetups(runs = []) {
    const usable = (runs ?? []).filter(Boolean);
    const base = usable.find(run => isUsableBaseline(run, run?.caseId)) ?? null;
    const baseTokens = Number(base?.capture?.tokenTable?.total ?? 0);
    return usable.map((run) => {
        const results = run.assertionResults ?? [];
        const built = hasCanonicalCapture(run);
        const tokens = Number(run.capture?.tokenTable?.total ?? 0);
        return {
            runId: run.id,
            label: run.variantLabel || run.caseName || 'This setup',
            status: run.status,
            built,
            tokens,
            delta: built && run !== base ? tokens - baseTokens : null,
            passed: results.filter(result => result?.pass === true).length,
            failed: results.filter(result => result?.pass === false).length,
            unchecked: results.filter(result => result?.pass === null).length,
            error: run.error?.message ?? '',
        };
    });
}

/**
 * Builds one test case once per setup. Every run is stored against the case it
 * came from, so the comparison tab can put any two of them side by side.
 */
export async function runSetups(suite, testCase, setups, options = {}) {
    return runSuite(suite, {
        ...options,
        cases: [testCase],
        setups,
    });
}

/** Marks a run as the baseline for its case. */
export async function promoteBaseline(suite, caseId, runId) {
    const run = await storage.getRun(runId);
    if (!isUsableBaseline(run, caseId, { promotion: true })) {
        throw new Error('That run cannot be used as a baseline because it is missing, unchecked, belongs to another test case, or has no usable final prompt.');
    }
    return storage.updateSuite(suite?.id, (current) => {
        if (!(current.caseIds ?? []).includes(caseId)) {
            throw new Error('That test case no longer belongs to this suite.');
        }
        return {
            ...current,
            baselines: { ...current.baselines, [caseId]: runId },
            updatedAt: new Date().toISOString(),
        };
    });
}

/** Marks every passing run from a suite run as the baseline for its case. */
export async function promoteAllPassing(suite, runs) {
    const promotions = new Map();
    for (const run of runs) {
        if (run?.status !== STATUS.PASS && run?.status !== STATUS.CHANGED) {
            continue;
        }
        const stored = await storage.getRun(run.id);
        if (isUsableBaseline(stored, run.caseId, { promotion: true })) {
            promotions.set(run.caseId, stored.id);
        }
    }
    return storage.updateSuite(suite?.id, (current) => {
        const baselines = { ...current.baselines };
        const caseIds = new Set(current.caseIds ?? []);
        for (const [caseId, runId] of promotions) {
            if (caseIds.has(caseId)) {
                baselines[caseId] = runId;
            }
        }
        return { ...current, baselines, updatedAt: new Date().toISOString() };
    });
}

export async function clearBaseline(suite, caseId) {
    return storage.updateSuite(suite?.id, (current) => {
        if (!(current.caseIds ?? []).includes(caseId)) {
            return current;
        }
        const baselines = { ...current.baselines };
        delete baselines[caseId];
        return { ...current, baselines, updatedAt: new Date().toISOString() };
    });
}

/** Everything the case editor needs to offer real choices. */
export function readAvailableOptions(context = getContext()) {
    const characters = (context?.characters ?? [])
        .filter(character => character?.avatar)
        .map(character => ({ avatar: character.avatar, name: character.name ?? character.avatar }));

    const personas = Object.entries(context?.powerUserSettings?.personas ?? {})
        .map(([key, name]) => ({ key, name: String(name || key) }));

    const profiles = (context?.extensionSettings?.connectionManager?.profiles ?? [])
        .filter(profile => profile?.id)
        .map(profile => ({ id: profile.id, name: profile.name ?? profile.id, mode: profile.mode ?? '' }));

    const presets = {};
    for (const apiId of PRESET_API_IDS) {
        presets[apiId] = listInstalledPresets(apiId, context);
    }

    const promptTagsProfiles = listPromptTagsProfiles(context);

    return { characters, personas, profiles, presets, promptTagsProfiles };
}

export { storage };
