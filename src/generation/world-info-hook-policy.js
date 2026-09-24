import fs from 'node:fs';
import path from 'node:path';
import { AGENT_STORAGE_LIMITS, getAgentRecordError } from '../../public/scripts/extensions/in-chat-agents/setup-presets.js';
import { normalizeExtensionBootId } from '../../public/scripts/extension-boot-lifecycle/index.js';
import { getQuickReplySetNameKey } from '../../public/scripts/extensions/quick-reply/src/quick-reply-set-list.js';
import { readRoleplayFile, roleplayError, roleplayHash } from '../roleplay-store.js';

function savedJsonFiles(directory, limit, fileLimit, totalLimit, { skipInvalidJson = false } = {}) {
    let folder;
    try { folder = fs.lstatSync(directory); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    if (!folder.isDirectory()) throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved World Info hook directory needs recovery.', 409);
    const names = fs.readdirSync(directory).filter(name => name.toLowerCase().endsWith('.json')).sort();
    if (names.length > limit) throw roleplayError('ROLEPLAY_INVALID', 'Too many saved World Info hook records.', 409);
    let bytes = 0;
    return names.map(name => {
        const file = readRoleplayFile(path.join(directory, name), fileLimit);
        if (!file || (bytes += file.bytes.length) > totalLimit) {
            throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved World Info hook record needs recovery.', 409);
        }
        try {
            return { name, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)),
                rawHash: file.rawHash, physical: file.physical };
        } catch {
            if (skipInvalidJson) return null;
            throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved World Info hook record is unreadable.', 409);
        }
    }).filter(Boolean);
}

/** Captured under the Roleplay account lock; keep scripts and connection secrets out of job artifacts. */
export function captureWorldInfoHookPolicy(directories, settings, header, avatar, group) {
    const extensions = settings.extension_settings ?? {};
    const disabled = Array.isArray(extensions.disabledExtensions)
        ? extensions.disabledExtensions.map(normalizeExtensionBootId) : [];
    const global = extensions.inChatAgents?.globalSettings ?? {};
    const pathfinder = [];
    if (!disabled.includes('in-chat-agents') && global.enabled !== false && global.pathfinderEnabled !== false) {
        const scope = group ? 'group' : 'individual';
        for (const { name, value, physical } of savedJsonFiles(directories.inChatAgents ?? path.join(directories.root, 'InChatAgents'),
            AGENT_STORAGE_LIMITS.agentCount, AGENT_STORAGE_LIMITS.agentBytes, AGENT_STORAGE_LIMITS.collectionBytes)) {
            if (getAgentRecordError(value) || name !== `${value.id}.json`) {
                throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved Pathfinder agent needs recovery.', 409);
            }
            const scoped = global.separateRecentChats && global.scopedEnabledAgentIdsInitialized;
            const enabled = scoped ? global.enabledAgentIdsByChatType?.[scope]?.includes(value.id) : value.enabled;
            const candidate = value.category === 'tool' && (value.sourceTemplateId === 'tpl-pathfinder'
                || ['Pawthfinder', 'Pathfinder'].includes(value.name)
                || value.tools?.some(tool => tool.name?.startsWith('Pathfinder_')));
            if (enabled && candidate && (value.settings?.sidecarEnabled || value.settings?.pipelineEnabled)) {
                pathfinder.push({ id: value.id, revision: roleplayHash(value), physical });
            }
        }
    }
    const configured = extensions.quickReplyV2 ?? (extensions.quickReply ? {
        isEnabled: extensions.quickReply.quickReplyEnabled ?? false,
        config: { setList: [{ set: extensions.quickReply.selectedPreset ?? extensions.quickReply.name ?? 'Default' }] },
    } : null);
    if (configured?.isEnabled !== undefined && typeof configured.isEnabled !== 'boolean') {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved Quick Reply activation settings are invalid.', 409);
    }
    const quickReply = { enabled: !disabled.includes('quick-reply') && configured?.isEnabled === true, sets: [] };
    if (quickReply.enabled) {
        const links = [configured?.config?.setList, header?.quickReply?.setList,
            ...(group ? [] : [configured?.characterConfigs?.[avatar]?.setList])];
        const names = new Set();
        for (const list of links) {
            if (list !== undefined && !Array.isArray(list)) throw roleplayError('ROLEPLAY_INVALID', 'Saved Quick Reply links are invalid.', 409);
            for (const link of list ?? []) {
                if (typeof link?.set !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'A saved Quick Reply link is invalid.', 409);
                const key = getQuickReplySetNameKey(link.set);
                if (key) names.add(key);
            }
        }
        const records = savedJsonFiles(directories.quickreplies ?? path.join(directories.root, 'QuickReplies'),
            256, 1024 * 1024, 2 * 1024 * 1024, { skipInvalidJson: true });
        const found = new Map();
        for (const { value, rawHash, physical } of records) {
            const key = getQuickReplySetNameKey(value);
            if (!names.has(key) || found.has(key)) continue;
            if (typeof value.name !== 'string' || !value.name.trim()) {
                throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A linked Quick Reply set needs recovery.', 409);
            }
            const items = value.version === 2 ? value.qrList : value.quickReplySlots;
            if (!Array.isArray(items) || items.length > 1024) {
                throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved Quick Reply set needs recovery.', 409);
            }
            const commands = items.flatMap((item, index) => {
                if (!item?.automationId) return [];
                if (typeof item.automationId !== 'string' || (value.version === 2
                    && (!Number.isSafeInteger(item.id) || item.id < 1))) {
                    throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A linked Quick Reply action needs recovery.', 409);
                }
                return [{
                    id: value.version === 2 ? item.id : index + 1, automationId: item.automationId,
                    hash: roleplayHash(item),
                }];
            });
            found.set(key, { name: value.name, rawHash, physical, commands });
        }
        quickReply.sets = [...names].flatMap(name => found.has(name) ? [found.get(name)] : []);
    }
    return { pathfinder, quickReply };
}

export function worldInfoActivationActions(policy, activated) {
    if (!policy?.quickReply?.enabled) return [];
    const ids = new Set(activated.map(entry => entry.automationId).filter(Boolean));
    return policy.quickReply.sets.flatMap(set => set.commands.filter(item => ids.has(item.automationId)).map(item => ({
        kind: 'quick-reply', set: set.name, id: item.id, automationId: item.automationId, scriptHash: item.hash,
    })));
}
