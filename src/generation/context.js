import { getUserDirectories } from '../users.js';
import { resolveModelProfile } from '../mewmory/connection-profiles.js';
import { validateOwner } from '../jobs/store.js';

/**
 * Explicit execution context for a job: who owns it, where the files live, what
 * it targets and which saved connection profile it may use. It carries a
 * credential reference, never a secret value. The owner is validated before any
 * directory path is built from the handle.
 */
export function createGenerationContext({ owner, target = null, credentialRef = null, config = null }) {
    const handle = validateOwner(owner);
    return {
        owner: handle,
        directories: getUserDirectories(handle),
        target,
        credentialRef,
        config,
    };
}

/**
 * Resolve the saved connection profile at execution time. A deleted, disabled
 * or broken profile produces an actionable failure; it never falls back to
 * whatever the current browser has selected.
 */
export function resolveCredential(context, { embedding = false, modelOverride = '' } = {}) {
    const profileId = context?.credentialRef?.profileId;
    if (!profileId) {
        throw Object.assign(new Error('This job has no saved connection profile to run with.'), { status: 409, code: 'JOB_PROFILE_MISSING' });
    }
    return resolveModelProfile(context.directories, profileId, embedding, modelOverride || context.credentialRef.modelOverride || '');
}
