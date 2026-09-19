import { createHash } from 'node:crypto';
import { deliverConversationReply } from '../../public/scripts/neconyan-conversation/reply-delivery.js';
import { composePersonaDescription, conversationPersonaSelection } from '../../public/scripts/neconyan-conversation/persona-description.js';
import { AVAILABILITY_COPY } from '../../public/scripts/neconyan-conversation/constants.js';
import { buildConversationMessageReplyReference } from '../endpoints/conversation-messages.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, getCharacterData, getConversationSettings, getDefaultDirective } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, listJobs, setJobResume } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { createMacroEnvironment } from '../macros/index.js';
import { appendConversationJobMessage, captureConversationTarget, commitConversationEffect, commitConversationJobCommands, readConversationTarget } from './conversation-effects.js';
import { captureChatProfile } from './profiles.js';
import { runChatProfile } from './service.js';
import { buildSavedConversationContext } from './conversation-context.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

/** Accept a reply to an already-saved native branch. No credentials or browser prompt are accepted. */
export async function acceptConversationReply(request, body) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) fail('A submission key is required.', 400);
    if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) fail('A saved Conversation target is required.', 400);
    if (body.directive !== undefined && (typeof body.directive !== 'string' || body.directive.length > 20000)) fail('The reply directive is invalid.', 400);
    const timeZone = typeof body.timeZone === 'string' ? body.timeZone : 'UTC';
    try { new Intl.DateTimeFormat('en-GB', { timeZone }).format(); } catch { fail('The reply timezone is invalid.', 400); }
    const intent = {
        target: { avatar: body.target.avatar, groupId: body.target.groupId || '', personaId: body.target.personaId || '', branchId: body.target.branchId },
        directive: getDefaultDirective(body), timeZone,
    };
    const existing = listJobs(directories, { owner, includeDismissed: true }).find(job => job.submissionKey === body.submissionKey);
    if (existing) {
        if (existing.type !== 'conversation.reply' || hash(existing.intent) !== hash(intent)) fail('This submission key already belongs to another operation.');
        return { job: existing, created: false };
    }
    const target = captureConversationTarget(request, intent.target);
    const current = readConversationTarget(request, target);
    const settings = getConversationSettings(request, current.store, target.avatar, target.groupId, {}, { personaId: target.personaId });
    const binding = captureChatProfile(directories, settings.connection_profile);
    const character = await getCharacterData(request, target.avatar, { allowOverride: false });
    const userName = String(current.settings.power_user?.personas?.[target.personaId] || current.settings.name1 || 'User');
    const messages = await buildConversationPromptMessages(current.branch.messages, intent.directive, character.name, {
        groupId: target.groupId, userName, userDirectories: directories,
    });
    const now = Date.now();
    const timeContext = `Current system time context: ${new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(now)}. Timezone: ${timeZone}.`;
    const descriptor = current.settings.power_user?.persona_descriptions?.[target.personaId];
    const personaContext = composePersonaDescription(descriptor, conversationPersonaSelection(descriptor,
        getConversationThreadKey(target.avatar, target.groupId, target.personaId), getConversationThreadKey(target.avatar, target.groupId, '')));
    const savedContext = await buildSavedConversationContext(request, current, target, character, settings, timeZone, now);
    const system = buildConversationSystemPrompt({ settings, character, userName, groupId: target.groupId, branch: current.branch, context: {
        ...savedContext.context, timeContext, personaContext,
        availability: (AVAILABILITY_COPY[current.store.userStatus] || AVAILABILITY_COPY.online).label.toLowerCase(),
        personaStatus: String(current.store.userPersonaStatus || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    } });
    if (hash(captureConversationTarget(request, target)) !== hash(target)) fail('The Conversation branch changed during acceptance.');
    const snapshot = {
        target, binding, settings, speaker: { avatar: target.avatar, name: character.name }, speakers: savedContext.speakers, userName, now,
        messages: [{ role: 'system', content: system }, ...messages],
        replyReference: buildConversationMessageReplyReference([...current.branch.messages].reverse().find(message => message.role !== 'system')),
        macros: { names: { user: userName, char: character.name }, extra: { chat: current.branch.messages, chatMetadata: {}, powerUser: current.settings.power_user || {} } },
    };
    // Both writes are synchronous. An interruption between them leaves an explicit missing-snapshot job, never a paid request.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024) fail('The Conversation request snapshot is too large.', 413);
    const accepted = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: body.submissionKey, intent,
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: {}, label: 'Conversation reply' });
    if (accepted.created) writeArtifact(directories, accepted.job.id, 'request', snapshot);
    noteOwner(owner);
    return accepted;
}

