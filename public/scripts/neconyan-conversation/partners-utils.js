import { escapeRegex } from '../util/escape-regex.js';

export function parseAvatarList(value) {
    return String(value || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

export function collectConversationPartnerAvatars(host, settings = {}, messages = [], group = null, includeThreadPartners = true) {
    return [...new Set([...parseAvatarList(settings.multi_char_names),
        ...(group?.members || []).filter(avatar => !group.disabled_members?.includes(avatar)),
        ...(includeThreadPartners ? messages.filter(message => message?.role === 'partner').map(message => message.extra?.partner_avatar) : []),
    ])].filter(avatar => typeof avatar === 'string' && avatar && avatar !== host);
}

export function mergeConversationPartnerSettings(host, partner) {
    const result = { ...host };
    for (const key of ['availability', 'ai_schedule', 'weekly_schedule', 'auto_schedule', 'schedule_generated_at', 'talkativeness',
        'inactivity_threshold', 'reply_delay_multiplier', 'authors_note', 'lorebook_override', 'connection_profile']) result[key] = partner[key];
    return result;
}

export function chooseChimePartners(partners, messages, mentioned, max = 2, random = Math.random) {
    const chosen = [];
    const add = partner => { if (partner && !chosen.some(item => item.avatar === partner.avatar)) chosen.push(partner); };
    add(mentioned);
    add([...partners].sort((a, b) => getLastPartnerMessageIndex(messages, a) - getLastPartnerMessageIndex(messages, b))[0]);
    const remaining = partners.filter(partner => !chosen.includes(partner));
    for (let index = remaining.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [remaining[index], remaining[swap]] = [remaining[swap], remaining[index]];
    }
    for (const partner of remaining) { if (chosen.length >= max) break; add(partner); }
    return chosen.slice(0, max);
}

export function selectChimePartners({ settings = {}, branch, partners = [], groupId = '', now = Date.now(), random = Math.random } = {}) {
    if (!branch || !partners.length) return [];
    const mentioned = getRecentlySilentMentionedPartnerFromThread(branch.messages || [], partners, 6);
    if (!settings.multi_char && !mentioned) return [];
    const activity = Number(branch.lastActivity) || 0;
    if (!mentioned && (now - activity) / 60000 < Math.max(0.75, (Number(settings.idle_limit) || 15) / 4)) return [];
    const markers = branch.sessionMarkers || {};
    if ([markers.sb_conv_last_chime_session_, markers[`sb_conv_last_chime_session_${groupId || 'solo'}`]].includes(String(activity))) return [];
    return !settings.multi_char ? [mentioned] : chooseChimePartners(partners, branch.messages || [], mentioned, 2, random);
}

export function buildPartnerChimeDirective(partner, hostName, userName) {
    return `[System directive: You are ${partner.name}, chiming in on a private group DM conversation between ${hostName} and ${userName}. You are currently ${partner.activity || 'free'} (status: ${partner.status || 'online'}). If you were mentioned recently, answer naturally. Otherwise add one short message only if you have something distinct to contribute. Other people may be typing at the same time; do not wait for them. Output only your message body, without a name prefix.]`;
}

export function escapeRegExp(value) {
    return escapeRegex(String(value || ''));
}

export function hasMentionBoundaryMatch(messageText, mention) {
    const needle = String(mention || '').toLowerCase().trim();
    if (!messageText || !needle) {
        return false;
    }

    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}($|[^a-z0-9_])`, 'i');
    return pattern.test(messageText);
}

export function getCharacterMentionHandles(character) {
    const charName = String(character?.name || '').trim();
    if (!charName) {
        return [];
    }

    const parts = charName.split(/[\s_-]+/).filter(part => part.length > 2);
    return Array.from(new Set([
        `@${charName}`,
        `@${charName.replace(/[\s_-]+/g, '')}`,
        ...parts.map(part => `@${part}`),
    ].map(handle => handle.trim()).filter(handle => handle.length > 1)));
}

export function isCharacterMentionedInText(character, text, candidates = []) {
    const messageText = String(text || '').toLowerCase();
    const charName = String(character?.name || '').toLowerCase().trim();
    if (!messageText || !charName) {
        return false;
    }

    if (getCharacterMentionHandles(character).some(handle => hasMentionBoundaryMatch(messageText, handle))) {
        return true;
    }

    if (hasMentionBoundaryMatch(messageText, charName)) {
        return true;
    }

    const candidateList = Array.isArray(candidates) && candidates.length ? candidates : [character];
    return charName
        .split(/[\s_-]+/)
        .filter(part => part.length > 2)
        .filter((part) => {
            const partMatches = candidateList.filter(candidate => String(candidate?.name || '').toLowerCase().split(/[\s_-]+/).includes(part));
            return partMatches.length === 1;
        })
        .some(part => hasMentionBoundaryMatch(messageText, part));
}

export function getLastPartnerMessageIndex(thread, partner) {
    for (let index = thread.length - 1; index >= 0; index--) {
        const message = thread[index];
        if (message?.extra?.partner_avatar === partner.avatar) {
            return index;
        }
    }

    return -1;
}

export function getRecentlySilentMentionedPartnerFromThread(thread, partners, recentWindow) {
    const recentMessages = thread.slice(-recentWindow);
    return partners.find(partner => {
        const lastMentionIndex = recentMessages.reduce((last, message, index) =>
            message?.role !== 'system' && message?.extra?.partner_avatar !== partner.avatar
                && isCharacterMentionedInText(partner, message?.mes || '', partners) ? index : last, -1);
        return lastMentionIndex >= 0 && !recentMessages.slice(lastMentionIndex + 1).some(message =>
            message?.extra?.partner_avatar === partner.avatar && !['user', 'system'].includes(message.role));
    }) || null;
}

export function stripSpeakerPrefixText(messageText, speakerName, normalize = value => value) {
    const text = String(messageText || '');
    const namePattern = escapeRegExp(speakerName);
    const charRegex = /^\s*(?:\*\*)?\{\{char\}\}(?:\*\*)?\s*[:：-](?:\*\*)?\s*/i;
    const speakerRegex = namePattern ? new RegExp(`^\\s*(?:\\*\\*)?${namePattern}(?:\\*\\*)?\\s*[:：-](?:\\*\\*)?\\s*`, 'i') : null;

    const lines = text.split(/\r?\n/);
    const cleanedLines = lines.map(line => {
        let currentLine = line;
        let changed = true;
        while (changed) {
            changed = false;
            const prevChar = currentLine;
            currentLine = currentLine.replace(charRegex, '');
            if (currentLine !== prevChar) {
                changed = true;
                continue;
            }
            if (speakerRegex) {
                const prevSpeaker = currentLine;
                currentLine = currentLine.replace(speakerRegex, '');
                if (currentLine !== prevSpeaker) {
                    changed = true;
                }
            }
        }
        return currentLine;
    });

    return normalize(cleanedLines.join('\n').trim());
}

export function getSpeakerPrefixMatch(messageText, speakers = []) {
    const text = String(messageText || '');
    const candidates = (Array.isArray(speakers) ? speakers : [])
        .map(speaker => ({ speaker, name: String(speaker?.name || '').trim() }))
        .filter(candidate => candidate.name)
        .sort((left, right) => right.name.length - left.name.length);

    for (const candidate of candidates) {
        const speakerRegex = new RegExp(`^\\s*(?:\\*\\*)?${escapeRegExp(candidate.name)}(?:\\*\\*)?\\s*[:：-](?:\\*\\*)?\\s*`, 'i');
        const match = text.match(speakerRegex);
        if (match) {
            return {
                speaker: candidate.speaker,
                text: text.slice(match[0].length).trim(),
            };
        }
    }

    return null;
}
