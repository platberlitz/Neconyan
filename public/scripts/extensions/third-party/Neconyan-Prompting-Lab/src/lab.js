import { evaluateAssertions } from './assertions.js';
import { analyzeCache } from './cache-analyzer.js';
import { compareRuns, findVolatileSpans } from './compare.js';
import { CAVEAT, DEFAULT_SETTINGS, STATUS } from './constants.js';
import { ctxOf, getContext, listInstalledPresets, stringHash } from './host.js';
import { collectIntegrations } from './integrations/index.js';
import { listPromptTagsProfiles } from './integrations/prompttags.js';
import { hasCanonicalCapture } from './message-content.js';
import { registerActiveTask } from './operations.js';
import { PRESET_API_IDS } from './presets.js';
import { runSuite as runnerRunSuite, preflight, summarize } from './runner.js';
import { createRun, resolveStatus } from './schema.js';
import { getSettings } from './settings.js';
import * as storage from './storage.js';

/**
 * Ties the runner, the checks, the comparison and storage together.
 * The tabs call into here rather than orchestrating for themselves.
 */

/**
 * Builds the analyze step handed to the runner: evaluate the case's checks,
 * work out what changes between two builds of the same prompt, and compare the
 * result against the baseline.
 */
function makeAnalyzer({ baselines, normalize, cachingAtDepth, host }) {
    return async ({ run, testCase, first, second, context }) => {
        const volatileSpans = findVolatileSpans(
            { capture: first },
            second ? { capture: second } : null,
        );

        const live = ctxOf(context);
        run.cache = analyzeCache({
            messages: first.messages ?? [],
            sections: first.sections,
            sourceTexts: first.sourceTexts,
            volatileSpans,
            cachingAtDepth,
            squashSystem: Boolean(live?.chatCompletionSettings?.squash_system_messages),
            useSysPrompt: first.useSysPrompt
                ?? live?.chatCompletionSettings?.use_sysprompt
                ?? true,
            useTools: first.useTools ?? true,
            prefillString: first.prefillString ?? '',
            names: first.promptNames ?? {},
            hash: text => stringHash(host, text),
        });
        if (run.cache.source === 'unknown' && !run.caveats.includes(CAVEAT.CACHE_DEPTH_UNKNOWN)) {
            run.caveats.push(CAVEAT.CACHE_DEPTH_UNKNOWN);
        }
        if (run.cache.source === 'manual' && !run.caveats.includes(CAVEAT.CACHE_BOUNDARY_PREDICTED)) {
            run.caveats.push(CAVEAT.CACHE_BOUNDARY_PREDICTED);
        }
        if (run.cache.squashApplied && !run.caveats.includes(CAVEAT.NO_SQUASH_LIVE)) {
            run.caveats.push(CAVEAT.NO_SQUASH_LIVE);
        }

        run.assertionResults = await evaluateAssertions(testCase?.assertions, run);

        const baseline = baselines?.get(testCase?.id) ?? null;
        if (baseline) {
            const comparison = compareRuns(run, baseline, { volatileSpans, normalize });
            run.diffVsBaseline = {
                baselineRunId: baseline.id,
                changedSections: comparison.changedSections,
                addedSections: comparison.addedSections,
                removedSections: comparison.removedSections,
                tokenDeltas: comparison.tokenDeltas,
                totalDelta: comparison.totalDelta,
                sectionOrderChanged: comparison.sectionOrderChanged,
                outboundChanged: comparison.outboundChanged,
                identical: comparison.identical,
                summary: comparison.summary,
            };
            run.status = resolveStatus({
                assertionResults: run.assertionResults,
                hasBaseline: true,
                diffIsEmpty: comparison.identical,
            });
        } else {
            run.status = resolveStatus({
                assertionResults: run.assertionResults,
                hasBaseline: false,
                diffIsEmpty: true,
            });
        }
        return run;
    };
}

/** Loads the baseline run for each case in a suite. */
async function loadBaselines(suite) {
    const baselines = new Map();
    const caseIds = new Set(suite?.caseIds ?? []);
    for (const [caseId, runId] of Object.entries(suite?.baselines ?? {})) {
        const run = await storage.getRun(runId);
        if (caseIds.has(caseId) && isUsableBaseline(run, caseId)) {
            baselines.set(caseId, run);
        }
    }
    return baselines;
}

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
export async function preflightSuite(suite, {
    context = getContext,
    chatFileChecker = undefined,
} = {}) {
    const cases = await getSuiteCases(suite);
    return {
        ...await preflight(cases, {
            context,
            ...(chatFileChecker ? { chatFileChecker } : {}),
        }),
        cases,
    };
}

/**
 * Runs a suite end to end and stores the results.
 * @returns {Promise<object>} the runner result, with runs already saved.
 */
async function runSuiteTracked(suite, {
    signal = null,
    onProgress = null,
    onStateChange = null,
    host = null,
    cases = null,
    blocked = [],
} = {}) {
    const settings = getSettings();
    const runRetention = Number.isInteger(settings.runRetention)
        ? Math.max(1, Math.min(200, settings.runRetention))
        : DEFAULT_SETTINGS.runRetention;
    const toRun = cases ?? await getSuiteCases(suite);
    const baselines = await loadBaselines(suite);

    // A case can belong to several suites, so pruning must protect every
    // suite's baselines, not only this one's. Otherwise repeatedly running
    // one suite would quietly delete the runs another suite compares against.
    const pinnedRuns = new Set(Object.values(suite?.baselines ?? {}));
    for (const other of await storage.listSuites()) {
        for (const runId of Object.values(other?.baselines ?? {})) {
            pinnedRuns.add(runId);
        }
    }

    const persist = async (run) => {
        if (run.status === STATUS.SKIPPED) {
            return;
        }
        await storage.saveRun(run);
    };

    const result = await runnerRunSuite(toRun, {
        host,
        suiteId: suite?.id ?? '',
        signal,
        onProgress,
        onStateChange,
        collectIntegrations,
        analyze: makeAnalyzer({
            baselines,
            normalize: settings.normalizeVolatile,
            cachingAtDepth: settings.manualCachingAtDepth,
            host,
        }),
        persistRun: persist,
    });

    for (const item of result.aborted ? [] : (blocked ?? [])) {
        const blockedRun = createRun({
            suiteRunId: result.suiteRunId,
            suiteId: suite?.id ?? '',
            caseId: item?.caseId ?? '',
            caseName: item?.caseName ?? '',
            status: STATUS.ERROR,
            startedAt: new Date().toISOString(),
            error: { message: String(item?.reason ?? 'This test case could not run.'), stack: '' },
        });
        await persist(blockedRun);
        result.runs.push(blockedRun);
    }
    result.summary = summarize(result.runs);

    // Keep this whole batch available to the setup comparison that requested
    // it. A later batch can prune these normally.
    if (!result.aborted) {
        const caseIds = new Set(result.runs.map(run => run?.caseId).filter(Boolean));
        for (const caseId of caseIds) {
            const currentBatch = result.runs
                .filter(run => run?.caseId === caseId && run.status !== STATUS.SKIPPED)
                .map(run => run.id);
            await storage.pruneRuns(
                caseId,
                Math.max(0, runRetention - currentBatch.length),
                [...pinnedRuns, ...currentBatch],
            );
        }
    }

    return result;
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
        cases: (setups ?? []).map(setup => caseWithSetup(testCase, setup)),
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
