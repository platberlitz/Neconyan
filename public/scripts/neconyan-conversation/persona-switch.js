import { setUserAvatar } from '../personas.js';
import { getConversationPersonaId } from './context.js';
import { closeConversationSettings } from './settings-panel.js';

export async function switchConversationPersona(personaId, options = {}) {
    const targetPersonaId = getConversationPersonaId(personaId);
    if (!targetPersonaId) {
        return false;
    }

    closeConversationSettings();
    if (targetPersonaId !== getConversationPersonaId()) {
        await setUserAvatar(targetPersonaId, { toastPersonaNameChange: false, ...options });
    }
    return targetPersonaId === getConversationPersonaId();
}
