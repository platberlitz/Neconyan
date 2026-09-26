/**
 * Native aside events.
 *
 * A rendered Roleplay message used to be sampled in the browser: the page rolled
 * the dice, chose which group member answered, resolved that member's
 * Conversation branch and posted one aside submission per candidate. The page
 * that happened to be open therefore decided who spoke and whether anybody spoke
 * at all, and a reopened page could sample the same message again.
 *
 * An event is now one native fact: a message was rendered, or a user message may
 * name a member. The server reads the saved chat and the saved group, decides
 * whether the event earns an aside, chooses at most one recipient, and hands
 * that one decision to the existing aside acceptance, which still owns the
 * eligibility, the cooldown, the busy check and the permanent occurrence key.
 * Nothing here repeats a paid call: the occurrence key is derived from the saved
 * source, so a replayed event finds the accepted job instead of paying again.
 */
import { randomInt } from 'node:crypto';
import { isCharacterMentionedInText } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { getCharacterData, getConversationSettings, normalizeConversationSettings } from '../endpoints/conversation-generation.js';
import { normalizeConversationGroupRecord } from '../endpoints/conversation-groups.js';
import { ensureConversationStore, getConversationThreadKey, readUserSettingsWithStatus } from '../endpoints/conversation-store.js';
import { acceptConversationAside } from './conversation-jobs.js';
import { readConversationAsideEventSource } from './conversation-roleplay-source.js';

const MAX_EVENT_KEY = 256;
const KINDS = new Set(['mention', 'rendered']);
/** The sampling the browser used to do on every rendered character message. */
const RANDOM_CHANCE_PERCENT = 18;
const SPEAKER_PREFERENCE_PERCENT = 65;

const normalizeGroup = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

function fail(message, status = 400, apiError = 'conversation_aside_event_failed') {
    return Object.assign(new Error(message), { status, apiError });
}

function isPrototypeKey(value) {
    return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

function assertKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw fail(`Invalid ${label}.`, 400, 'invalid_aside_event');
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw fail(`Unexpected ${label} field: ${key}`, 400, 'invalid_aside_event');
    }
}

function identifier(value, label) {
    const parsed = typeof value === 'string' ? value.trim() : '';
    if (!parsed || isPrototypeKey(parsed)) throw fail(`Invalid aside event ${label}.`, 400, 'invalid_aside_event');
    return parsed;
}

function optionalIdentifier(value, label) {
    if (value === undefined || value === null || value === '') return '';
    return identifier(value, label);
}

/**
 * The browser may only state what happened. It never names the recipient, the
 * reason, the branch, or whether the event is worth a call.
 */
export function normalizeConversationAsideEvent(body = {}) {
    assertKeys(body, ['eventKey', 'personaId', 'kind', 'source', 'messageIndex', 'messageRevision', 'groupRevision', 'speakerAvatar'], 'aside event');
    assertKeys(body.source, ['locator', 'groupId'], 'aside event source');
    assertKeys(body.source.locator, ['chat', 'avatar', 'group'], 'aside event locator');

    const eventKey = identifier(body.eventKey, 'key');
    if (eventKey.length > MAX_EVENT_KEY) throw fail('The aside event key is too long.', 400, 'invalid_aside_event');
    const kind = body.kind;
    if (!KINDS.has(kind)) throw fail('Invalid aside event kind.', 400, 'invalid_aside_event');
    let chat = identifier(body.source.locator.chat, 'chat name');
    while (/\.jsonl$/i.test(chat)) chat = chat.replace(/\.jsonl$/i, '');
    if (!chat) throw fail('Invalid aside event chat name.', 400, 'invalid_aside_event');
    if (typeof body.source.locator.group !== 'boolean') {
        throw fail('Invalid aside event locator group flag.', 400, 'invalid_aside_event');
    }
    const group = body.source.locator.group;
    const locatorAvatar = optionalIdentifier(body.source.locator.avatar, 'character file');
    const sourceGroupId = optionalIdentifier(body.source.groupId, 'source group');
    if (!Number.isSafeInteger(body.messageIndex) || body.messageIndex < 0) {
        throw fail('Invalid aside event message index.', 400, 'invalid_aside_event');
    }
    if (typeof body.messageRevision !== 'string' || !body.messageRevision) {
        throw fail('Invalid aside event message revision.', 400, 'invalid_aside_event');
    }
    const messageRevision = body.messageRevision;
    const groupRevision = body.groupRevision ? identifier(body.groupRevision, 'group revision') : '';
    if (group && (!sourceGroupId || !groupRevision)) {
        throw fail('A group aside event requires its group and group revision.', 400, 'invalid_aside_event');
    }
    if (!group && (sourceGroupId || groupRevision)) {
        throw fail('A solo aside event cannot name a group.', 400, 'invalid_aside_event');
    }
    if (!group && !locatorAvatar) {
        throw fail('A solo aside event requires a character file.', 400, 'invalid_aside_event');
    }
    return {
        eventKey,
        personaId: optionalIdentifier(body.personaId, 'persona'),
        kind,
        source: { locator: { chat, avatar: locatorAvatar, group }, groupId: sourceGroupId },
        messageIndex: body.messageIndex,
        messageRevision,
        groupRevision,
        speakerAvatar: optionalIdentifier(body.speakerAvatar, 'speaker'),
    };
}

