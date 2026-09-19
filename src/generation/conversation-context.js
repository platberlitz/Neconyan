import { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary } from '../../public/scripts/neconyan-conversation/memory-utils.js';
import { getCurrentActivityFromSchedule } from '../../public/scripts/neconyan-conversation/schedule-utils.js';
import { getCharacterData } from '../endpoints/conversation-generation.js';
import { unScopeConversationStorageKey } from '../endpoints/conversation-utils.js';

/** Resolve saved context inside the captured persona, using the user's timezone rather than the server's. */
export async function buildSavedConversationContext(request, current, target, character, settings, timeZone, now) {
    const characters = {};
    for (const [key, value] of Object.entries(current.store.characters)) {
        const local = unScopeConversationStorageKey(key, target.personaId);
        if (local !== null) characters[local] = value;
    }
    const speakers = [{ avatar: target.avatar, name: character.name }];
    const group = current.group;
    for (const avatar of [...new Set(group?.members || [])].slice(0, 32)) {
        if (avatar === target.avatar || group.disabled_members?.includes(avatar)) continue;
        const member = await getCharacterData(request, avatar, { allowOverride: false });
        speakers.push({ avatar, name: member.name });
    }
    const schedule = characters[target.avatar]?.schedule;
    let lifeContext = '';
    if (schedule) {
        const activity = getCurrentActivityFromSchedule(schedule, `${target.personaId}\u001f${target.avatar}`, new Date(now),
            new Map(Object.entries(current.store.runtimeStatusOverrides || {})), timeZone);
        const timeLabel = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(now);
        lifeContext = `Current life context: It is ${timeLabel} for ${character.name}, who is currently ${activity.activity} (status: ${activity.status}). Let this naturally color your availability, mood, and what you mention. Stay in this moment of your day.`;
    }
    return { speakers, context: {
        partnerNames: speakers.slice(1).map(speaker => speaker.name), lifeContext,
        soloMemory: settings.include_related_memory && target.groupId ? collectSoloConversationMemorySummary(characters, target.avatar) : null,
        groupMemories: settings.include_related_memory && !target.groupId ? collectGroupConversationMemorySummaries(characters, target.avatar, {
            getGroupName: id => current.store.groups.find(item => String(item.id) === id)?.name || '', max: 4,
        }) : [],
    } };
}