/** A completed provider response and every native bubble can be resumed independently. */
export function registerConversationReplyJob({ generate = runChatProfile, generateImage } = {}) {
    registerHandler('conversation.reply', async context => {
        const snapshot = readArtifact(context.directories, context.job.id, 'request');
        if (!snapshot) fail('The accepted Conversation snapshot is unavailable. Resubmit the request.');
        if (readArtifact(context.directories, context.job.id, 'result')) return { artifact: true };
        const { target, binding, speaker, settings, userName } = snapshot;
        // A receipt-only checkpoint validates current ownership and the source before any model call.
        await commitConversationEffect(context, target, 'accepted', () => null);
        const current = readConversationTarget({ user: { directories: context.directories } }, target);
        const receipt = current.branch.serverOperations?.[hash(context.job.id)];
        if (hash(current.branch.messages) !== (receipt?.messagesHash || target.messagesHash)) fail('The Conversation messages changed before generation.');
        let response = readArtifact(context.directories, context.job.id, 'reply');
        if (!response) {
            response = await generate({ context, jobContext: context, binding, messages: snapshot.messages,
                maxTokens: settings.reply_max_tokens, userName, characterName: speaker.name,
                macroEnvironment: createMacroEnvironment(snapshot.macros) });
            writeArtifact(context.directories, context.job.id, 'reply', response);
        }
        if (typeof response.text !== 'string' || !response.text.trim()) fail('The model returned an empty Conversation reply.', 502);
        if (Buffer.byteLength(response.text) > 256 * 1024) fail('The model reply exceeded the Conversation message limit.', 502);
        setJobResume(context.directories, context.job.id, 'delivery');
        const result = await deliverConversationReply(response.text, settings, {
            fallbackSpeaker: speaker, groupId: target.groupId, getSpeakers: () => snapshot.speakers,
            validateTarget: () => { context.signal.throwIfAborted(); return true; },
            append: (text, author, delivery) => {
                const group = readConversationTarget({ user: { directories: context.directories } }, target).group;
                if (target.groupId && (!group?.members?.includes(author.avatar) || group.disabled_members?.includes(author.avatar))) fail('The reply participant is no longer available.');
                return appendConversationJobMessage(context, target, `bubble:${delivery.chunk}:${delivery.bubble}`, {
                    role: author.avatar === target.avatar ? 'character' : 'partner', name: author.name, mes: text,
                    extra: { ...delivery.extra, ...(author.avatar !== target.avatar ? { partner_avatar: author.avatar } : {}),
                        ...(delivery.attachReplyReference && snapshot.replyReference ? { conversation_reply_to: snapshot.replyReference } : {}) },
                });
            },
            commitCommands: (parts, avatar, delivery) => commitConversationJobCommands(context, target, `commands:${delivery.chunk}`, parts, avatar, context.job.intent.timeZone, snapshot.now),
            generateImage: async (...args) => {
                if (!generateImage) throw Object.assign(new Error('This reply needs server image delivery before it can finish. Its text and model response have been saved.'), { status: 409, recoverable: true });
                return generateImage(context, snapshot, ...args);
            },
        });
        writeArtifact(context.directories, context.job.id, 'result', result);
        return { artifact: true };
    });
}

registerConversationReplyJob();
