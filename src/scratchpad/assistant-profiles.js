/** Shared validation for saved assistants and portable session copies. */
export const BUILTIN_ASSISTANT_IDS = Object.freeze(['miso', 'taro', 'nori']);
export const MAX_ASSISTANTS = 24;
export const isCustomAssistant = id => typeof id === 'string' && /^assistant_[a-f0-9]{24}$/.test(id);
export const isAssistantId = id => BUILTIN_ASSISTANT_IDS.includes(id) || isCustomAssistant(id);
export const orderedAssistants = ids => [...new Set([...BUILTIN_ASSISTANT_IDS.filter(id => ids.includes(id)), ...ids.filter(isCustomAssistant)])];

export function assistantProfileError(message, status = 400) {
    return Object.assign(new Error(message), { code: 'SCRATCHPAD_ASSISTANT_INVALID', status });
}

export function normaliseAssistantProfile(input) {
    if (!input || !isCustomAssistant(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
        throw assistantProfileError('Give the assistant a name of up to 80 characters.');
    }
    const profile = { id: input.id, name: input.name.trim() };
    for (const key of ['personality', 'examples']) {
        const text = input[key] ?? '';
        if (typeof text !== 'string' || Buffer.byteLength(text) > 64000) throw assistantProfileError('Keep the personality and example dialogue under 64,000 bytes each.');
        profile[key] = text;
    }
    if (!profile.personality.trim()) throw assistantProfileError('Write a personality for the assistant.');
    const avatar = input.avatar || '';
    if (typeof avatar !== 'string' || avatar.length > 180000 || (avatar && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))) {
        throw assistantProfileError('Choose a PNG, JPEG or WebP picture under 128 KB.');
    }
    profile.avatar = avatar;
    if (typeof input.sourceCard === 'string') profile.sourceCard = input.sourceCard.slice(0, 256);
    return profile;
}

export function normaliseAssistantSnapshots(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > MAX_ASSISTANTS) {
        throw assistantProfileError(`Keep up to ${MAX_ASSISTANTS} saved assistants in a session.`);
    }
    return Object.fromEntries(Object.entries(input).map(([id, profile]) => {
        if (id !== profile?.id) throw assistantProfileError('This assistant copy has an invalid identity.');
        return [id, normaliseAssistantProfile(profile)];
    }));
}
