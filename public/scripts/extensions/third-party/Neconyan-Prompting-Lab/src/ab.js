import { ctxOf, getContext } from './host.js';
import { runPromptingLab } from './native.js';

/** Profile choices remain local; accepted comparisons run entirely on the server. */
export function isProfileUsable(hostRef, profile) {
    const context = ctxOf(hostRef);
    if (context?.extensionSettings?.disabledExtensions?.includes?.('connection-manager')) return false;
    try { return Boolean(profile && context?.ConnectionManagerRequestService?.isProfileSupported?.(profile)); }
    catch { return false; }
}

export function listComparableProfiles(hostRef = getContext) {
    return (ctxOf(hostRef)?.extensionSettings?.connectionManager?.profiles ?? []).filter(profile => profile?.id).map(profile => ({
        id: profile.id, name: profile.name ?? profile.id, mode: profile.mode ?? '', model: profile.model ?? '',
        usable: isProfileUsable(hostRef, profile),
    }));
}

function hasPrompt(prompt) {
    return Array.isArray(prompt) ? prompt.length > 0 : Boolean(String(prompt ?? '').trim());
}

export async function sendPrompt(profileId, prompt, {
    maxTokens = 300, signal = null, onDelta = null, includePreset = true, includeInstruct = true, presetName = null,
} = {}) {
    if (!hasPrompt(prompt)) return { profileId, text: '', error: 'There is nothing to send.' };
    const result = await runPromptingLab('requests', { operation: 'send', profileId, prompt, maxTokens,
        includePreset, includeInstruct, presetName }, { signal });
    onDelta?.(result.text);
    return result;
}

export async function sendUnderProfile(run, profileId, options = {}) {
    const prompt = run?.capture?.messages ?? run?.capture?.combinedPrompt ?? '';
    if (!hasPrompt(prompt)) return { profileId, text: '', error: 'This run did not capture a prompt, so there is nothing to send.' };
    return sendPrompt(profileId, prompt, options);
}

export async function compareProfiles(run, profileIds, options = {}) {
    const ids = Array.isArray(profileIds) ? profileIds.filter(Boolean) : [];
    const hostRef = options.hostRef ?? getContext;
    const profiles = ctxOf(hostRef)?.extensionSettings?.connectionManager?.profiles ?? [];
    if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.every(id => isProfileUsable(hostRef, profiles.find(profile => profile?.id === id)))) {
        throw new Error('Choose exactly two distinct usable connection profiles.');
    }
    const prompt = run?.capture?.messages ?? run?.capture?.combinedPrompt ?? '';
    return runPromptingLab('requests', { operation: 'compare', profileIds: ids, prompt, maxTokens: options.maxTokens ?? 300 }, options);
}
