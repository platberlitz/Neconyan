import { extractCharacterReplyCommandParts, getCharacterReplyCommandMetadata, normalizeConversationOutputText } from './generation-utils.js';
import { getSpeakerPrefixMatch, stripSpeakerPrefixText } from './partners-utils.js';

export function splitChatroomMessages(text) {
    const parts = String(text || '').split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
}

export function splitPartnerChatroomMessages(text) {
    const messages = String(text || '').split(/\n+/).map(normalizeConversationOutputText).filter(Boolean);
    return messages.length ? messages : splitChatroomMessages(text).map(normalizeConversationOutputText).filter(Boolean);
}

function splitReply(text, speakers, groupId, splitEveryLine) {
    text = String(text || '').trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (groupId && lines.length > 1 && lines.some(line => getSpeakerPrefixMatch(line, speakers))) {
        return lines.reduce((messages, line) => {
            if (!messages.length || getSpeakerPrefixMatch(line, speakers)) messages.push(line);
            else messages[messages.length - 1] += `\n${line}`;
            return messages;
        }, []);
    }
    return splitEveryLine ? text.split(/\n+/).map(part => part.trim()).filter(Boolean) : splitChatroomMessages(text);
}

function withCommands(extra, commands) {
    const result = { ...extra };
    delete result.conversation_commands;
    const metadata = getCharacterReplyCommandMetadata(commands);
    if (metadata) result.conversation_commands = metadata;
    return result;
}

/** Both hosts use the same bubble ordering and first-committed-bubble command boundary. */
export async function deliverConversationReply(rawText, settings, {
    fallbackSpeaker, groupId = '', splitEveryLine = false, extra = {}, getSpeakers = () => [],
    validateTarget = () => true, append, commitCommands, generateImage,
}) {
    const result = { text: [], posted: false };
    const referenced = new Set();
    const chunks = splitReply(rawText, groupId ? getSpeakers() : [], groupId, splitEveryLine);
    for (let chunk = 0; chunk < chunks.length; chunk++) {
        if (!validateTarget()) return result;
        const match = groupId ? getSpeakerPrefixMatch(chunks[chunk], getSpeakers()) : null;
        const speaker = match?.speaker || fallbackSpeaker;
        // Command arguments still need their quotes when the command parser reads them.
        const text = match ? match.text : stripSpeakerPrefixText(chunks[chunk], speaker.name || fallbackSpeaker.name || 'Character');
        const commands = extractCharacterReplyCommandParts(text, settings);
        const messages = splitChatroomMessages(commands.text).map(normalizeConversationOutputText).filter(Boolean);
        const speakerAvatar = speaker.avatar || fallbackSpeaker.avatar;
        for (let bubble = 0; bubble < messages.length; bubble++) {
            const attachReplyReference = !referenced.has(speakerAvatar);
            const saved = await append(messages[bubble], speaker, {
                chunk, bubble, attachReplyReference, extra: withCommands(extra, bubble === 0 ? commands : null),
            });
            if (!saved) return result;
            if (attachReplyReference) referenced.add(speakerAvatar);
            result.text.push(messages[bubble]);
            result.posted = true;
            if (bubble === 0 && (commands.scheduleUpdates.length || commands.reminders.length)) {
                await commitCommands(commands, speakerAvatar, { chunk });
            }
        }
        for (let image = 0; image < commands.selfieRequests.length; image++) {
            const attachReplyReference = !referenced.has(speakerAvatar);
            const saved = await generateImage(commands.selfieRequests[image], speaker, { chunk, image, attachReplyReference, extra });
            if (saved && attachReplyReference) referenced.add(speakerAvatar);
            result.posted = result.posted || saved;
        }
    }
    return result;
}
