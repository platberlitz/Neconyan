import { DEFAULT_CHATROOM_PROMPT } from './constants.js';
import { compileChatroomPrompt, formatPromptText, getGroundedDialogueRulesPrompt } from './shared-helpers.js';

/** Explicit, captured context only: both hosts use this prompt without reading live selection. */
export function composeConversationSystemPrompt({
    settings, character = {}, charName = character.name || 'Character', userName = 'User', groupId = '',
    partnerNames = [], threadCharacter = null, timeContext = '', participantContext = '',
    authorNote = '', availability = '', personaStatus = '', personaContext = '', memorySummary = '',
    soloMemory = null, groupMemories = [], lifeContext = '',
}) {
    let opening = `You are ${charName} in a private direct-message conversation with ${userName}.`;
    if (groupId) {
        opening = `You are ${charName} in a private group direct-message conversation with ${[userName, ...partnerNames].join(', ')}. You are one equal participant in this group DM and should reply only as ${charName}.`;
    } else if (threadCharacter) {
        opening = `You are ${charName} in a private group direct-message conversation with ${userName} and ${threadCharacter.name || 'another character'}.`;
    }
    const fields = [
        opening,
        participantContext,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not start with a speaker/name label. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
        timeContext,
        compileChatroomPrompt(settings, charName, userName, DEFAULT_CHATROOM_PROMPT),
        getGroundedDialogueRulesPrompt(settings),
    ].filter(Boolean);
    if (character.description) fields.push(`Character description:\n${formatPromptText(character.description, 2400)}`);
    if (character.personality) fields.push(`Personality:\n${formatPromptText(character.personality, 1600)}`);
    if (character.scenario) fields.push(`Background context:\n${formatPromptText(character.scenario, 1200)}`);
    if (authorNote) fields.push(`Conversation author's note:\n${String(authorNote).replace('{{char}}', charName).replace('{{user}}', userName)}`);
    if (settings.lorebook_override) fields.push(`Conversation lorebook focus: ${settings.lorebook_override}. Prefer this lore/context over roleplay scene continuity.`);
    if (availability) {
        fields.push(personaStatus
            ? `User presence: ${userName} is ${availability}. Their Conversation status: ${personaStatus}.`
            : `User presence: ${userName} is ${availability}.`);
    }
    if (personaContext) fields.push(`User persona and active Scenario Notes:\n${formatPromptText(personaContext, 2600)}`);
    if (partnerNames.length) fields.push(`${groupId ? 'Other group DM participants' : 'Group DM participants who may chime in'}: ${partnerNames.join(', ')}. Treat them as independent people in the chat. Do not speak for them unless specifically generating their message.`);
    if (memorySummary) fields.push(`Long-term DM memory summary:\n${memorySummary}`);
    if (settings.include_related_memory && groupId) {
        if (soloMemory?.summary) fields.push(`Relevant solo DM memory for ${charName}:\n${formatPromptText(soloMemory.summary, 1200)}\nUse this as remembered private context for ${charName}, but do not reveal private solo DM details unless they naturally belong in this group Conversation.`);
    } else if (settings.include_related_memory && groupMemories.length) {
        const memories = groupMemories.map(item => `- ${item.groupName || `Group ${item.groupId}`}: ${formatPromptText(item.summary, 900)}`).join('\n');
        fields.push(`Relevant group Conversation memories for ${charName}:\n${memories}\nUse these as remembered context from group DMs, but keep this solo DM private and do not act as if other group participants are present.`);
    }
    if (lifeContext) fields.push(lifeContext);
    const commands = [];
    if (settings.selfie_command_enabled) commands.push('To send a selfie or photo, embed [selfie] (optionally [selfie: context="what the photo shows"]) anywhere in your reply. It is stripped from the visible message and turned into a real image.');
    if (settings.schedule_command_enabled) commands.push('To change what you are doing right now, embed [schedule_update: status="online|idle|dnd|offline", activity="short description", duration="1h30m"]. Use this when your situation shifts (you got off work, went to sleep, etc.).');
    commands.push('To schedule a reminder for the user at their request, embed [reminder: delay_or_time | memo] anywhere in your reply. delay_or_time can be durations (e.g. "2h", "15m", "30s") or explicit clock times (e.g. "14:30"). memo is what you are reminding them about (e.g. "wash the dishes"). This command is stripped from the visible message.');
    fields.push(`Available commands (use sparingly and only when natural):\n${commands.join('\n')}`);
    return fields.join('\n\n');
}
