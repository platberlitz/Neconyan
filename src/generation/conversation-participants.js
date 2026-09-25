/**
 * Server-side Conversation participant policy.
 *
 * Selection, availability and reply timing are pure decisions over saved state.
 * The browser keeps its own copy until the composer migrates; these functions
 * mirror that behaviour exactly so a native reply chooses and delays the same
 * way, and can be tested without a DOM.
 */

import { AVAILABILITY_COPY, DEFAULT_REPLY_DELAY_MULTIPLIER, DEFAULT_TALKATIVENESS, MAX_THREAD_MESSAGES } from '../../public/scripts/neconyan-conversation/constants.js';
import { isCharacterMentionedInText, collectConversationPartnerAvatars, mergeConversationPartnerSettings, selectChimePartners, buildPartnerChimeDirective } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { getCurrentActivityFromSchedule } from '../../public/scripts/neconyan-conversation/schedule-utils.js';
import { buildAssistantKnowledge, getAssistantKnowledgeBudget, isNeconyanAssistant } from '../../public/scripts/neconyan-assistant-knowledge.js';
import { composePersonaDescription, conversationPersonaSelection } from '../../public/scripts/neconyan-conversation/persona-description.js';
import { buildConversationMessageReplyReference } from '../endpoints/conversation-messages.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, getCharacterData, getConversationSettings } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { clamp, parsePositiveInt, unScopeConversationStorageKey } from '../endpoints/conversation-utils.js';
import { captureChatProfile, captureGenerationBinding, getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { buildSavedConversationContext } from './conversation-context.js';
import { activeCharacterRegexHash } from './active-regex.js';
import { createMacroEnvironment } from '../macros/index.js';
import { validateActiveGenerationContext } from './service.js';
import { quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { captureBoundSpeechPolicy } from './speech-config.js';
import { resolveSavedImageFilters } from './quick-image-gen-filters.js';
import { captureQuickImageTextSettings } from './quick-image-gen-text.js';
import { buildSavedProxyImageContext } from './quick-image-gen-proxy.js';
import { captureBoundQuickImageReferenceSources } from './quick-image-gen-reference.js';
import { roleplayAccountBase, roleplayAccountStamp } from '../roleplay-store.js';

// Matches the browser regex: flexible whitespace and the curly apostrophe iOS
// keyboards produce, so "y’all" and "you  all" are broad addresses too.
const BROAD_GROUP_ADDRESS = /(^|\b)(everyone|everybody|anyone|someone|you\s+all|you\s+guys|y['’]?all|both\s+of\s+you|all\s+of\s+you)(\b|$)/i;
const AVAILABILITY_STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
const FALLBACK_ASSISTANT_KNOWLEDGE_TOKENS = 2048;

export function isBroadGroupAddress(text) {
    return BROAD_GROUP_ADDRESS.test(String(text || ''));
}

/** The saved speaker of a thread message, matching the browser's attribution. */
function messageSpeakerAvatar(message, threadAvatar) {
    if (!message || message.role === 'user' || message.role === 'system') return '';
    if (message.extra?.partner_avatar) return String(message.extra.partner_avatar);
    return threadAvatar;
}

function pickWeighted(pool, weightOf, random) {
    const total = pool.reduce((sum, candidate) => sum + weightOf(candidate), 0);
    if (!(total > 0)) return pool[0] || null;
    let roll = random() * total;
    for (const candidate of pool) {
        roll -= weightOf(candidate);
        if (roll < 0) return candidate;
    }
    return pool[pool.length - 1] || null;
}

/**
 * Choose who answers a group message. Ports the browser's weighted, mention-first
 * selection: named mentions win, then the previous eligible speaker, then a
 * recency-weighted draw, with an optional second speaker.
 */
export function chooseGroupReplyCandidates({ candidates = [], threadAvatar = '', messages = [], latestUserText = '', force = false, random = Math.random } = {}) {
    const all = candidates.filter(candidate => candidate?.avatar);
    if (!all.length) return { avatars: [] };
    const available = force ? all : all.filter(candidate => candidate.status !== 'offline');
    const pool = available.length ? available : all;
    const lastIndex = new Map();
    messages.forEach((message, index) => {
        const avatar = messageSpeakerAvatar(message, threadAvatar);
        if (avatar) lastIndex.set(avatar, index);
    });
    const weightOf = candidate => {
        const index = lastIndex.has(candidate.avatar) ? lastIndex.get(candidate.avatar) : -1;
        return 1 + (index < 0 ? messages.length + 1 : Math.max(1, messages.length - index));
    };
    const selected = [];
    const add = candidate => { if (candidate && !selected.includes(candidate)) selected.push(candidate); };

    // Mentions are matched inside the pool the browser would consider: an
    // offline member named by the user must not win over an available one.
    const mentioned = pool.filter(candidate => isCharacterMentionedInText({ name: candidate.name }, latestUserText, pool));
    for (const candidate of mentioned.slice(0, 2)) add(candidate);
    if (!selected.length && String(latestUserText).trim() && !isBroadGroupAddress(latestUserText)) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const avatar = messageSpeakerAvatar(messages[index], threadAvatar);
            const previous = pool.find(candidate => candidate.avatar === avatar);
            if (previous) { add(previous); break; }
        }
    }
    if (!selected.length) add(pickWeighted(pool, weightOf, random));
    if (selected.length < 2 && random() < 0.3) add(pickWeighted(pool.filter(candidate => !selected.includes(candidate)), weightOf, random));
    return { avatars: selected.map(candidate => candidate.avatar) };
}

/** The saved activity from a character's schedule, or null when it has none. */
export function resolveParticipantActivity(characters, avatar, personaId, overrides, now, timeZone) {
    const schedule = characters[avatar]?.schedule;
    const overrideKey = `${personaId}\u001f${avatar}`;
    if (!schedule && !(overrides && Object.hasOwn(overrides, overrideKey))) return null;
    return getCurrentActivityFromSchedule(schedule, overrideKey, new Date(now), new Map(Object.entries(overrides || {})), timeZone);
}

/** The manual availability fallback, matching the browser's getConversationActivityContext. */
export function manualActivity(settings) {
    const status = AVAILABILITY_STATUSES.has(settings?.availability) ? settings.availability : 'online';
    const copy = AVAILABILITY_COPY[status] || AVAILABILITY_COPY.online;
    return { status, activity: copy.detail.replace(/\.$/, '').toLowerCase(), source: 'manual' };
}

/**
 * What to do before replying. Forced replies bypass everything; an effective
 * offline status stops the reply; a solo thread then runs the raw manual
 * autoresponder before any idle/busy delay. The delay itself is sampled by
 * getInitialAvailabilityDelayMs so callers can freeze it before waiting.
 */
export function getConversationAvailabilityDecision({ settings = {}, activity = null, force = false, solo = true } = {}) {
    const status = String(activity?.status || settings.availability || 'online');
    if (force) return { action: 'reply', status };
    if (status === 'offline') return { action: 'skip', status };
    if (solo && ['offline', 'dnd'].includes(String(settings.availability || ''))) return { action: 'autoresponder', status };
    if (status === 'idle' || status === 'dnd') return { action: 'delay', status };
    return { action: 'reply', status };
}

/** The initial idle/busy wait, before the notice and before the model call. */
export function getInitialAvailabilityDelayMs(status, random = Math.random) {
    if (status === 'idle') return Math.round((random() * 1.5 + 1.5) * 1000);
    if (status === 'dnd') return Math.round((random() * 3 + 3) * 1000);
    return 0;
}

/** Text-length delivery delay for one bubble, independent of the initial wait. */
export function getReplyDelayMsForStatus(messageText, settings = {}, status = 'online') {
    const multiplier = clamp(parsePositiveInt(settings.reply_delay_multiplier, DEFAULT_REPLY_DELAY_MULTIPLIER, 0), 0, 300) / 100;
    if (multiplier <= 0) return 0;
    const baseMs = { online: 450, idle: 900, dnd: 1600, offline: 2200 }[status] ?? 450;
    const perCharMs = { online: 18, idle: 32, dnd: 52, offline: 68 }[status] ?? 18;
    const talkativeness = clamp(Number.isFinite(settings.talkativeness) ? settings.talkativeness : DEFAULT_TALKATIVENESS, 0, 100);
    const delay = (baseMs + String(messageText || '').length * perCharMs * (1.15 - talkativeness / 200)) * multiplier;
    return Math.min(9000, Math.max(350, Math.round(delay)));
}

export function buildAvailabilityAutoResponderText(settings, characterName, userName) {
    return String(settings?.offline_message || '[{{user}} is currently offline. Leave a message!]')
        .replace(/{{char}}/g, characterName).replace(/{{user}}/g, userName);
}

export function buildDelayedReplyNoticeText(speakerName, activity) {
    return `${speakerName} is ${activity} right now. Replies may take a little longer.`;
}

function localCharacters(current, personaId) {
    const characters = {};
    for (const [key, value] of Object.entries(current.store.characters || {})) {
        const local = unScopeConversationStorageKey(key, personaId);
        if (local !== null) characters[local] = value;
    }
    return characters;
}

export function getParticipantSettings(request, current, target, avatar) {
    const own = getConversationSettings(request, current.store, avatar, target.groupId, {}, { personaId: target.personaId });
    return !target.groupId && avatar !== target.avatar
        ? mergeConversationPartnerSettings(getConversationSettings(request, current.store, target.avatar, '', {}, { personaId: target.personaId }), own)
        : own;
}

export async function resolveConversationPartners(request, current, target, now = Date.now(), timeZone = 'UTC', { maxPartners = 128, strict = false } = {}) {
    if (target.groupId && !current.group) return [];
    const settings = getParticipantSettings(request, current, target, target.avatar);
    const avatars = collectConversationPartnerAvatars(target.avatar, settings, current.branch.messages, current.group)
        .filter(avatar => !target.groupId || (current.group.members.includes(avatar) && !current.group.disabled_members?.includes(avatar)));
    // ponytail: the background scan must stay total, so cap there; a real request
    // rejects rather than silently dropping partners.
    if (avatars.length > maxPartners) {
        if (strict) throw Object.assign(new Error('Too many Conversation partners.'), { status: 400 });
        avatars.length = maxPartners;
    }
    const characters = localCharacters(current, target.personaId);
    const partners = [];
    for (const avatar of avatars) {
        let character;
        try { character = await getCharacterData(request, avatar, { allowOverride: false, requireExisting: true }); } catch { continue; }
        const partnerSettings = getParticipantSettings(request, current, target, avatar);
        const activity = resolveParticipantActivity(characters, avatar, target.personaId, current.store.runtimeStatusOverrides, now, timeZone) || manualActivity(partnerSettings);
        partners.push({ avatar, name: character.name, status: activity.status, activity: activity.activity });
    }
    return partners;
}

/**
 * Freeze the participant list before any snapshot work, so a repair draws the
 * same people. Group members need a real card; a missing card drops the member
 * rather than inventing a fallback character.
 */
export async function buildConversationParticipantPlan(request, current, target, { force = false, now = Date.now(), timeZone = 'UTC', random = Math.random, explicitSpeaker = '', includeChimes = false } = {}) {
    const explicit = String(explicitSpeaker || '').trim();
    if (!target.groupId) {
        const primary = { avatar: explicit || target.avatar, purpose: 'reply', gate: true };
        if (!includeChimes || explicit) return [primary];
        const settings = getParticipantSettings(request, current, target, target.avatar);
        const activity = resolveParticipantActivity(localCharacters(current, target.personaId), target.avatar, target.personaId,
            current.store.runtimeStatusOverrides, now, timeZone) || manualActivity(settings);
        if (['skip', 'autoresponder'].includes(getConversationAvailabilityDecision({ settings, activity, force }).action)) return [primary];
        const partners = await resolveConversationPartners(request, current, target, now, timeZone);
        const selected = selectChimePartners({ settings, branch: current.branch, partners, now, random });
        if (!selected.length) return [primary];
        const host = await getCharacterData(request, target.avatar, { allowOverride: false });
        const userName = String(current.settings.power_user?.personas?.[target.personaId] || current.settings.name1 || 'User');
        const activityKey = String(Number(current.branch.lastActivity) || 0);
        return [primary, ...selected.map(partner => ({ avatar: partner.avatar, purpose: 'chime', gate: false,
            directive: buildPartnerChimeDirective(partner, host.name, userName),
            extra: { conversation_mode_chime: true, partner_avatar: partner.avatar },
            automation: { key: `send-chime:${activityKey}`, patch: { sessionMarkers: { sb_conv_last_chime_session_: activityKey }, markAutoMessage: true } },
        }))];
    }
    // An explicit reply target replaces mention-weighted selection: the user
    // named the speaker, so exactly that member answers.
    if (explicit) return [{ avatar: explicit, purpose: 'reply', gate: false }];
    const group = current.group;
    const characters = localCharacters(current, target.personaId);
    const candidates = [];
    for (const raw of [...new Set(group?.members || [])]) {
        const avatar = typeof raw === 'string' ? raw.trim() : '';
        if (!avatar || group.disabled_members?.includes(avatar)) continue;
        let character;
        try {
            character = await getCharacterData(request, avatar, { allowOverride: false, requireExisting: true });
        } catch {
            continue;
        }
        const settings = getConversationSettings(request, current.store, avatar, target.groupId, {}, { personaId: target.personaId });
        const activity = resolveParticipantActivity(characters, avatar, target.personaId, current.store.runtimeStatusOverrides, now, timeZone) || manualActivity(settings);
        candidates.push({ avatar, name: character.name, status: activity.status });
    }
    // Coalesced sends append several user bubbles; the browser matches mentions
    // across the whole batch, so join the trailing run of user messages.
    const batch = [];
    for (let index = current.branch.messages.length - 1; index >= 0; index -= 1) {
        const message = current.branch.messages[index];
        if (message.role !== 'user') break;
        batch.unshift(String(message.mes || ''));
    }
    const latestUserText = batch.join('\n\n');
    const { avatars } = chooseGroupReplyCandidates({ candidates, threadAvatar: target.avatar, messages: current.branch.messages, latestUserText, force, random });
    const chosen = avatars.length ? avatars : [target.avatar];
    return chosen.map(avatar => ({ avatar, purpose: 'reply', gate: false }));
}

/** Capture all eligible connections before accepting input; speaker selection still uses the complete batch. */
export async function captureConversationParticipantBindings(request, current, target, { plan = null, explicitSpeaker = '', acknowledgement = null, proposedMessages = [], directive = '', manualOptions, bindingOnly = false, includeChimes = false } = {}) {
    let avatars = plan ? plan.map(item => item.avatar) : explicitSpeaker ? [explicitSpeaker] : target.groupId
        ? current.group.members.filter(avatar => !current.group.disabled_members?.includes(avatar)) : [target.avatar];
    if (includeChimes && !target.groupId && !plan && !explicitSpeaker) avatars.push(...(await resolveConversationPartners(request, current, target, Date.now(), 'UTC', { strict: true })).map(partner => partner.avatar));
    if (avatars.length > 128) throw Object.assign(new Error('Too many Conversation participants.'), { status: 400 });
    if (target.groupId && !plan && !explicitSpeaker) {
        const existing = [];
        for (const avatar of avatars) {
            try { await getCharacterData(request, avatar, { allowOverride: false, requireExisting: true }); existing.push(avatar); } catch { /* Missing cards are not eligible speakers. */ }
        }
        avatars = existing.length ? existing : [target.avatar];
    }
    const bindings = Object.fromEntries([...new Set(avatars)].sort().map(avatar => {
        const settings = getParticipantSettings(request, current, target, avatar);
        if (String(settings.connection_profile || '').trim()) return [avatar, captureChatProfile(request.user.directories, settings.connection_profile)];
        if (!acknowledgement) throw Object.assign(new Error('Save and acknowledge the active connection before generating a reply.'), { status: 409, apiError: 'active_settings_ack_required' });
        if (acknowledgement.account !== request.user.profile.handle) throw Object.assign(new Error('account_changed'), { status: 409, apiError: 'account_changed' });
        return [avatar, captureGenerationBinding(request.user.directories, { kind: 'active' }, acknowledgement)];
    }));
    for (const [avatar, binding] of Object.entries(bindings)) {
        if (binding.kind !== 'active') continue;
        const material = resolveGenerationProfile(request.user.directories, binding);
        const character = await getCharacterData(request, avatar, { allowOverride: false, requireExisting: Boolean(target.groupId) });
        binding.characterRegexHash = activeCharacterRegexHash(material, avatar, character);
        if (bindingOnly) continue;
        const proposed = { ...current, branch: { ...current.branch,
            messages: [...current.branch.messages, ...proposedMessages.map(message => ({ ...message, role: 'user' }))].slice(-MAX_THREAD_MESSAGES) } };
        const snapshot = await buildConversationParticipantSnapshot(request, proposed, target, { avatar }, { binding, directive, timeZone: 'UTC' });
        const { prompt, ...rawOptions } = manualOptions || { prompt: snapshot.messages.slice(1), systemPrompt: snapshot.messages[0].content };
        delete rawOptions.responseLength;
        await validateActiveGenerationContext(material, createMacroEnvironment(snapshot.macros), prompt, rawOptions, {
            maxTokens: manualOptions?.responseLength || snapshot.settings.reply_max_tokens, groupNames: snapshot.groupNames,
        });
    }
    return bindings;
}

/** Build one participant's frozen request. The native target stays the thread's, only the speaker changes. */
export async function buildConversationParticipantSnapshot(request, current, target, plan, { directive, timeZone, binding, force = false, now = Date.now(), extra = {}, automation = null, referenceMessageId = '' } = {}) {
    const directories = request.user.directories;
    const avatar = plan.avatar;
    const settings = getParticipantSettings(request, current, target, avatar);
    if (!binding) throw Object.assign(new Error('The accepted participant connection is unavailable. Saved messages have been kept.'), { status: 409 });
    const material = resolveGenerationProfile(directories, binding);
    // Group members must have a real card; the solo thread avatar keeps the
    // legacy fallback so an avatar without a loaded card still replies.
    const character = await getCharacterData(request, avatar, { allowOverride: false, requireExisting: Boolean(target.groupId) || plan.purpose === 'chime' });
    if (binding.kind === 'active' && binding.characterRegexHash !== activeCharacterRegexHash(material, avatar, character)) {
        throw Object.assign(new Error('The captured character output transformations changed.'), { status: 409 });
    }
    const userName = String(current.settings.power_user?.personas?.[target.personaId] || current.settings.name1 || 'User');
    const messages = await buildConversationPromptMessages(current.branch.messages, directive, character.name, {
        groupId: target.groupId, userName, userDirectories: directories,
    });
    const timeContext = `Current system time context: ${new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(now)}. Timezone: ${timeZone}.`;
    const descriptor = current.settings.power_user?.persona_descriptions?.[target.personaId];
    const personaContext = composePersonaDescription(descriptor, conversationPersonaSelection(descriptor,
        getConversationThreadKey(target.avatar, target.groupId, target.personaId), getConversationThreadKey(target.avatar, target.groupId, '')));
    const savedContext = await buildSavedConversationContext(request, current, target, character, settings, timeZone, now, { speakerAvatar: avatar });
    const characters = localCharacters(current, target.personaId);
    const activity = resolveParticipantActivity(characters, avatar, target.personaId, current.store.runtimeStatusOverrides, now, timeZone) || manualActivity(settings);
    let system = buildConversationSystemPrompt({ settings, character, userName, groupId: target.groupId, branch: current.branch, context: {
        ...savedContext.context, timeContext, personaContext,
        availability: (AVAILABILITY_COPY[current.store.userStatus] || AVAILABILITY_COPY.online).label.toLowerCase(),
        personaStatus: String(current.store.userPersonaStatus || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    } });
    let assistantKnowledgeTokens = null;
    if (isNeconyanAssistant(character)) {
        let limit = null;
        try {
            limit = getChatProfileContextLimit(directories, binding);
        } catch {
            limit = null;
        }
        const usable = limit && limit > settings.reply_max_tokens ? limit - settings.reply_max_tokens : null;
        assistantKnowledgeTokens = usable ? getAssistantKnowledgeBudget(usable) : FALLBACK_ASSISTANT_KNOWLEDGE_TOKENS;
        const knowledge = await buildAssistantKnowledge({ character, messages: current.branch.messages, maxTokens: assistantKnowledgeTokens });
        if (knowledge.text) system = `${system}\n\n${knowledge.text}`;
    }
    const groupMembers = target.groupId ? await Promise.all(current.group.members.map(async member => ({
        avatar: member, name: (member === avatar ? character : await getCharacterData(request, member, { allowOverride: false })).name,
    }))) : [];
    const groupNames = groupMembers.map(member => member.name);
    const imageSettings = settings.image_gen_enabled
        ? resolveCharacterImageSettings(current.settings.extension_settings?.['quick-image-gen'] || {}, { avatar }) : null;
    const snapshot = {
        target, binding, settings, force, purpose: plan.purpose || 'reply', timeZone,
        ...(settings.image_gen_enabled ? { quickImageGenCharacterScope: { avatar }, quickImageGenSettingsFingerprint:
            quickImageGenSettingsFingerprint(imageSettings),
        quickImageGenSDSettingsFingerprint: quickImageGenSettingsFingerprint(
            current.settings.extension_settings?.sd || current.settings.extension_settings?.['stable-diffusion'] || {}) } : {}),
        speaker: { avatar, name: character.name }, speakers: savedContext.speakers, userName, groupNames, now,
        activity, gate: plan.gate === true, assistantKnowledgeTokens,
        extra: plan.extra && typeof plan.extra === 'object' ? plan.extra : extra,
        automation,
        messages: [{ role: 'system', content: system }, ...messages],
        // An autonomous message starts a topic; it must not quote the last chat.
        // An explicit reply target quotes the exact message the user replied to,
        // not whichever message happens to be newest when the reply is written.
        replyReference: automation ? null : buildConversationMessageReplyReference(
            (referenceMessageId && current.branch.messages.find(message => String(message?.id || '') === String(referenceMessageId)))
            || [...current.branch.messages].reverse().find(message => message.role !== 'system'),
        ),
        macros: {
            names: { user: userName, char: character.name, group: groupNames.join(', ') || character.name,
                groupNotMuted: groupMembers.filter(member => !current.group.disabled_members?.includes(member.avatar)).map(member => member.name).join(', ') || character.name,
                notChar: [...groupNames.filter(name => name !== character.name), userName].join(', ') },
            character: { description: character.description, personality: character.personality, scenario: character.scenario,
                persona: personaContext, charPrompt: character.system_prompt, charInstruction: character.post_history_instructions,
                mesExamplesRaw: character.mes_example, version: character.character_version, creatorNotes: character.creator_notes,
                firstMessage: character.first_mes, alternateGreetings: character.alternate_greetings, charDepthPrompt: character.extensions.depth_prompt?.prompt || '' },
            system: { model: material.profile.model },
            variables: { global: current.settings.extension_settings?.variables?.global || {}, local: {} },
            extra: { character, characterAvatar: avatar,
                chat: current.branch.messages.map(message => ({ ...message, is_user: message.role === 'user', is_system: message.role === 'system', send_date: message.timestamp })),
                chatMetadata: {}, powerUser: current.settings.power_user || {} },
        },
    };
    if (imageSettings && Array.isArray(imageSettings._backupContextualFilters)
        && imageSettings._backupContextualFilters.some(filter => filter?.enabled !== false && filter?.matchMode === 'LLM')) {
        const environment = createMacroEnvironment(snapshot.macros, {}, { readOnly: true });
        if (resolveSavedImageFilters(imageSettings, snapshot, '', environment).llm.length) {
            snapshot.quickImageGenTextAI = captureQuickImageTextSettings(directories, imageSettings,
                binding.kind ? binding : { kind: 'profile', ...binding }, [{}, ...snapshot.macros.extra.chat.map(message => ({ ...message,
                    mes: message.content || message.mes || '', name: message.role === 'user' ? userName : character.name }))]);
            snapshot.quickImageGenLLMBinding = snapshot.quickImageGenTextAI.binding;
        }
    }
    if (imageSettings?.provider === 'proxy' && imageSettings.proxyChatImageIncludePersonality) {
        snapshot.quickImageGenProxyContext = buildSavedProxyImageContext(snapshot);
    }
    if (imageSettings) {
        const imageBase = roleplayAccountBase(directories);
        if (!imageBase) throw Object.assign(new Error('Image generation requires a protected account.'), { status: 409 });
        snapshot.quickImageGenAccount = roleplayAccountStamp(imageBase);
        snapshot.quickImageGenReferenceSources = captureBoundQuickImageReferenceSources(directories, imageSettings);
    }
    Object.assign(snapshot, captureBoundSpeechPolicy(directories, current.settings));
    return snapshot;
}
