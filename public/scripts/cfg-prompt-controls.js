/** Saved guidance selection and prompt composition, shared with the page. */
export function resolveGuidanceScale(settings, metadata, characterFile, group = false) {
    if (!settings) return;
    const character = settings.chara?.find(item => item.name === characterFile);
    const individual = metadata.cfg_groupchat_individual_chars ?? false;
    if (metadata.cfg_guidance_scale && metadata.cfg_guidance_scale !== 1 && !individual) {
        return { type: 0, value: metadata.cfg_guidance_scale };
    }
    if ((!group || individual) && character && character.guidance_scale !== 1) return { type: 1, value: character.guidance_scale };
    if (settings.global && settings.global.guidance_scale !== 1) return { type: 2, value: settings.global.guidance_scale };
}

export function resolveCfgPrompt(settings, metadata, characterFile, guidance, negative, substitute = value => value ?? '') {
    const field = negative ? 'negative_prompt' : 'positive_prompt';
    const character = settings.chara?.find(item => item.name === characterFile);
    const scopes = [metadata['cfg_' + field], character?.[field], settings.global?.[field]];
    let separator = '\n';
    try { if (metadata.cfg_prompt_separator) separator = JSON.parse(metadata.cfg_prompt_separator); } catch { /* Same default as the page. */ }
    return { value: scopes.flatMap((value, index) => guidance.type === index || metadata.cfg_prompt_combine?.includes(index)
        ? [substitute(value ?? '')] : []).reverse().filter(Boolean).join(separator), depth: metadata.cfg_prompt_insertion_depth ?? 1 };
}
