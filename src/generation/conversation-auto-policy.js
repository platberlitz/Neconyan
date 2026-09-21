/**
 * Server-side Conversation autonomy policy.
 *
 * Mirrors the browser's 30-second auto worker (auto-engine.js): reminders first,
 * then per thread schedules, proactive or idle, chimes and character chat, at
 * most one send per scan. These functions are pure decisions over saved state,
 * so they are tested without a DOM or a server. The worker accepts the returned
 * occurrence as a normal Conversation reply family.
 */

import { createHash } from 'node:crypto';
import { buildPartnerChimeDirective, CHIME_DIRECTIVE_MARKER, chooseChimePartners, getRecentlySilentMentionedPartnerFromThread, selectChimePartners } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { getCurrentActivityFromSchedule } from '../../public/scripts/neconyan-conversation/schedule-utils.js';
import { clamp, parsePositiveInt } from '../endpoints/conversation-utils.js';
import { manualActivity } from './conversation-participants.js';

const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_IDLE_LIMIT = 15;
const DEFAULT_INACTIVITY_THRESHOLD = 120;
const DEFAULT_MAX_FOLLOWUPS = 3;
const DEFAULT_AUTO_CHAT_COOLDOWN = 10;
export const REMINDER_RETRY_DELAY_MS = 60000;
const PARTNER_FOLLOWUP_RECENT_WINDOW = 6;
const AT_AUTO_CHAT_MARKER = 'auto_chat_at';
const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
const SCHEDULE_TRIGGER_LIMIT = 100;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Legacy pages used these directives in their browser-owned automatic calls.
export function isConversationAutomaticDirective(text) {
    return typeof text === 'string' && text.startsWith('[System directive:') && [
        'This is a scheduled reminder.', 'Your weekly schedule is due:', 'Your schedule is due:',
        'You are sending a check-in due to', 'The user has been quiet for a while.',
        'Send a spontaneous ping to the user', 'and you are currently',
        'speaking autonomously in a private group DM', CHIME_DIRECTIVE_MARKER,
    ].some(marker => text.includes(marker));
}

function finiteNumber(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positiveSettings(value, fallback, min = 0) {
    return clamp(parsePositiveInt(value, fallback, min), min, 100000);
}

function scheduleTriggerCap(triggers) {
    const keys = Object.keys(triggers || {});
    if (keys.length <= SCHEDULE_TRIGGER_LIMIT) return triggers || {};
    const sorted = keys.sort((a, b) => finiteNumber(triggers[a], 0) - finiteNumber(triggers[b], 0));
    const trimmed = {};
    for (const key of sorted.slice(keys.length - SCHEDULE_TRIGGER_LIMIT)) trimmed[key] = triggers[key];
    return trimmed;
}

/** The clock fields the browser reads locally, resolved in the user's named zone. */
export function getConversationAutomationClock(now, timeZone = 'UTC') {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now));
    const get = type => parts.find(part => part.type === type)?.value || '';
    const hour = Number(get('hour')) % 24;
    const minute = get('minute');
    const dayOfWeek = Math.max(0, WEEKDAYS.indexOf(get('weekday')));
    return { dayOfWeek, hour, minuteKey: `${String(hour).padStart(2, '0')}:${minute}`, dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}

/** A deterministic key for one logical autonomous occurrence. */
export function getConversationOccurrenceKey({ owner, target, kind, basis }) {
    const joined = ['conv-auto', owner, target?.avatar || '', target?.groupId || '', target?.personaId || '', target?.branchId || '', kind, ...(Array.isArray(basis) ? basis : [basis])]
        .map(value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)).join('|');
    return joined.length <= 180 ? joined : `conv-auto:${createHash('sha256').update(joined).digest('hex')}`;
}

export const conversationReminderIdentityKey = id => `reminder:${id}`;
export const conversationChimeOccurrenceKey = (target, activity) => getConversationOccurrenceKey({ owner: '', target, kind: 'chime', basis: activity });
export const getConversationSummarySubmissionKey = (target, throughId) => `summary:${createHash('sha256')
    .update(JSON.stringify([target.avatar, target.groupId || '', target.personaId || '', target.branchId, throughId])).digest('hex')}`;

