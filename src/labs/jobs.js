import { validateOwner, getJob } from '../jobs/store.js';
import { registerHandler, noteOwner } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { isNativeLorebook } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { admitLabJob, finalizeLabSubmission, finishLabJob, labError, readLabRecord, withLabRecord } from './store.js';
import { captureDistillPlan, runDistill } from './distill.js';
import { captureLabApply, captureLabBook, applyLabBook } from './books.js';
import { computeLab } from './compute.js';
import { captureWorldInfoLab, runWorldInfoLab } from './world-info.js';
import { captureWorldInfoCase, captureWorldInfoTests, runWorldInfoTests } from './world-info-cases.js';
import { capturePromptingRequests, runPromptingRequests } from './prompting-requests.js';
import { capturePromptingStorage, runPromptingStorage } from './prompting-storage.js';
import { capturePromptingSuite, runPromptingSuite } from './prompting-suites.js';
import { capturePromptingScene, runPromptingScene } from './prompting-scenes.js';
import { capturePromptingPublish, runPromptingPublish } from './prompting-publish.js';
import { capturePromptingTransfer, runPromptingTransfer } from './prompting-transfer.js';
import { capturePromptingEmbed, capturePromptingEmbedApply, runPromptingEmbed, runPromptingEmbedApply } from './prompting-embed.js';

const definitions = new Map();
export function registerLab(kind, definition) {
    if (definitions.has(kind)) throw new Error(`Duplicate native Lab: ${kind}`);
    definitions.set(kind, definition);
    registerHandler(`labs.${kind}`, context => runLabJob(context));
}

