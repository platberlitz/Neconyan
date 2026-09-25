import path from 'node:path';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, captureRoleplaySourceLocked, captureRoleplayStorageSourceLocked,
    readRoleplayEntityLocked } from './roleplay-source.js';
import { captureRoleplayWorldInfo } from './world-info.js';
import { readNativeMediaJobProof, withNativeMediaReceipt } from './media-jobs.js';
import { assertAuthoringEvidence } from '../authoring-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';

function invalid(message) { throw roleplayError('ROLEPLAY_WORKFLOW_LINEAGE', message, 409); }

/** Only permanent child write proofs can advance the parent source or its bound books. */
export function captureWorkflowToolLineage(context, { parent, candidate, turn, index = null, calls, results, previousSource }) {
    if (index !== null && (!Number.isSafeInteger(index) || index < 0 || index >= calls.calls.length)) {
        invalid('The saved tool lineage index is invalid.');
    }
    const key = `roleplay-workflow-lineage:${turn}${index === null ? '' : `:${index}`}`;
    const identity = roleplayHash({ parentIntentHash: roleplayHash(parent.intent), candidateHash: candidate.candidate.hash,
        callsHash: calls.hash, results: results.map(result => ({ childJobId: result.childJobId,
            callId: result.call.id, resultHash: roleplayHash(result.result) })) });
    const saved = readArtifact(context.directories, parent.id, key);
    if (saved !== undefined) {
        const { hash, ...value } = saved;
        if (hash !== roleplayHash(value) || value.identity !== identity
            || value.beforeSourceHash !== roleplayHash(previousSource) || value.account.accountId !== parent.intent.media.accountId
            || value.account.dataEpoch !== parent.intent.media.dataEpoch) invalid('The accepted workflow source advancement changed.');
        return saved;
    }
    const base = { owner: context.owner, directories: context.directories };
    const account = { accountId: parent.intent.media.accountId, dataEpoch: parent.intent.media.dataEpoch };
    const notebookWrites = results.filter(result => result.call.name === 'Pathfinder_Notebook' && result.result?.write);
    const latest = notebookWrites.at(-1)?.result.write;
    if (latest && (typeof latest.rawHash !== 'string' || !latest.instanceId || !Number.isSafeInteger(latest.revision))) {
        invalid('The owned notebook write cannot prove its new chat source.');
    }
    const currentParent = getJob(context.directories, parent.id);
    const files = [];
    for (const result of results) {
        const child = getJob(context.directories, result.childJobId);
        if (!child || child.owner !== context.owner || child.parentId !== parent.id
            || !currentParent?.children.includes(child.id)) invalid('The finished tool does not belong to this workflow.');
        if (!child.intent.media) continue;
        const proof = readNativeMediaJobProof(base, account, { operationKey: child.intent.media.operationKey,
            jobId: child.id, intentHash: roleplayHash(child.intent) });
        if (!proof || roleplayHash(proof.result) !== roleplayHash(result.result)) invalid('The finished tool result changed.');
        for (const effect of Object.values(proof.effects)) {
            if (effect.staged?.after && effect.relative) {
                files.push({ childJobId: child.id, relative: effect.relative, before: effect.before,
                    after: effect.staged.after, kind: 'authoring' });
            } else if (effect.after && effect.id && effect.rawHash) {
                files.push({ childJobId: child.id, relative: path.join('characters', effect.id),
                    after: { rawHash: effect.rawHash, physical: effect.after }, kind: 'character', avatar: effect.id });
            }
        }
    }
    if (!latest && !files.length) return null;
    const afterByFile = new Map();
    for (const file of files) {
        const prior = afterByFile.get(file.relative);
        if (prior && roleplayHash(prior.after) !== roleplayHash(file.before)) {
            invalid('The owned tool file changes are not consecutive.');
        }
        afterByFile.set(file.relative, file);
    }
    const source = withNativeMediaReceipt(context, ({ lease }) => {
        const storage = captureRoleplayStorageSourceLocked(lease, previousSource.locator).source;
        if (latest) {
            if (storage.rawHash !== latest.rawHash || storage.instanceId !== latest.instanceId || storage.revision !== latest.revision) {
                invalid('The current chat is not the saved result of this owned notebook tool.');
            }
        } else if (storage.rawHash !== previousSource.rawHash || storage.instanceId !== previousSource.instanceId
            || storage.revision !== previousSource.revision) {
            invalid('The workflow chat changed without an owned notebook write.');
        }
        for (const file of afterByFile.values()) {
            if (file.kind === 'authoring') {
                assertAuthoringEvidence(lease, path.join(context.directories.root, file.relative), file.after);
            } else {
                const character = readRoleplayEntityLocked(lease, 'character', file.avatar);
                if (character.rawHash !== file.after.rawHash || roleplayHash(character.physical) !== roleplayHash(file.after.physical)) {
                    invalid('The owned character file no longer matches its saved result.');
                }
            }
        }
        const captured = captureRoleplaySourceLocked(lease, { locator: previousSource.locator,
            ...(previousSource.groupId ? { groupId: previousSource.groupId } : {}),
            ...(previousSource.message ? { message: previousSource.message.index } : {}),
            ...(previousSource.range ? { range: previousSource.range } : {}) }).source;
        if (captured.instanceId !== previousSource.instanceId || roleplayHash(captured.dependencies) !== roleplayHash(previousSource.dependencies)
            || roleplayHash(captured.message ?? null) !== roleplayHash(previousSource.message ?? null)
            || roleplayHash(captured.range ?? null) !== roleplayHash(previousSource.range ?? null)) {
            invalid('A chat or character source other than the owned notebook result changed.');
        }
        return captured;
    }, { checkSource: false });
    const admitted = candidate.child.intent.request.worldInfo;
    const worldInfo = captureRoleplayWorldInfo(base, account, source, { avatar: admitted.avatar,
        maxContext: admitted.maxContext, tokenizer: admitted.tokenizer,
        trigger: admitted.global.trigger, serverPrompt: true,
        nativeBindingVersion: admitted.nativeBindingVersion });
    const record = { identity, beforeSourceHash: roleplayHash(previousSource), source, worldInfo, account,
        effectsHash: roleplayHash(files), ...(index === null ? {} : { index }) };
    if (Buffer.byteLength(JSON.stringify(record)) > 4 * 1024 * 1024) invalid('The saved workflow source advancement exceeds its reserved capacity.');
    withNativeMediaReceipt(context, ({ lease }) => {
        assertRoleplaySourceLocked(lease, source);
        writeArtifact(context.directories, parent.id, key, { ...record, hash: roleplayHash(record) });
    }, { checkSource: false });
    return { ...record, hash: roleplayHash(record) };
}
