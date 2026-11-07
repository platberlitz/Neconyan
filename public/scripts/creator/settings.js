/** Account preferences are projected into drafts for browser and server requests.
 * Only this allowlist is shared; character text, sources and request state stay local.
 */
const WRITING_KEYS = ['prompts', 'connection', 'targets', 'nsfw', 'mode', 'custom', 'formatInstruction', 'plistDestination', 'dossierFields', 'askQuestionsFirst', 'userInstructions'];

export function creatorGlobalSettings(draft) {
    return {
        style: draft.style || 'plain',
        writing: structuredClone(Object.fromEntries(WRITING_KEYS.filter(key => Object.hasOwn(draft.writing ?? {}, key)).map(key => [key, draft.writing[key]]))),
        portraitGuidelines: draft.portraitGuidelines ?? '',
        portraitSupportsNegative: draft.portraitSupportsNegative === true,
        creator: draft.card.data.creator ?? '',
    };
}

export function applyCreatorGlobalSettings(draft, settings) {
    if (!settings) return draft;
    draft.style = settings.style || 'plain';
    draft.writing ??= {};
    for (const key of WRITING_KEYS) {
        if (Object.hasOwn(settings.writing ?? {}, key)) draft.writing[key] = structuredClone(settings.writing[key]);
        else delete draft.writing[key];
    }
    draft.portraitGuidelines = settings.portraitGuidelines ?? '';
    draft.portraitSupportsNegative = settings.portraitSupportsNegative === true;
    draft.card.data.creator = settings.creator ?? '';
    if (Object.hasOwn(draft.card, 'creator')) draft.card.creator = draft.card.data.creator;
    return draft;
}