export function labAccount(request) {
    const owner = validateOwner(request.user?.profile?.handle);
    if (request.get?.('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== owner) throw labError('The signed-in Labs account changed.');
    const base = { owner, directories: request.user.directories };
    const account = withRoleplayAccount(base, null, (_lease, stamp) => stamp);
    return { base, account };
}

export async function acceptLabJob(request, body = {}) {
    const { key, kind, ...input } = body;
    if (typeof key !== 'string' || !key || key.length > 200) throw labError('A Labs operation key is required.', 400);
    const definition = definitions.get(kind);
    if (!definition) throw labError('That native Lab is not available.', 400);
    const { base, account } = labAccount(request);
    const existing = readLabRecord(base, key);
    if (existing) {
        if (existing.requestHash !== roleplayHash({ kind, input })) throw labError('This operation key already names different Labs work.');
        if (existing.state !== 'preparing') {
            const job = existing.jobId ? getJob(base.directories, existing.jobId) : null;
            if (job) finalizeLabSubmission({ ...base, job });
            noteOwner(base.owner);
            return { created: false, job: job && getJob(base.directories, job.id), record: existing };
        }
    }
    const plan = existing?.plan ?? await definition.capture(base, account, input);
    const accepted = admitLabJob(base, account, { key, kind, input, plan, label: definition.label,
        applyTarget: kind === 'apply' ? { kind: 'world-info', id: plan.target.name } : definition.target?.(plan) ?? null });
    if (accepted.job) finalizeLabSubmission({ ...base, job: accepted.job });
    noteOwner(base.owner);
    return { ...accepted, job: accepted.job && getJob(base.directories, accepted.job.id) };
}

export async function runLabJob(context, dependencies = {}) {
    const record = withLabRecord(context, ({ value }) => value);
    if (record.state === 'completed') return { result: { key: record.key, resultHash: record.resultHash } };
    if (record.state === 'refused') throw labError(record.error || 'This reviewed change was refused.');
    context.signal.throwIfAborted();
    if (record.kind === 'apply') {
        try { applyLabBook(context, dependencies); } catch (error) {
            if (error.status === 409) withLabRecord(context, ({ value, save }) => {
                if (!Object.keys(value.effects).length) { value.state = 'refused'; value.error = error.message; save(); }
            });
            throw error;
        }
    } else {
        const definition = definitions.get(record.kind);
        let result = definition.resultInRecord ? undefined : readArtifact(context.directories, context.job.id, 'result');
        if (result === undefined) {
            try {
                result = JSON.parse(JSON.stringify(await definition.run(context, record.plan, dependencies)));
            } catch (error) {
                if (error.labRefused === true) withLabRecord(context, ({ value, save }) => {
                    value.state = 'refused'; value.error = error.message; save();
                });
                throw error;
            }
            if (!definition.resultInRecord) writeArtifact(context.directories, context.job.id, 'result', result);
        }
        // Finish known work even when Stop arrived during its publication.
        finishLabJob(context, result);
    }
    const completed = withLabRecord(context, ({ value }) => value);
    return { result: { key: completed.key, resultHash: completed.resultHash } };
}

registerLab('distill', { label: 'Distill saved chat into proposals', capture: captureDistillPlan,
    run: (context, _plan, dependencies) => runDistill(context, dependencies) });
registerLab('apply', { label: 'Apply reviewed Labs changes', capture: captureLabApply });
registerLab('prompting.requests', { label: 'Compare prompts and model replies', capture: capturePromptingRequests, run: runPromptingRequests });
registerLab('prompting.storage', { label: 'Save Prompting Lab records', capture: capturePromptingStorage, run: runPromptingStorage });
registerLab('prompting.suite', { label: 'Run saved prompt tests', capture: capturePromptingSuite, run: runPromptingSuite });
registerLab('prompting.preflight', { label: 'Check saved prompt test sources', capture: capturePromptingSuite, run: (_context, plan) => plan.report });
registerLab('prompting.scene', { label: 'Compare complete scenes', capture: capturePromptingScene, run: runPromptingScene });
registerLab('prompting.publish', { label: 'Publish reviewed preset draft', capture: capturePromptingPublish, run: runPromptingPublish,
    target: plan => ({ kind: 'preset', id: plan.target.relative }) });
registerLab('prompting.transfer', { label: 'Transfer saved prompt tests', capture: capturePromptingTransfer, run: runPromptingTransfer,
    resultInRecord: true });
registerLab('prompting.embed', { label: 'Prepare character test definitions', capture: capturePromptingEmbed, run: runPromptingEmbed });
registerLab('prompting.embed-apply', { label: 'Save reviewed tests into a character card', capture: capturePromptingEmbedApply,
    run: runPromptingEmbedApply, target: plan => ({ kind: 'character', id: plan.avatar }) });
registerLab('world-info.case', { label: 'Prepare saved test changes', capture: captureWorldInfoCase, run: (_context, plan) => plan });
registerLab('world-info.tests', { label: 'Run saved lorebook tests', capture: captureWorldInfoTests, run: runWorldInfoTests });
for (const kind of ['world-info.batch', 'world-info.scan', 'world-info.health']) registerLab(kind, {
    label: { 'world-info.batch': 'Preview lorebook batch changes', 'world-info.scan': 'Scan saved lorebooks', 'world-info.health': 'Check lorebook health' }[kind],
    capture: (base, account, input) => captureWorldInfoLab(base, account, input, kind),
    run: (context, plan) => runWorldInfoLab(context, plan, kind),
});
registerLab('lorestitch', { label: 'Prepare LoreStitch changes', capture: (base, account, input) => {
    if (!['replace', 'delimit', 'merge'].includes(input.operation) || !input.options || typeof input.options !== 'object') throw labError('Choose a LoreStitch operation.', 400);
    const target = captureLabBook(base, account, input.book);
    if (input.revision !== target.revision) throw labError('The lorebook changed before this preview was submitted.');
    let incoming = null;
    if (input.operation === 'merge') {
        incoming = input.incomingBook ? captureLabBook(base, account, input.incomingBook) : { book: input.incoming };
        if (!isNativeLorebook(incoming.book)) throw labError('The incoming lorebook is invalid.', 400);
    }
    return { target, operation: input.operation, options: structuredClone(input.options), incoming };
}, run: async (context, plan) => ({ ...await computeLab('lorestitch', plan, context.signal), target: plan.target, operation: plan.operation }) });
