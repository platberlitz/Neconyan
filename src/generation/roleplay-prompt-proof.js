import { roleplayHash } from '../roleplay-store.js';

/** Preserve the conditional proof fields of already accepted Roleplay prompts. */
export function roleplayPromptContentHash(prompt, worldInfo, { quickReply = false } = {}) {
    return roleplayHash({ messages: prompt.messages, macroState: prompt.macroState,
        ...(prompt.preparedText !== undefined ? { preparedText: prompt.preparedText } : {}), ...(prompt.cfgValues ? { cfgValues: prompt.cfgValues } : {}),
        ...(worldInfo?.pathfinder ? { pathfinderHash: prompt.pathfinderHash } : {}),
        ...(worldInfo?.captions ? { captionsHash: prompt.captionsHash } : {}),
        ...(worldInfo?.inputTranslation ? { inputTranslationHash: prompt.inputTranslationHash } : {}),
        ...(worldInfo?.vectors ? { vectorsHash: prompt.vectorsHash } : {}),
        ...(quickReply ? { quickReplyHash: prompt.quickReplyHash } : {}),
        ...(worldInfo?.agents ? { agentsHash: prompt.agentsHash, agentInterceptHash: prompt.agentInterceptHash } : {}) });
}
