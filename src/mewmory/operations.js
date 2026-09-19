import { acceptJob, listJobs, setJobResume, validateOwner } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { providerStep, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { fail, hash, object, text } from './core.js';
import { generationFingerprint } from './context.js';
import { callJsonRole, embed, readConfig, roleVersion } from './models.js';
import { addUsage } from './processing.js';
import { recall } from './retrieval.js';
import { searchDocuments, updateIndex } from './search.js';
import { loadCurrentState } from './sources.js';
import { mutateState, normalizeLocator } from './store.js';

const types = new Set(['recall', 'index']);
const targetFor = (locator, branchId) => ({ kind: 'mewmory', id: hash(locator), branchId });

export async function startOperation(directories, owner, operation, body) {
    validateOwner(owner);
    if (!types.has(operation)) fail('Unknown Mewmory operation.');
    const locator = normalizeLocator(body.locator);
    const intent = operation === 'index' ? { locator, reset: body.reset === true }
        : { locator, query: text(body.query || '', 'Search', 6000, true), tokenizer: body.tokenizer || {} };
    if (operation === 'recall') object(intent.tokenizer, 'Tokenizer');
    const key = text(body.submissionKey, 'Submission key', 256);
    const previous = listJobs(directories, { owner, includeDismissed: true }).find(job => job.submissionKey === key);
    if (previous) {
        if (previous.type !== 'mewmory.' + operation || hash(previous.intent) !== hash(intent)) fail('This submission key was already used for different work.', 409);
        return { job: previous, created: false };
    }
    const state = await loadCurrentState(directories, locator);
    const config = readConfig(directories);
    const accepted = acceptJob(directories, { owner, type: 'mewmory.' + operation, submissionKey: key,
        intent, target: targetFor(locator, state.branchId),
        config: { fingerprint: generationFingerprint(state, config), revision: config.revision },
        label: operation === 'index' ? 'Rebuild memory search index' : 'Recall memory',
    });
    noteOwner(owner);
    return accepted;
}

function assertCurrent(state, config, job) {
    if (hash(job.target) !== hash(targetFor(state.locator, state.branchId))
        || !state.enabled || job.config?.revision !== config.revision
        || (job.type !== 'mewmory.index' && job.config?.fingerprint !== generationFingerprint(state, config))) {
        fail('The story or memory settings changed. Start a new operation for the current version.', 409);
    }
}

export function registerMewmoryOperations({ call = callJsonRole, embedFn = embed } = {}) {
    const run = async context => {
        const { directories, job, signal, progress } = context;
        const locator = normalizeLocator(job.intent.locator);
        const completed = readArtifact(directories, job.id, 'result');
        if (completed !== undefined) return { artifact: true };
        const config = readConfig(directories);
        let state = await loadCurrentState(directories, locator);
        assertCurrent(state, config, job);
        signal.throwIfAborted();
        const checkedCall = async (key, perform) => {
            assertCurrent(await loadCurrentState(directories, locator), readConfig(directories), job);
            return providerStep(context, key, perform);
        };
        const providers = {
            call: (dirs, settings, role, system, input, options) => checkedCall(hash([role, system, input, options.dataTypes]),
                () => call(dirs, settings, role, system, input, options)),
            embedFn: (dirs, settings, inputs, options) => checkedCall(hash(['embedding', inputs, options.query, options.dataTypes]),
                () => embedFn(dirs, settings, inputs, options)),
        };
        // Only this server checkpoint, never a client field, permits safe restart.
        setJobResume(directories, job.id, 'mewmory');
        let result;
        if (job.type === 'mewmory.recall') {
            await progress({ stage: 'recall' });
            result = await recall(directories, locator, { query: job.intent.query, tokenizer: job.intent.tokenizer,
                signal, operationId: job.id }, providers);
        } else if (job.type === 'mewmory.index') {
            if (state.indexOperation !== job.id) {
                state = mutateState(directories, locator, current => {
                    assertCurrent(current, readConfig(directories), job);
                    if (job.intent.reset) current.index = { version: '', vectors: {}, pending: true };
                    current.indexOperation = job.id;
                }, state.revision);
            }
            do {
                signal.throwIfAborted();
                state = await loadCurrentState(directories, locator);
                assertCurrent(state, readConfig(directories), job);
                result = await updateIndex(state, directories, config, { signal, embedFn: providers.embedFn });
                signal.throwIfAborted();
                await loadCurrentState(directories, locator);
                mutateState(directories, locator, current => {
                    assertCurrent(current, readConfig(directories), job);
                    if (current.indexOperation !== job.id) fail('The search index changed during this operation. Start a new rebuild.', 409);
                    // Keep paid vectors for unchanged documents, even when new messages arrive.
                    const version = roleVersion(config, 'embedding');
                    const vectors = index => index.version === version ? index.vectors : index.build?.version === version ? index.build.vectors : {};
                    const combined = { ...vectors(current.index), ...vectors(state.index) };
                    const documents = searchDocuments(current).filter(document => config.roles.embedding.allowedData.includes(document.dataType));
                    const valid = Object.fromEntries(documents.filter(document => combined[document.id]?.textHash === hash(document.searchText))
                        .map(document => [document.id, combined[document.id]]));
                    result.remaining = config.roles.embedding.enabled ? documents.length - Object.keys(valid).length : 0;
                    current.index = { version, vectors: valid, pending: result.remaining > 0 };
                    addUsage(current, result.usage);
                }, undefined, { existingOnly: true });
                await progress({ stage: 'index', completed: 0, total: result.remaining });
            } while (result.remaining > 0);
            result = { remaining: 0 };
        } else fail('Unknown Mewmory operation.');
        writeArtifact(directories, job.id, 'result', result);
        return { artifact: true, warning: result.inspection?.error || result.inspection?.indexError || null };
    };
    registerHandler('mewmory.recall', run);
    registerHandler('mewmory.index', run);
}

registerMewmoryOperations();
