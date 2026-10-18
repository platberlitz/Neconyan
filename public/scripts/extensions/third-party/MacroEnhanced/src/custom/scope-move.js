/**
 * Safe cross-scope macro moves. A move spans at least one asynchronous card
 * write, so the source and target contexts can change while it runs. Write the
 * target first, preserve the original until the source write succeeds, and
 * never address a chat, character or global list that is no longer the one the
 * move started with.
 */
export class MoveMacroError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     * @param {boolean} [details.sourceRemoved]
     * @param {'done'|'skipped'|'failed'|'not-written'} [details.rollback]
     * @param {Error} [details.cause]
     */
    constructor(message, { sourceRemoved = false, rollback = 'skipped', cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'MoveMacroError';
        this.sourceRemoved = sourceRemoved;
        this.rollback = rollback;
    }
}

/**
 * One save at a time per editor. Returns started:false for a click that arrives
 * while another save owns the editor.
 */
export function createSaveGate() {
    let busy = false;
    return {
        get busy() {
            return busy;
        },
        async run(task) {
            if (busy) {
                return { started: false };
            }
            busy = true;
            try {
                return { started: true, value: await task() };
            } finally {
                busy = false;
            }
        },
    };
}

async function rollbackTarget({ targetScope, targetIdentity, targetDefs, defId, identityFor, readDefs, persist }) {
    if (identityFor(targetScope) !== targetIdentity) {
        return 'skipped';
    }
    try {
        const currentDefs = readDefs?.(targetScope) ?? targetDefs;
        await persist(targetScope, currentDefs.filter(def => def.id !== defId));
        return 'done';
    } catch {
        return 'failed';
    }
}

/**
 * Moves one definition from sourceScope to targetScope. The target list is
 * written first. If the source context changed before its write, or its write
 * fails, the original is left in place and the target copy is rolled back only
 * while the target context is still the one that was written.
 *
 * @param {object} options
 * @param {string} options.sourceScope
 * @param {string} options.targetScope
 * @param {string} options.defId
 * @param {object[]} options.sourceDefs - Source list without the moved def.
 * @param {object[]} options.targetDefs - Target list including the moved def.
 * @param {(scope: string) => string|null} options.identityFor - Stable context identity.
 * @param {(scope: string) => object[]} [options.readDefs] - Fresh lists after an asynchronous write.
 * @param {(scope: string, defs: object[]) => Promise<void>} options.persist
 * @returns {Promise<{targetScope: string, targetIdentity: string}>}
 */
export async function moveMacroBetweenScopes({
    sourceScope,
    targetScope,
    defId,
    sourceDefs,
    targetDefs,
    identityFor,
    readDefs,
    persist,
}) {
    const targetIdentity = identityFor(targetScope);
    const sourceIdentity = identityFor(sourceScope);
    if (!targetIdentity || !sourceIdentity) {
        throw new MoveMacroError('That scope is no longer available. The macro was not moved.', { rollback: 'not-written' });
    }
    if (identityFor(targetScope) !== targetIdentity) {
        throw new MoveMacroError('The target changed before the move started. The original macro is still in place.', { rollback: 'not-written' });
    }

    // Target first. Its list was read from this exact target context.
    await persist(targetScope, targetDefs);

    if (identityFor(sourceScope) !== sourceIdentity) {
        const rollback = await rollbackTarget({
            targetScope,
            targetIdentity,
            targetDefs,
            defId,
            identityFor,
            readDefs,
            persist,
        });
        throw new MoveMacroError(
            `The source changed during the move. The original is still there.${rollback === 'skipped' ? ' A copy may remain in the target.' : ''}`,
            { rollback },
        );
    }

    try {
        const currentDefs = readDefs?.(sourceScope) ?? sourceDefs;
        await persist(sourceScope, currentDefs.filter(def => def.id !== defId));
    } catch (error) {
        const rollback = await rollbackTarget({
            targetScope,
            targetIdentity,
            targetDefs,
            defId,
            identityFor,
            readDefs,
            persist,
        });
        throw new MoveMacroError(
            `Could not remove the original copy. It is still in the source scope.${rollback === 'done' ? ' The target copy was removed.' : ' A copy may also remain in the target.'}`,
            { rollback, cause: error },
        );
    }

    return { targetScope, targetIdentity };
}
