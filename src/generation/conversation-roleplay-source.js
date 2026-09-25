import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { readChatJsonlStrict } from '../chat-recovery.js';
import { chatPath, normalizeLocator } from '../mewmory/store.js';
import { roleplayAccountBase, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { readRoleplayChatLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { buildConversationRoleplayContext, formatPromptText } from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { buildGroupAsideDirective, buildRoleplayDMDirective, getRoleplayGroupRevision, getRoleplaySourceMessageRevision } from '../../public/scripts/neconyan-conversation/roleplay-source.js';

const GROUP_ASIDE_CONTEXT_LIMIT = 8;
const GROUP_ASIDE_COOLDOWN_MS = 8 * 60 * 1000;
const GROUP_ASIDE_MENTION_COOLDOWN_MS = 45 * 1000;
const MENTION_DELAY_MS = 900;
const ASIDE_DELAY_MS = 2000;
const MAX_REVISION_BYTES = 512 * 1024;
const REASONS = new Set(['mention', 'reaction', 'random']);

function fail(message, status = 400, apiError = 'conversation_aside_failed') {
    return Object.assign(new Error(message), { status, apiError });
}

function isPrototypeKey(value) {
    return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

function assertKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw fail(`Invalid ${label}.`, 400, 'invalid_aside_submission');
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw fail(`Unexpected ${label} field: ${key}`, 400, 'invalid_aside_submission');
        }
    }
}

function identifier(value, label) {
    const parsed = typeof value === 'string' ? value.trim() : '';
    if (!parsed || isPrototypeKey(parsed)) {
        throw fail(`Invalid aside ${label}.`, 400, 'invalid_aside_submission');
    }
    return parsed;
}

function optionalIdentifier(value, label) {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    return identifier(value, label);
}

function revision(value, label) {
    if (typeof value !== 'string' || !value) {
        throw fail(`Invalid aside ${label}.`, 400, 'invalid_aside_submission');
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_REVISION_BYTES) {
        throw fail(`Oversized aside ${label}.`, 413, 'aside_source_too_large');
    }
    return value;
}

export function normalizeConversationAsideSubmission(body = {}) {
    assertKeys(body, ['target', 'source', 'messageIndex', 'messageRevision', 'groupRevision', 'reason'], 'aside submission');
    assertKeys(body.target, ['avatar', 'personaId', 'branchId'], 'aside target');
    assertKeys(body.source, ['locator', 'groupId'], 'aside source');
    assertKeys(body.source.locator, ['chat', 'avatar', 'group'], 'aside locator');

    const avatar = identifier(body.target.avatar, 'character');
    const personaId = optionalIdentifier(body.target.personaId, 'persona');
    const branchId = identifier(body.target.branchId, 'branch');
    let chat = identifier(body.source.locator.chat, 'chat name');
    // Strip every trailing suffix so `crew`, `crew.jsonl` and `crew.jsonl.jsonl`
    // stay one identity through file resolution and the occurrence key.
    while (/\.jsonl$/i.test(chat)) chat = chat.replace(/\.jsonl$/i, '');
    if (!chat || sanitize(chat) !== chat) {
        throw fail('Invalid aside chat name.', 400, 'invalid_aside_submission');
    }
    if (typeof body.source.locator.group !== 'boolean') {
        throw fail('Invalid aside locator group flag.', 400, 'invalid_aside_submission');
    }
    const group = body.source.locator.group;
    const locatorAvatar = optionalIdentifier(body.source.locator.avatar, 'character file');
    const sourceGroupId = optionalIdentifier(body.source.groupId, 'source group');
    if (!Number.isInteger(body.messageIndex) || body.messageIndex < 0) {
        throw fail('Invalid aside message index.', 400, 'invalid_aside_submission');
    }
    const messageIndex = body.messageIndex;
    const messageRevision = revision(body.messageRevision, 'message revision');
    const groupRevision = body.groupRevision ? revision(body.groupRevision, 'group revision') : '';
    const reason = body.reason;
    if (!REASONS.has(reason)) {
        throw fail('Invalid aside reason.', 400, 'invalid_aside_submission');
    }

    if (group) {
        if (locatorAvatar) {
            throw fail('A group aside locator cannot name a character file.', 400, 'invalid_aside_submission');
        }
        if (!sourceGroupId) {
            throw fail('A group aside requires a source group id.', 400, 'invalid_aside_submission');
        }
        if (!groupRevision) {
            throw fail('A group aside requires a group revision.', 400, 'invalid_aside_submission');
        }
    } else {
        if (sourceGroupId) {
            throw fail('A solo aside cannot name a source group.', 400, 'invalid_aside_submission');
        }
        if (groupRevision) {
            throw fail('A solo aside cannot carry a group revision.', 400, 'invalid_aside_submission');
        }
        if (!locatorAvatar) {
            throw fail('A solo aside requires a character file.', 400, 'invalid_aside_submission');
        }
        if (sanitize(locatorAvatar) !== locatorAvatar || locatorAvatar !== avatar) {
            throw fail('Invalid aside locator character file.', 400, 'invalid_aside_submission');
        }
    }

    return {
        target: { avatar, personaId, branchId },
        source: { locator: { chat, avatar: locatorAvatar, group }, groupId: sourceGroupId },
        messageIndex,
        messageRevision,
        groupRevision,
        reason,
    };
}

