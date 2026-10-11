import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';

const failure = () => roleplayError('ROLEPLAY_MACRO_RECOVERY', 'The saved macro variables do not match this Roleplay reply.', 409);
const isMap = value => value && typeof value === 'object' && !Array.isArray(value);

/** Stage the final prompt state, including provider formatting, before dispatch. */
export function prepareRoleplayMacroCommit(context, state) {
    const { job, directories } = context;
    if (job.intent.request.worldInfo?.macroPolicyVersion !== 1) return undefined;
    if (!isMap(state?.variables?.local)) throw failure();
    const prompt = readArtifact(directories, job.id, 'roleplay-prompt');
    const data = { intentHash: roleplayHash(job.intent), promptHash: prompt?.hash,
        baseline: roleplayHash(job.intent.request.worldInfo.promptVariables.local), local: state.variables.local };
    const value = { ...data, hash: roleplayHash(data) };
    if (!prompt || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw failure();
    const previous = readArtifact(directories, job.id, 'roleplay-macro-commit');
    if (previous !== undefined && roleplayHash(previous) !== roleplayHash(value)) throw failure();
    if (previous === undefined) writeArtifact(directories, job.id, 'roleplay-macro-commit', value);
    return value.hash;
}

export function roleplayMacroCommitHash(directories, job) {
    if (job.intent.request.worldInfo?.macroPolicyVersion !== 1) return undefined;
    const saved = readArtifact(directories, job.id, 'roleplay-macro-commit');
    const { hash, ...data } = saved ?? {};
    const prompt = readArtifact(directories, job.id, 'roleplay-prompt');
    if (!saved || hash !== roleplayHash(data) || data.intentHash !== roleplayHash(job.intent)
        || !prompt || data.promptHash !== prompt.hash || !isMap(data.local)
        || data.baseline !== roleplayHash(job.intent.request.worldInfo.promptVariables.local)) throw failure();
    return hash;
}

/** Runs inside the same protected chat write as the reply, after Quick Replies and before Agents. */
export function applyRoleplayMacroCommit(directories, job, records, output, baselineRecords) {
    if (job.intent.request?.worldInfo?.macroPolicyVersion !== 1) {
        if (output?.macroCommit !== undefined) throw failure();
        return;
    }
    const hash = roleplayMacroCommitHash(directories, job);
    const saved = readArtifact(directories, job.id, 'roleplay-macro-commit');
    const provider = readArtifact(directories, job.id, 'roleplay-main-provider');
    if (hash !== output?.macroCommit || provider && provider.macroCommit !== hash
        || saved.baseline !== roleplayHash(baselineRecords[0].chat_metadata?.variables ?? {})) throw failure();
    records[0].chat_metadata ??= {};
    records[0].chat_metadata.variables = structuredClone(saved.local);
}
