import path from 'node:path';
import { createHash } from 'node:crypto';
import { EMBED_KEY, EMBED_VERSION, LEGACY_EMBED_KEY } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js';
import { adoptEmbeddedCases, readEmbeddedValue, stripForEmbedding } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/embed.js';
import { readRoleplayFile, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { readRoleplayEntityLocked } from '../generation/roleplay-source.js';
import { commitRoleplayLifecycleLocked } from '../roleplay-lifecycle.js';
import { write as writeCard } from '../character-card-parser.js';
import { readPromptingDatabaseLocked, promptingMemory, runPromptingStorage } from './prompting-storage.js';
import { labError, readLabRecord, withLabRecord } from './store.js';

const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function capturePromptingEmbed(base, account, input) {
    if (!['preview', 'adopt'].includes(input.operation) || typeof input.avatar !== 'string'
        || path.basename(input.avatar) !== input.avatar || !input.avatar.endsWith('.png')) throw labError('Choose a character card and test operation.', 400);
    const database = withRoleplayAccount(base, account, lease => readPromptingDatabaseLocked(lease).value);
    const { storage } = promptingMemory(database.data);
    const suite = await storage.getSuite(input.suiteId);
    if (!suite) throw labError('The selected suite no longer exists.');
    const source = withRoleplayAccount(base, account, lease => {
        const entity = readRoleplayEntityLocked(lease, 'character', input.avatar, { storage: true });
        if (entity.changed) saveRoleplayAccount(lease);
        return entity;
    });
    const stored = source.data.data?.extensions?.[EMBED_KEY] ?? source.data.extensions?.[EMBED_KEY]
        ?? source.data.data?.extensions?.[LEGACY_EMBED_KEY] ?? source.data.extensions?.[LEGACY_EMBED_KEY];
    if (Number(stored?.v) > EMBED_VERSION) throw labError('The character carries newer Prompting Lab data.');
    if (input.operation === 'adopt') return { operation: 'adopt', revision: database.revision, suite,
        cases: adoptEmbeddedCases(readEmbeddedValue(stored), input.avatar, { safetyProblem: () => null }) };
    const savedCases = await Promise.all(suite.caseIds.map(id => storage.getCase(id)));
    if (savedCases.some(item => !item)) throw labError('A saved test case in this suite no longer exists. Review the suite before embedding it.');
    const cases = savedCases.filter(item => item.pins.characterAvatar === input.avatar);
    if (!cases.length) throw labError('This suite has no tests for that character.');
    const payload = { v: EMBED_VERSION, cases: cases.map(stripForEmbedding) };
    return { operation: 'preview', avatar: input.avatar, source: { rawHash: source.rawHash, physical: source.physical },
        payload, count: cases.length, previousCount: readEmbeddedValue(stored).length, size: Buffer.byteLength(JSON.stringify(payload)) };
}

export function runPromptingEmbed(context, plan, dependencies) {
    return plan.operation === 'adopt' ? runPromptingStorage(context,
        { revision: plan.revision, method: 'adoptCases', args: [plan.suite, plan.cases] }, dependencies) : plan;
}

export function capturePromptingEmbedApply(base, _account, input) {
    const record = readLabRecord(base, input.proposalKey);
    if (record?.kind !== 'prompting.embed' || record.state !== 'completed' || record.plan.operation !== 'preview'
        || record.resultHash !== input.resultHash) throw labError('The reviewed character test proposal is unavailable.');
    return { ...record.result, proposalKey: record.key, proposalHash: record.resultHash };
}

export function runPromptingEmbedApply(context, plan, { afterCardPublication } = {}) {
    context.signal.throwIfAborted();
    return withLabRecord(context, ({ lease, value, save }) => {
        if (value.effects.card?.state === 'done') return value.effects.card.result;
        const { state, scope } = roleplayLease(lease);
        // The proposal, rather than an individual apply attempt, owns the permanent mutation identity.
        const operationKey = `labs-card:${plan.proposalKey}`;
        const keyHash = roleplayHash([state.accountId, 'lifecycle', operationKey]);
        const recorded = state.submissions[keyHash] || state.pending?.operationKeyHash === keyHash;
        let bytes = Buffer.alloc(0);
        if (!recorded) {
            if (state.pending) throw labError('An earlier protected operation needs recovery.');
            const source = readRoleplayEntityLocked(lease, 'character', plan.avatar, { storage: true });
            if (source.rawHash !== plan.source.rawHash || roleplayHash(source.physical) !== roleplayHash(plan.source.physical)) {
                throw Object.assign(labError('The character changed after this proposal was reviewed.'), { labRefused: true });
            }
            if (source.changed) saveRoleplayAccount(lease);
            const card = structuredClone(source.data);
            card.data ??= {};
            card.data.extensions ??= {};
            card.data.extensions[EMBED_KEY] = plan.payload;
            delete card.data.extensions[LEGACY_EMBED_KEY];
            const original = readRoleplayFile(path.join(scope.directories.characters, plan.avatar), 64 * 1024 * 1024);
            bytes = writeCard(original.bytes, JSON.stringify(card));
            const rawHash = bytesHash(bytes);
            if (value.effects.card && value.effects.card.rawHash !== rawHash) throw labError('The prepared character output changed.');
            if (!value.effects.card) { value.effects.card = { state: 'prepared', rawHash }; save(); }
        }
        const result = { avatar: plan.avatar, count: plan.count, proposalKey: plan.proposalKey };
        commitRoleplayLifecycleLocked(lease, { operationKey, action: 'character-update', intent: { proposalHash: plan.proposalHash },
            steps: [{ op: 'update', kind: 'character', locator: { avatar: plan.avatar }, bytes }] });
        afterCardPublication?.();
        value.effects.card = { ...value.effects.card, state: 'done', result };
        save();
        return result;
    });
}