export function getConversationAsideOccurrenceKey(owner, submission) {
    const payload = [
        String(owner || ''),
        submission.target.avatar,
        submission.target.personaId,
        submission.target.branchId,
        submission.source.locator.chat,
        submission.source.locator.avatar,
        submission.source.locator.group ? '1' : '0',
        submission.source.groupId,
        String(submission.messageIndex),
        submission.messageRevision,
        submission.groupRevision,
        submission.reason,
    ];
    return `conv-aside:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export function getConversationGroupAsideCooldownMs(reason) {
    return reason === 'mention' ? GROUP_ASIDE_MENTION_COOLDOWN_MS : GROUP_ASIDE_COOLDOWN_MS;
}

export function getConversationGroupAsideLastSent(store, key) {
    const value = Number(store?.groupAsideLastSent?.[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildGroupContext(messages, endIndex) {
    const end = Math.min(messages.length, Math.max(0, Number(endIndex) + 1));
    const start = Math.max(0, end - GROUP_ASIDE_CONTEXT_LIMIT);
    const lines = [];
    for (let index = start; index < end; index += 1) {
        const message = messages[index];
        const text = String(message?.mes || '').trim();
        if (!text) {
            continue;
        }
        const speaker = message?.name || ((message?.is_user || message?.role === 'user') ? 'User' : 'Character');
        lines.push(`${speaker}: ${formatPromptText(text, 600)}`);
    }
    return lines.join('\n');
}

function readRoleplayGroup(directories, groupId) {
    const id = optionalIdentifier(groupId, 'source group');
    const filename = sanitize(`${id}.json`);
    if (!id || filename !== `${id}.json`) {
        throw fail('The source Roleplay group could not be found.', 404, 'roleplay_group_not_found');
    }
    const filePath = path.join(directories.groups, filename);
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw fail('The source Roleplay group could not be found.', 404, 'roleplay_group_not_found');
        }
        throw fail('The source Roleplay group could not be read.', 409, 'roleplay_group_unreadable');
    }
    let group;
    try {
        group = JSON.parse(raw);
    } catch {
        throw fail('The source Roleplay group could not be read.', 409, 'roleplay_group_unreadable');
    }
    if (String(group?.id || '') !== id) {
        throw fail('The source Roleplay group does not match its saved file.', 409, 'roleplay_group_chat_mismatch');
    }
    return group;
}

/**
 * Protected accounts read the aside source under the account lock, enrolling it
 * like any other Roleplay reader, so the accepted aside can bind the chat's
 * server-assigned instance. Accounts without protected storage keep the plain read.
 */
function readAsideSource(directories, locator, groupId, accountLease = null) {
    const base = roleplayAccountBase(directories);
    if (!base) {
        const record = readChatJsonlStrict(chatPath(directories, locator));
        if (record.status === 'missing') throw fail('The saved Roleplay chat could not be found.', 404, 'roleplay_chat_not_found');
        if (record.status !== 'ok' || !Array.isArray(record.records)) {
            throw fail('The saved Roleplay chat could not be read.', 409, 'roleplay_chat_unreadable');
        }
        return { records: record.records, instanceId: null, group: null };
    }
    try {
        const read = lease => {
            if (roleplayLease(lease).scope.directories.root !== directories.root) throw fail('The aside belongs to a different account.', 409);
            const chat = readRoleplayChatLocked(lease, locator);
            const group = groupId ? readRoleplayEntityLocked(lease, 'group', groupId) : null;
            if (chat.changed || group?.changed) saveRoleplayAccount(lease);
            return { records: chat.records, instanceId: chat.instanceId, group: group?.data ?? null };
        };
        return accountLease ? read(accountLease) : withRoleplayAccount(base, null, read);
    } catch (error) {
        if (!String(error?.code || '').startsWith('ROLEPLAY_')) throw error;
        if (error.code === 'ROLEPLAY_SOURCE_MISSING') {
            if (groupId && fs.existsSync(chatPath(directories, locator))) {
                throw fail('The source Roleplay group could not be found.', 404, 'roleplay_group_not_found');
            }
            throw fail('The saved Roleplay chat could not be found.', 404, 'roleplay_chat_not_found');
        }
        throw Object.assign(fail('The saved Roleplay chat could not be read.', 409, 'roleplay_chat_unreadable'), { code: error.code });
    }
}

export function captureConversationRoleplaySource(request, submission, { characterName = 'Character', userName = 'User', accountLease = null } = {}) {
    const directories = request?.user?.directories || {};
    let locator;
    try {
        locator = normalizeLocator({
            chat: submission.source.locator.chat,
            avatar: submission.source.locator.avatar,
            group: submission.source.locator.group,
        });
    } catch (error) {
        throw fail(error?.message || 'Invalid saved Roleplay locator.', 400, 'invalid_roleplay_locator');
    }

    const saved = readAsideSource(directories, locator, locator.group ? submission.source.groupId : '', accountLease);
    if (submission.instanceId !== undefined && submission.instanceId !== saved.instanceId) {
        throw fail('The saved Roleplay chat was replaced after this aside was accepted.', 409, 'roleplay_chat_replaced');
    }
    const messages = saved.records.slice(1);
    if (submission.messageIndex >= messages.length) {
        throw fail('The saved Roleplay message no longer exists.', 409, 'roleplay_message_out_of_range');
    }
    const sourceMessage = messages[submission.messageIndex];
    if (getRoleplaySourceMessageRevision(sourceMessage) !== submission.messageRevision) {
        throw fail('The saved Roleplay message changed after this aside was captured.', 409, 'roleplay_message_revision_mismatch');
    }
    if (submission.reason === 'mention' && !(sourceMessage?.is_user === true || sourceMessage?.role === 'user')) {
        throw fail('A mention aside requires a user-authored Roleplay message.', 409, 'roleplay_mention_not_user');
    }

    if (locator.group) {
        const group = saved.group ?? readRoleplayGroup(directories, submission.source.groupId);
        if (getRoleplayGroupRevision(group) !== submission.groupRevision) {
            throw fail('The source Roleplay group changed after this aside was captured.', 409, 'roleplay_group_revision_mismatch');
        }
        const ownedChats = new Set();
        if (Array.isArray(group.chats)) {
            for (const entry of group.chats) {
                const value = String(typeof entry === 'string' ? entry : entry?.file_name || entry?.fileName || entry?.chat_id || entry?.id || '').replace(/\.jsonl$/i, '');
                if (value) ownedChats.add(value);
            }
        }
        const currentChat = String(group.chat_id || '').replace(/\.jsonl$/i, '');
        if (currentChat) ownedChats.add(currentChat);
        if (ownedChats.size && !ownedChats.has(submission.source.locator.chat)) {
            throw fail('The saved Roleplay chat does not belong to the named group.', 409, 'roleplay_group_chat_mismatch');
        }
        const members = Array.isArray(group.members) ? group.members.map(String) : [];
        const disabled = Array.isArray(group.disabled_members) ? group.disabled_members.map(String) : [];
        if (!members.includes(submission.target.avatar) || disabled.includes(submission.target.avatar)) {
            throw fail('The recipient is no longer an active member of the source group.', 409, 'roleplay_member_unavailable');
        }
        const groupContext = buildGroupContext(messages, submission.messageIndex);
        if (!groupContext) {
            throw fail('The saved Roleplay chat has no usable context.', 409, 'roleplay_chat_unreadable');
        }
        return {
            kind: 'group-aside',
            delayMs: submission.reason === 'mention' ? MENTION_DELAY_MS : ASIDE_DELAY_MS,
            directive: buildGroupAsideDirective({ characterName, userName, reason: submission.reason, groupContext }),
            extra: {
                conversation_mode_group_aside: true,
                conversation_mode_gossip: true,
                gossip_source_group: true,
                group_aside_reason: submission.reason,
                source_group_id: String(group.id || submission.source.groupId),
                source_group_message_id: submission.messageIndex,
            },
            cooldownKey: JSON.stringify([submission.target.personaId, String(submission.source.groupId), submission.target.avatar]),
            locator,
            instanceId: saved.instanceId,
        };
    }

    const roleplayContext = buildConversationRoleplayContext(messages, submission.messageIndex).trim();
    if (!roleplayContext) {
        throw fail('The saved Roleplay chat has no usable context.', 409, 'roleplay_chat_unreadable');
    }
    return {
        kind: 'roleplay-aside',
        delayMs: ASIDE_DELAY_MS,
        directive: buildRoleplayDMDirective({ roleplayContext }),
        extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
        cooldownKey: '',
        locator,
        instanceId: saved.instanceId,
    };
}