/** Every member the saved group still lets speak, in the group's own order. */
function activeMembers(group) {
    const members = Array.isArray(group?.members) ? group.members.map(String) : [];
    const disabled = new Set(Array.isArray(group?.disabled_members) ? group.disabled_members.map(String) : []);
    return members.filter(avatar => avatar && !disabled.has(avatar));
}

/** The active Conversation branch each named candidate would answer in. */
function activeBranch(request, avatar, personaId) {
    const saved = readUserSettingsWithStatus(request);
    if (!saved.ok) return null;
    const store = ensureConversationStore(saved.data, normalizeGroup);
    const thread = store.characters?.[getConversationThreadKey(avatar, '', personaId)];
    return typeof thread?.activeBranchId === 'string' && thread.activeBranchId ? thread.activeBranchId : null;
}

/**
 * The candidates whose saved settings accept Roleplay reactions, in the order
 * given. The page used to filter the same way before it chose anybody, so an
 * opted-out member never takes the one chance an event earns.
 */
function eligibleMembers(request, avatars, groupId, personaId) {
    const saved = readUserSettingsWithStatus(request);
    if (!saved.ok) return [];
    const store = ensureConversationStore(saved.data, normalizeGroup);
    return avatars.filter((avatar) => {
        const settings = getConversationSettings(request, store, avatar, groupId, {}, { personaId });
        return settings.enabled !== false && settings.roleplay_reactions === true;
    });
}

function roll(percent) {
    return randomInt(100) < percent;
}

/**
 * Choose at most one recipient for one event, then let the existing aside
 * acceptance decide whether that recipient is eligible right now. The response
 * reports the decision, so the page never has to guess whether the event fired.
 *
 * `rollPercent` is the sampling seam: the probabilities below are the ones the
 * page used to apply, and a caller may supply the draw instead of paying for a
 * real one.
 */
export async function acceptConversationAsideEvent(request, body = {}, { rollPercent = roll } = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    const event = normalizeConversationAsideEvent(body);
    const saved = readConversationAsideEventSource(request, event);
    const refused = (skipped, extra = {}) => ({ eventKey: event.eventKey, accepted: false, reason: null, avatar: null, jobId: null, skipped, ...extra });

    if (event.source.locator.group !== true) {
        if (event.kind === 'mention') return refused('mention_requires_group');
        // A solo Roleplay reaction is the chat's own character answering the user
        // in their Conversation thread, on the same chance the page used to roll.
        if (!eligibleMembers(request, [event.source.locator.avatar], '', event.personaId).length) return refused('disabled');
        if (!rollPercent(RANDOM_CHANCE_PERCENT)) return refused('sampled_out');
        return decide(request, event, [event.source.locator.avatar], 'reaction', refused);
    }

    const members = eligibleMembers(request, activeMembers(saved.group), event.source.groupId, event.personaId);
    if (!members.length) return refused('no_member');
    if (event.kind === 'mention') {
        const named = [];
        for (const avatar of members) {
            const character = await getCharacterData(request, avatar, { allowOverride: false, requireExisting: true });
            if (!character?.name || !isCharacterMentionedInText(character, saved.source?.mes, [])) continue;
            named.push(avatar);
        }
        if (!named.length) return refused('no_mention');
        // The first mentioned member in the group's own order answers, so one
        // event can never turn into a burst of paid calls.
        return decide(request, event, [named[0]], 'mention', refused);
    }

    if (!rollPercent(RANDOM_CHANCE_PERCENT)) return refused('sampled_out');
    const others = members.filter(avatar => avatar !== event.speakerAvatar);
    const speakerPreferred = event.speakerAvatar && members.includes(event.speakerAvatar) && rollPercent(SPEAKER_PREFERENCE_PERCENT);
    const pool = speakerPreferred ? [event.speakerAvatar] : (others.length ? others : members);
    const chosen = pool[randomInt(pool.length)];
    return decide(request, event, [chosen], chosen === event.speakerAvatar ? 'reaction' : 'random', refused);
}

/** Hand the chosen recipient to the existing aside acceptance, once. */
async function decide(request, event, candidates, reason, refused) {
    let lastSkipped = null;
    for (const avatar of candidates) {
        const branchId = activeBranch(request, avatar, event.personaId);
        if (!branchId) continue;
        const accepted = await acceptConversationAside(request, {
            target: { avatar, personaId: event.personaId, branchId },
            source: { locator: event.source.locator, groupId: event.source.groupId },
            messageIndex: event.messageIndex,
            messageRevision: event.messageRevision,
            groupRevision: event.groupRevision,
            reason,
        });
        if (accepted?.job) {
            return { eventKey: event.eventKey, accepted: accepted.created !== false, reason, avatar,
                jobId: accepted.job.id, state: accepted.job.state, skipped: null };
        }
        // The existing acceptance already knows why it declined, so the page is told
        // the real reason instead of a generic refusal.
        lastSkipped = accepted?.skipped ?? null;
    }
    return refused(lastSkipped ?? 'ineligible', { reason });
}
