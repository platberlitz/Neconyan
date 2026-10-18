import { characters, chat_metadata, getCurrentChatId, getRequestHeaders, this_chid, unshallowCharacter } from '../script.js';
import { selected_group } from './group-chats.js';
import { power_user } from './power-user.js';
import { selected_world_info, world_info } from './world-info.js';
import { roleplayAccountStamp } from './roleplay-save-chain.js';

/** Notebook context currently belongs to the server workflow, unlike ordinary prompts. */
export async function requiresServerReply(memberIds = [this_chid]) {
    const chat = String(getCurrentChatId() || '').replace(/\.jsonl$/, '');
    if (!chat) return false;
    let stamp;
    try { stamp = roleplayAccountStamp(); } catch { return false; }
    await Promise.all(memberIds.map(id => unshallowCharacter(id)));
    const scopes = memberIds.map(id => {
        const character = characters[id];
        const avatar = character?.avatar;
        const extra = world_info.charLore?.find(item => item.name === avatar?.replace(/\.[^.]+$/, ''))?.extraBooks ?? [];
        return {
            chat: selected_group ? `group:${chat}` : `${avatar}:${chat}`,
            character: avatar,
            lorebooks: [...new Set([...selected_world_info, chat_metadata.world_info, power_user.persona_description_lorebook,
                character?.data?.extensions?.world, ...extra].filter(Boolean))],
        };
    });
    const response = await fetch('/api/notebooks/reply-requirements', {
        method: 'POST', headers: { ...getRequestHeaders(), 'X-Neconyan-Account': stamp.owner }, body: JSON.stringify({ scopes }),
    });
    if (!response.ok) throw new Error('Could not check the selected Notebook context. Please try again.');
    return (await response.json()).required === true;
}
