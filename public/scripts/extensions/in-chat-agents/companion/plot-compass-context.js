import { getContext } from '../../../extensions.js';

export function getPlotCompassIdentity() {
    try {
        const context = getContext();
        return {
            groupId: context?.groupId || '',
            avatar: context?.groupId ? '' : context?.characters?.[context?.characterId]?.avatar || '',
            chatId: context?.getCurrentChatId?.() || context?.chatId || '',
        };
    } catch {
        return {};
    }
}