/** Recheck saved switches after asynchronous card/binding reads, before acceptance. */
export function isConversationOccurrenceEnabled({ kind, settings, store, reminderId, roleplaySource, branch, target, partners = [], plan = [], patch, now = Date.now() }) {
    if (roleplaySource) return true; // The aside path checks its source group's own settings.
    if (store.automation?.mode !== 'server' || settings.enabled === false || store.userStatus === 'offline') return false;
    switch (kind) {
        case 'reminder': return Boolean(store.reminders?.some(item => item.id === reminderId && !item.fired && !item.invalidAt));
        case 'schedule': return Boolean(settings.auto_message);
        case 'idle-followup': return Boolean(settings.idle_followup && !settings.proactive_messaging);
        case 'idle-spontaneous': return Boolean(settings.idle_spontaneous && !settings.proactive_messaging);
        case 'proactive': return Boolean(settings.proactive_messaging && store.userStatus !== 'dnd');
        case 'chat': return Boolean(settings.auto_character_chat);
        case 'chime': {
            const frozen = patch?.sessionMarkers?.[LAST_CHIME_SESSION_PREFIX]
                ?? patch?.sessionMarkers?.[`${LAST_CHIME_SESSION_PREFIX}${target?.groupId || 'solo'}`];
            if (frozen !== undefined && String(frozen) !== String(lastUserActivity(branch))) return false;
            const chosen = selectChimePartners({ settings, branch, partners, groupId: target?.groupId || '', now });
            if (!chosen.length) return false;
            const allowed = new Set((settings.multi_char ? partners : chosen).map(partner => partner.avatar));
            return plan.every(participant => allowed.has(participant.avatar));
        }
        default: return false;
    }
}

function lastUserActivity(branch) {
    return finiteNumber(branch?.lastActivity, 0);
}

