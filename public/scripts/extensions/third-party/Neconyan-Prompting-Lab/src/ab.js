import { ctxOf, getContext } from './host.js';

/**
 * Sends a captured prompt to one or more connection profiles and returns the
 * replies side by side.
 *
 * Everything here spends tokens, so it only ever runs when the user asks for
 * it. The request goes out under a chosen profile without switching the
 * profile the user is on, and nothing is written to any chat.
 */

/** Profile modes that can be used for a comparison. */
export function isProfileUsable(hostRef, profile) {
    const context = ctxOf(hostRef);
    if (context?.extensionSettings?.disabledExtensions?.includes?.('connection-manager')) {
        return false;
    }
    const service = context?.ConnectionManagerRequestService;
    if (!service || !profile) {
        return false;
    }
    try {
        if (typeof service.isProfileSupported === 'function') {
            return Boolean(service.isProfileSupported(profile));
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * The profiles a comparison can use, each marked with whether it is usable and
 * why not when it is not.
 */
export function listComparableProfiles(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const profiles = context?.extensionSettings?.connectionManager?.profiles ?? [];
    return profiles
        .filter(profile => profile?.id)
        .map(profile => ({
            id: profile.id,
            name: profile.name ?? profile.id,
            mode: profile.mode ?? '',
            model: profile.model ?? '',
            usable: isProfileUsable(hostRef, profile),
        }));
}

/**
 * Sends a prompt, either a message list or one long string, under one
 * profile. Every send this extension makes goes through here.
 *
 * @returns {Promise<{profileId: string, text: string, error: string|null}>}
 */
export async function sendPrompt(profileId, prompt, {
    hostRef = getContext,
    maxTokens = 300,
    signal = null,
    onDelta = null,
    includePreset = true,
    includeInstruct = true,
    presetName = null,
} = {}) {
    const context = ctxOf(hostRef);
    const service = context?.ConnectionManagerRequestService;
    if (typeof service?.sendRequest !== 'function') {
        return {
            profileId,
            text: '',
            error: 'Side-by-side replies need the Connection Manager extension, which is not available.',
        };
    }
    if (!hasPrompt(prompt)) {
        return { profileId, text: '', error: 'There is nothing to send.' };
    }

    // Streaming is only asked for when someone is watching the reply arrive.
    // Without a listener the plain request is simpler and just as complete.
    const wantsStream = typeof onDelta === 'function';
    let text = '';
    try {
        let receiver = service;
        if (presetName && typeof service.getProfile === 'function') {
            try {
                const profile = service.getProfile(profileId);
                if (profile && typeof profile === 'object') {
                    receiver = Object.create(service);
                    Object.defineProperty(receiver, 'getProfile', {
                        value: id => id === profileId
                            ? { ...profile, preset: presetName }
                            : service.getProfile(id),
                    });
                }
            } catch {
                receiver = service;
            }
        }
        const response = await receiver.sendRequest(profileId, prompt, maxTokens, {
            stream: wantsStream,
            signal,
            extractData: true,
            includePreset,
            includeInstruct,
        });
        text = wantsStream
            ? await readStream(response, (value) => {
                text = value;
                onDelta(value);
            })
            : readReply(response);
        return { profileId, text, error: text.trim() ? null : 'The model returned an empty reply.' };
    } catch (error) {
        return { profileId, text, error: describeSendError(error) };
    }
}

function hasPrompt(prompt) {
    return Array.isArray(prompt) ? prompt.length > 0 : Boolean(String(prompt ?? '').trim());
}

function readReply(response) {
    return typeof response === 'string'
        ? response
        : String(response?.content ?? response?.text ?? '');
}

/**
 * Reads a streamed reply, handing the caller the text so far every time it
 * grows. The host yields the whole reply as it stands rather than the new
 * piece, and hands back a function that starts the generator.
 */
async function readStream(response, onDelta) {
    if (typeof response !== 'function' && typeof response?.[Symbol.asyncIterator] !== 'function') {
        // A profile that cannot stream still answers; show it in one go.
        const text = readReply(response);
        onDelta(text);
        return text;
    }
    const generator = typeof response === 'function' ? response() : response;
    let text = '';
    for await (const chunk of generator) {
        text = typeof chunk === 'string' ? chunk : String(chunk?.text ?? text);
        onDelta(text);
    }
    return text;
}

/**
 * Sends one captured prompt under one profile.
 *
 * @returns {Promise<{profileId: string, text: string, error: string|null}>}
 */
export async function sendUnderProfile(run, profileId, options = {}) {
    const prompt = run?.capture?.messages ?? run?.capture?.combinedPrompt ?? '';
    if (!hasPrompt(prompt)) {
        return {
            profileId,
            text: '',
            error: 'This run did not capture a prompt, so there is nothing to send.',
        };
    }
    return sendPrompt(profileId, prompt, options);
}

function describeSendError(error) {
    const chain = [];
    const seen = new Set();
    let current = error;
    while (current != null && !seen.has(current)) {
        seen.add(current);
        chain.push({
            name: String(current?.name ?? ''),
            message: String(current?.message ?? current ?? ''),
        });
        current = current?.cause;
    }
    const details = chain.map(item => `${item.name} ${item.message}`).join('\n');
    if (/Connection Manager is not available/i.test(details)) {
        return 'The Connection Manager extension is turned off, so a profile cannot be used.';
    }
    if (/does not support chat completions/i.test(details)) {
        return 'This connection profile cannot be used to compare model replies.';
    }
    if (/aborted|AbortError/i.test(details)) {
        return 'Stopped before the model replied.';
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (chain[index].message) {
            return chain[index].message;
        }
    }
    return 'Unknown problem';
}

/**
 * Sends the same prompt under two profiles and returns both replies.
 * Requests run at the same time, so one slow backend does not hold up the
 * other, and a failure on one side still returns the other.
 */
export async function compareProfiles(run, profileIds, options = {}) {
    const ids = Array.isArray(profileIds) ? profileIds.filter(Boolean) : [];
    const hostRef = options.hostRef ?? getContext;
    const profiles = ctxOf(hostRef)?.extensionSettings?.connectionManager?.profiles ?? [];
    const usable = ids.length === 2
        && new Set(ids).size === 2
        && ids.every(id => isProfileUsable(hostRef, profiles.find(profile => profile?.id === id)));
    if (!usable) {
        throw new Error('Choose exactly two distinct usable connection profiles.');
    }
    return Promise.all(ids.map(id => sendUnderProfile(run, id, options)));
}
