import { randomUUID } from 'node:crypto';
import { roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { createRoleplayChatCounter, createRoleplayTextCounter } from '../generation/roleplay-budget.js';
import { getCounter } from '../mewmory/tokens.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { createRun } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/schema.js';
import { STATUS, DEFAULT_SETTINGS } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js';
import { hasCanonicalCapture } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/message-content.js';
import { promptingMemory, readPromptingDatabaseLocked, publishPromptingRuns } from './prompting-storage.js';
import { capturePromptingContext, promptingMaterial } from './prompting-context.js';
import { computeLab } from './compute.js';
import { labError, withLabRecord } from './store.js';
import { promptingMemoryPreparation } from './prompting-memory.js';
import { prepareRoleplayCapabilities } from '../generation/roleplay-capabilities.js';

const usableBaseline = (run, id) => run?.caseId === id && hasCanonicalCapture(run) && ![STATUS.ERROR, STATUS.SKIPPED].includes(run.status);

export async function promptingTokenCounter(context, plan, material) {
    const base = { directories: context.directories, owner: context.owner };
    if (material.backend && material.backend !== 'chat') return createRoleplayTextCounter(base, material, { signal: context.signal });
    material.labCapabilities = await prepareRoleplayCapabilities(context, material, plan.binding,
        { artifactName: `prompting-capabilities:${roleplayHash(plan.binding)}` });
    const chatCount = await createRoleplayChatCounter(material, { images: plan.snapshot.images, models: material.labCapabilities.models });
    const textCount = (await getCounter(chatCount.tokenizer.tokenizerKey)).count;
    return Object.assign(value => Array.isArray(value) ? chatCount(value) : textCount(value), { tokenizer: chatCount.tokenizer });
}

export async function capturePromptingSuite(base, account, input) {
    const database = withRoleplayAccount(base, account, readPromptingDatabaseLocked);
    const { storage } = promptingMemory(database.value.data);
    const suite = await storage.getSuite(input.suiteId);
    if (!suite) throw labError('The saved test suite no longer exists.');
    const ids = input.caseIds ?? suite.caseIds;
    if (!Array.isArray(ids) || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => !suite.caseIds.includes(id))) {
        throw labError('Choose saved cases belonging to this suite.', 400);
    }
    const setups = input.setups ?? [null];
    if (!Array.isArray(setups) || !setups.length || setups.length > 16 || ids.length * setups.length > 500) throw labError('This setup comparison is too large.', 400);
    const suiteRunId = randomUUID(), cases = [], runnable = [], blocked = [];
    for (const id of ids) {
        const original = await storage.getCase(id);
        if (!original) {
            const reason = 'The saved test case no longer exists.';
            blocked.push({ caseId: id, caseName: id, reason });
            cases.push({ run: { id: randomUUID(), suiteRunId, suiteId: suite.id, caseId: id, caseName: id,
                variantLabel: '', startedAt: new Date().toISOString() }, error: reason });
            continue;
        }
        for (const setup of setups) {
            const testCase = structuredClone(original);
            if (setup) {
                if (setup.presetName) testCase.pins.presets = [...testCase.pins.presets.filter(ref => ref.apiId !== setup.presetApiId),
                    { apiId: setup.presetApiId, name: setup.presetName }];
                if (setup.connectionProfileId) testCase.pins.connectionProfileId = setup.connectionProfileId;
                testCase.variantLabel = [setup.presetName, setup.profileName].filter(Boolean).join(' · ') || 'As the test case is saved';
            }
            const run = { id: randomUUID(), suiteRunId, suiteId: suite.id, caseId: id, caseName: original.name,
                variantLabel: testCase.variantLabel ?? '', startedAt: new Date().toISOString() };
            try {
                const captured = capturePromptingContext(base, account, testCase.pins);
                const baseline = await storage.getRun(suite.baselines?.[id] ?? '');
                cases.push({ context: captured, testCase, run, baseline: usableBaseline(baseline, id) ? baseline : null });
                if (!runnable.some(item => item.id === id)) runnable.push(original);
            } catch (error) {
                const reason = String(error.message);
                cases.push({ run, error: reason }); blocked.push({ caseId: id, caseName: original.name, reason });
            }
        }
    }
    return { suiteRunId, suite, cases, report: { cases: runnable, runnable, blocked, charactersWithoutChats: [],
        unsavedPresetEdits: false, unsavedPresetEditsCertain: true }, retention: Math.max(1, Math.min(200,
        Number(cases.find(item => item.context)?.context.settings.runRetention) || DEFAULT_SETTINGS.runRetention)) };
}

export async function runPromptingSuite(context, plan, { beforeRunsPublish } = {}) {
    const runs = [];
    for (const [index, item] of plan.cases.entries()) {
        context.signal.throwIfAborted();
        await context.progress({ stage: `Testing ${item.run.caseName}`, completed: index, total: plan.cases.length });
        const artifact = `prompting-run:${index}`;
        let run = readArtifact(context.directories, context.job.id, artifact);
        if (run === undefined) {
            try {
                if (item.error) throw labError(item.error);
                withLabRecord(context, () => {});
                const material = promptingMaterial(context.directories, item.context);
                const tokenCount = await promptingTokenCounter(context, item.context, material);
                run = await computeLab('prompting.run', { ...item, material, userMessage: item.testCase.userMessage }, context.signal,
                    { tokenCount, prepareMemory: promptingMemoryPreparation(context, item.context, tokenCount.tokenizer) });
            } catch (error) {
                context.signal.throwIfAborted();
                run = createRun({ ...item.run, status: STATUS.ERROR, error: { message: error.message, stack: '' } });
            }
            writeArtifact(context.directories, context.job.id, artifact, run);
        }
        runs.push(run);
    }
    const summary = Object.fromEntries([...Object.values(STATUS).map(status => [status, runs.filter(run => run.status === status).length]), ['total', runs.length]]);
    const result = { suiteRunId: plan.suiteRunId, runs, summary, aborted: false, restoreProblems: [] };
    beforeRunsPublish?.();
    await publishPromptingRuns(context, runs, result, plan.retention);
    await context.progress({ stage: 'Test results saved', completed: runs.length, total: runs.length });
    return result;
}