function safeParseWeeklySchedule(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function occurrence(target, kind, key, directive, participants, extra, bookkeeping) {
    return { kind, key, directive, participants, target, extra, bookkeeping };
}

/**
 * The first due reminder, matching the browser: stored order, one per scan, and
 * a per-reminder retry window. Returns a send occurrence, or an invalidate/skip
 * instruction the worker applies without a provider call.
 */
export function selectConversationReminder({ reminders = [], targets = new Map(), submitted = new Set(), taken = key => submitted.has(key), personaId = '', now = Date.now() } = {}) {
    for (const reminder of reminders) {
        if (!reminder || reminder.fired || reminder.invalidAt) continue;
        if (taken(conversationReminderIdentityKey(reminder.id))) continue;
        if (String(reminder.personaId || '') !== String(personaId || '')) continue;
        if (now < finiteNumber(reminder.triggerAt, 0)) continue;
        if (reminder.retryAfter && now < finiteNumber(reminder.retryAfter, 0)) continue;
        const target = targets.get?.(reminder) || reminder.target || null;
        if (!target) return { action: 'invalidate', reminderId: reminder.id, reason: 'missing_branch' };
        const settings = target.settings || {};
        if (settings.enabled === false) return { action: 'skip', reminderId: reminder.id };
        const directive = `[System directive: This is a scheduled reminder. Send a DM to the user reminding them about: "${reminder.text}". Do not mention system/bracketed code, just say it naturally in-character as a DM ping.]`;
        const key = getConversationOccurrenceKey({ owner: reminder.owner || '', target: target.target, kind: 'reminder', basis: [reminder.id, reminder.triggerAt] });
        if (taken(key)) continue;
        return occurrence(target.target, 'reminder', key, directive,
            [{ avatar: target.target.avatar, purpose: 'reminder', extra: { conversation_mode_auto: true, conversation_mode_reminder: true, reminder_text: reminder.text, reminder_id: reminder.id, groupId: target.target.groupId || '' } }],
            { conversation_mode_auto: true, conversation_mode_reminder: true, reminder_text: reminder.text, reminder_id: reminder.id, groupId: target.target.groupId || '' },
            { reminder: { id: reminder.id }, markAutoMessage: true });
    }
    return null;
}

/** A due weekly or legacy scheduled message for one thread. */
export function selectConversationScheduledMessage({ settings = {}, branch = null, target = null, now = Date.now(), timeZone = 'UTC', taken = () => false } = {}) {
    if (!settings.auto_message || !branch || !target) return null;
    const { dayOfWeek, minuteKey, dateKey } = getConversationAutomationClock(now, timeZone);
    const triggers = branch.scheduleTriggers || {};
    const candidates = [];
    for (const entry of safeParseWeeklySchedule(settings.weekly_schedule)) {
        if (!entry || entry.enabled === false) continue;
        if (!Array.isArray(entry.days) || !entry.days.includes(dayOfWeek)) continue;
        if (entry.time !== minuteKey) continue;
        candidates.push({ key: `weekly:${dateKey}:${entry.time}:${entry.message}`, directive: `[System directive: Your weekly schedule is due: "${entry.message}". Send a message with this context in mind.]`, label: `weekly:${entry.time}`, raw: entry.message });
    }
    for (const line of String(settings.ai_schedule || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const absolute = trimmed.match(/^(\d{2}):(\d{2})\s*-\s*(.*)$/);
        if (absolute) {
            if (`${absolute[1]}:${absolute[2]}` === minuteKey) {
                candidates.push({ key: `absolute:${dateKey}:${minuteKey}:${trimmed}`, directive: `[System directive: Your schedule is due: "${absolute[3]}". Send a message with this context in mind.]`, label: trimmed, raw: absolute[3] });
            }
            continue;
        }
        const relative = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
        if (relative) {
            const elapsedMinutes = (now - lastUserActivity(branch)) / 60000;
            if (elapsedMinutes >= Number(relative[1])) {
                candidates.push({ key: `relative:${lastUserActivity(branch)}:${trimmed}`, directive: `[System directive: You are sending a check-in due to ${relative[1]} minutes of silence: "${relative[2]}".]`, label: trimmed, raw: relative[2] });
            }
        }
    }
    for (const candidate of candidates) {
        if (triggers[candidate.key]) continue;
        const key = getConversationOccurrenceKey({ owner: '', target, kind: 'schedule', basis: candidate.key });
        if (taken(key)) continue;
        return occurrence(target, 'schedule', key, candidate.directive,
            [{ avatar: target.avatar, purpose: 'schedule', extra: { conversation_mode_auto: true, schedule: candidate.label, groupId: target.groupId || '' } }],
            { conversation_mode_auto: true, schedule: candidate.label, groupId: target.groupId || '' },
            { scheduleTriggers: [candidate.key], markAutoMessage: true });
    }
    return null;
}

/** The idle follow-up or spontaneous ping, one per burst of user inactivity. */
export function selectConversationIdleMessage({ settings = {}, branch = null, target = null, now = Date.now(), taken = () => false } = {}) {
    if (!branch || !target) return null;
    if (!settings.idle_followup && !settings.idle_spontaneous) return null;
    const idleLimit = positiveSettings(settings.idle_limit, DEFAULT_IDLE_LIMIT, 1);
    const elapsedMinutes = (now - lastUserActivity(branch)) / 60000;
    if (elapsedMinutes < idleLimit) return null;
    const markers = branch.sessionMarkers || {};
    const followupMarker = `${LAST_IDLE_SESSION_PREFIX}followup`;
    const spontaneousMarker = `${LAST_IDLE_SESSION_PREFIX}spontaneous`;
    if (settings.idle_followup && markers[followupMarker] !== String(lastUserActivity(branch))) {
        const directive = '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]';
        const key = getConversationOccurrenceKey({ owner: '', target, kind: 'idle-followup', basis: lastUserActivity(branch) });
        if (!taken(key)) return occurrence(target, 'idle-followup', key, directive,
            [{ avatar: target.avatar, purpose: 'idle-followup', extra: { conversation_mode_auto: true, idle_action: 'followup', groupId: target.groupId || '' } }],
            { conversation_mode_auto: true, idle_action: 'followup', groupId: target.groupId || '' },
            { sessionMarkers: { [followupMarker]: String(lastUserActivity(branch)) }, markAutoMessage: true });
    }
    const spontaneousLimit = settings.idle_followup ? idleLimit * 2 : idleLimit;
    if (settings.idle_spontaneous && elapsedMinutes >= spontaneousLimit && markers[spontaneousMarker] !== String(lastUserActivity(branch))) {
        const directive = '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]';
        const key = getConversationOccurrenceKey({ owner: '', target, kind: 'idle-spontaneous', basis: lastUserActivity(branch) });
        if (!taken(key)) return occurrence(target, 'idle-spontaneous', key, directive,
            [{ avatar: target.avatar, purpose: 'idle-spontaneous', extra: { conversation_mode_auto: true, idle_action: 'spontaneous', groupId: target.groupId || '' } }],
            { conversation_mode_auto: true, idle_action: 'spontaneous', groupId: target.groupId || '' },
            { sessionMarkers: { [spontaneousMarker]: String(lastUserActivity(branch)) }, markAutoMessage: true });
    }
    return null;
}

function buildProactiveDirective(activity, status, hour) {
    const timeOfDay = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    const statusNote = status === 'dnd' ? 'You are busy and only have a brief moment.' : status === 'idle' ? 'You have a spare moment between things.' : 'You are free and feel like reaching out.';
    return `[System directive: It is ${timeOfDay} and you are currently ${activity} (status: ${status}). ${statusNote} The user has not replied in a while. Reach out to them yourself with a short, natural direct message. Reference your current activity or the time of day if it feels right. Do not wait for them to speak first.]`;
}

/** Proactive outreach, including the browser's first-message catch-up. */
export function selectConversationProactiveMessage({ settings = {}, branch = null, target = null, activity = null, userStatus = 'online', now = Date.now(), timeZone = 'UTC' } = {}) {
    if (!settings.proactive_messaging || !branch || !target) return null;
    if (userStatus === 'dnd') return null;
    if (activity && activity.status === 'offline') return null;
    const status = activity?.status || 'online';
    const maxFollowups = clamp(parsePositiveInt(settings.max_followups, DEFAULT_MAX_FOLLOWUPS, 1), 1, 3);
    const sentCount = Math.max(0, finiteNumber(branch.followupCount, 0));
    const messages = Array.isArray(branch.messages) ? branch.messages : [];
    const lastMessage = messages[messages.length - 1];
    const catchUp = lastMessage?.role === 'user' && sentCount === 0;
    const idleMinutes = (now - lastUserActivity(branch)) / 60000;
    const threshold = clamp(parsePositiveInt(settings.inactivity_threshold, DEFAULT_INACTIVITY_THRESHOLD, 15), 15, 360) * (status === 'dnd' ? 3 : 1);
    let due = false;
    if (sentCount === 0) due = idleMinutes >= threshold;
    else if (sentCount < maxFollowups) due = now - finiteNumber(branch.lastAutoMessageAt, lastUserActivity(branch)) >= threshold * (2 ** sentCount) * 60000;
    if (!catchUp && !due) return null;
    const { hour } = getConversationAutomationClock(now, timeZone);
    const directive = buildProactiveDirective(activity?.activity || 'free time', status, hour);
    const key = getConversationOccurrenceKey({ owner: '', target, kind: 'proactive', basis: [lastUserActivity(branch), sentCount] });
    return occurrence(target, 'proactive', key, directive,
        [{ avatar: target.avatar, purpose: 'proactive', extra: { conversation_mode_auto: true, proactive: true, proactive_status: status, groupId: target.groupId || '' } }],
        { conversation_mode_auto: true, proactive: true, proactive_status: status, groupId: target.groupId || '' },
        { followupCount: sentCount + 1, markAutoMessage: true });
}

function mergePartnerRecords(settings, partners, group, threadAvatar) {
    const records = new Map();
    for (const partner of partners || []) {
        if (partner?.avatar) records.set(partner.avatar, { avatar: partner.avatar, name: partner.name || partner.avatar, status: partner.status || 'online' });
    }
    for (const raw of String(settings.multi_char_names || '').split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const found = [...(partners || [])].find(partner => partner?.name === name || partner?.avatar === name);
        if (found?.avatar && found.avatar !== threadAvatar) records.set(found.avatar, { avatar: found.avatar, name: found.name, status: found.status || 'online' });
    }
    return [...records.values()].filter(record => record.avatar !== threadAvatar);
}

function recentlySilentMentionedPartner(partners, messages) {
    return getRecentlySilentMentionedPartnerFromThread(messages, partners, PARTNER_FOLLOWUP_RECENT_WINDOW);
}

/** Who chimes in: up to two partners, mentioning and least-recent first. */
export function chooseConversationChimePartners({ partners = [], messages = [], mentioned = null, random = Math.random } = {}) {
    return chooseChimePartners(partners, messages, mentioned, 2, random);
}

/** A chime occurrence when the thread is quiet or a partner was mentioned. */
export function selectConversationChime({ settings = {}, branch = null, target = null, partners = [], hostName = 'The host', userName = 'User', now = Date.now(), random = Math.random } = {}) {
    if (!branch || !target || !partners.length) return null;
    const marker = LAST_CHIME_SESSION_PREFIX;
    const chosen = selectChimePartners({ settings, branch, partners, groupId: target.groupId, now, random });
    if (!chosen.length) return null;
    const key = getConversationOccurrenceKey({ owner: '', target, kind: 'chime', basis: lastUserActivity(branch) });
    const directiveFor = partner => buildPartnerChimeDirective(partner, hostName, userName);
    return occurrence(target, 'chime', key, directiveFor(chosen[0]),
        chosen.map(partner => ({ avatar: partner.avatar, purpose: 'chime', directive: directiveFor(partner), extra: { conversation_mode_auto: true, conversation_mode_chime: true, partner_avatar: partner.avatar, groupId: target.groupId || '' } })),
        { conversation_mode_auto: true },
        { sessionMarkers: { [marker]: String(lastUserActivity(branch)) }, markAutoMessage: true });
}

/** Character-to-character ambient chat, one partner aimed at another member. */
export function selectConversationCharacterChat({ settings = {}, branch = null, target = null, partners = [], now = Date.now(), random = Math.random } = {}) {
    if (!settings.auto_character_chat || !branch || !target || !partners.length) return null;
    const cooldownMs = positiveSettings(settings.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1) * 60000;
    const baseline = finiteNumber((branch.sessionMarkers || {})[AT_AUTO_CHAT_MARKER], 0) || finiteNumber(branch.updatedAt, 0) || finiteNumber(branch.createdAt, 0);
    if (now - baseline < cooldownMs) return null;
    const speaking = partners[Math.floor(random() * partners.length)];
    if (!speaking || speaking.status === 'offline') return null;
    const recipients = partners.filter(partner => partner.avatar !== speaking.avatar);
    const recipient = recipients.length ? recipients[Math.floor(random() * recipients.length)] : null;
    const targetName = recipient?.name || target.avatar;
    const key = getConversationOccurrenceKey({ owner: '', target, kind: 'chat', basis: baseline });
    const directive = `[System directive: You are ${speaking.name}, speaking autonomously in a private group DM. Aim this message at ${targetName}, not the user, unless the user is directly relevant. This is character-to-character ambient chat, so continue the casual conversation or start a friendly new topic with one short, natural message. Other people may reply later. Output only your message body, without a name prefix.]`;
    return occurrence(target, 'chat', key, directive,
        [{ avatar: speaking.avatar, purpose: 'chat', extra: { conversation_mode_auto: true, conversation_mode_auto_chat: true, partner_avatar: speaking.avatar, groupId: target.groupId || '' } }],
        { conversation_mode_auto: true, conversation_mode_auto_chat: true, partner_avatar: speaking.avatar },
        { sessionMarkersAtDelivery: [AT_AUTO_CHAT_MARKER], markAutoMessage: true });
}

/** Resolve a thread's current activity without treating a missing schedule as manual. */
export function resolveAutomationActivity(characters, avatar, personaId, overrides, now, timeZone) {
    const schedule = characters[avatar]?.schedule;
    const overrideKey = `${personaId}\u001f${avatar}`;
    if (!schedule && !(overrides && Object.hasOwn(overrides, overrideKey))) return manualActivity({});
    return getCurrentActivityFromSchedule(schedule, overrideKey, new Date(now), new Map(Object.entries(overrides || {})), timeZone);
}

/**
 * Pick the one autonomous message for a thread: schedules, then proactive or
 * idle, then chime, then character chat. Reminders are decided separately and
 * always take priority in the worker.
 */
export function selectNextConversationThreadAutomation({ settings = {}, branch = null, target = null, partners = [], hostName, userName, characters = {}, personaId = '', overrides = {}, userStatus = 'online', now = Date.now(), timeZone = 'UTC', random = Math.random, taken = () => false } = {}) {
    if (settings.enabled === false || userStatus === 'offline') return null;
    const since = now - finiteNumber(branch?.lastAutoMessageAt, 0);
    if (since < positiveSettings(settings.cooldown, DEFAULT_COOLDOWN_SECONDS, 0) * 1000) return null;
    const scheduled = selectConversationScheduledMessage({ settings, branch, target, now, timeZone, taken });
    if (scheduled) return scheduled;
    const activity = resolveAutomationActivity(characters, target.avatar, personaId, overrides, now, timeZone);
    if (settings.proactive_messaging) {
        const proactive = selectConversationProactiveMessage({ settings, branch, target, activity, userStatus, now, timeZone });
        if (proactive && !taken(proactive.key)) return proactive;
    } else {
        const idle = selectConversationIdleMessage({ settings, branch, target, now, taken });
        if (idle) return idle;
    }
    const chime = selectConversationChime({ settings, branch, target, partners, hostName, userName, now, random });
    if (chime && !taken(chime.key)) return chime;
    const characterChat = selectConversationCharacterChat({ settings, branch, target, partners, now, random });
    return characterChat && !taken(characterChat.key) ? characterChat : null;
}

export const testExports = { mergePartnerRecords, recentlySilentMentionedPartner, buildProactiveDirective, scheduleTriggerCap, REMINDER_RETRY_DELAY_MS };
