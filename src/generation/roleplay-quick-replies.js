import fs from 'node:fs';
import path from 'node:path';
import { getQuickReplySetNameKey } from '../../public/scripts/extensions/quick-reply/src/quick-reply-set-list.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { assertRoleplayWorldInfoCurrent } from './world-info.js';
import { readRoleplayFile, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';

const fail = (message, code = 'ROLEPLAY_QUICK_REPLY_UNSUPPORTED') => roleplayError(code, message, 409);
const MAX_RESULT = 2 * 1024 * 1024;
const KEY = /^[A-Za-z0-9_.-]{1,128}$/;

function parseCommand(item, disabled) {
    if (disabled || typeof item.message !== 'string' || !item.message.trim().startsWith('/')) {
        throw fail('This automatic Quick Reply needs a browser composer and cannot run with pages closed.');
    }
    const source = item.message.trim();
    if (source.includes('|') || /\n\s*\//u.test(source) || /\{\{|\}\}/u.test(source)) {
        throw fail('This Quick Reply script needs a browser-only command or macro.');
    }
    const match = /^\/(setvar|setchatvar|addvar|addchatvar|getvar|getchatvar)\s+([\s\S]+)$/iu.exec(source);
    if (!match) throw fail('This Quick Reply command has no saved server action.');
    const operation = match[1].toLowerCase().replace('chatvar', 'var');
    const args = /^key=([^\s]+)(?:\s+([\s\S]*))?$/u.exec(match[2]);
    const key = args ? args[1] : operation === 'getvar' ? match[2].trim() : '';
    const value = args?.[2]?.trim() ?? '';
    if (!KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
        || operation !== 'getvar' && !value || operation === 'getvar' && value) {
        throw fail('This Quick Reply variable command is not a supported complete instruction.');
    }
    if (Buffer.byteLength(value) > 64 * 1024) throw fail('This Quick Reply value is too large.');
    return { operation, key, ...(operation === 'getvar' ? {} : { value }) };
}

function boundCommands(directories, policy, actions) {
    const directory = directories.quickreplies ?? path.join(directories.root, 'QuickReplies');
    const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json')) : [];
    if (names.length > 256) throw fail('The saved Quick Reply collection changed.', 'ROLEPLAY_QUICK_REPLY_SOURCE_CHANGED');
    const found = new Map();
    for (const filename of names) {
        const file = readRoleplayFile(path.join(directory, filename), 1024 * 1024);
        let value;
        try { value = JSON.parse(file.bytes.toString('utf8')); } catch { continue; }
        const key = getQuickReplySetNameKey(value);
        if (!policy.sets.some(set => getQuickReplySetNameKey(set.name) === key)) continue;
        if (found.has(key)) throw fail('Two saved Quick Reply sets claim the same source.', 'ROLEPLAY_QUICK_REPLY_SOURCE_CHANGED');
        found.set(key, { value, file });
    }
    return actions.map(action => {
        if (action.kind !== 'quick-reply') throw fail('An automatic action is not a Quick Reply.');
        const set = policy.sets.find(item => item.name === action.set);
        const selected = found.get(getQuickReplySetNameKey(action.set));
        if (!set || !selected || set.rawHash !== selected.file.rawHash
            || roleplayHash(set.physical) !== roleplayHash(selected.file.physical)) {
            throw fail('A linked Quick Reply set changed after admission.', 'ROLEPLAY_QUICK_REPLY_SOURCE_CHANGED');
        }
        const items = selected.value.version === 2 ? selected.value.qrList : selected.value.quickReplySlots;
        const item = selected.value.version === 2 ? items?.find(entry => entry.id === action.id) : items?.[action.id - 1];
        if (!item || roleplayHash(item) !== action.scriptHash || item.automationId !== action.automationId) {
            throw fail('A linked Quick Reply script changed after admission.', 'ROLEPLAY_QUICK_REPLY_SOURCE_CHANGED');
        }
        return { action, command: parseCommand(item, selected.value.disableSend === true) };
    });
}

function addValue(previous, value) {
    let list;
    try { list = JSON.parse(previous); } catch { /* An ordinary text value is not a list. */ }
    if (Array.isArray(list)) return JSON.stringify([...list, value]);
    const left = previous || 0;
    const next = Number(left) + Number(value);
    if (Number.isNaN(Number(left)) || Number.isNaN(Number(value))) return String(left || '') + value;
    if (!Number.isFinite(next)) throw fail('The saved Quick Reply number is not finite.');
    return next;
}

/** Pure, bounded actions are staged before the paid main reply and committed with that reply. */
export function prepareRoleplayQuickReplies(context, { base, snapshot, source, worldInfo }) {
    const actions = worldInfo.hookEvents.actions;
    if (!actions.length) return null;
    if (!snapshot.hookPolicy?.quickReply?.enabled || actions.length > 256) throw fail('The activated Quick Reply actions are invalid.');
    const identity = roleplayHash({ intent: context.job.intent, worldInfoHash: roleplayHash(worldInfo), actions });
    const previous = withRoleplayAccount(base, snapshot.account, () => readArtifact(context.directories, context.job.id, 'roleplay-quick-replies'));
    if (previous !== undefined) {
        const { hash, ...data } = previous ?? {};
        if (hash !== roleplayHash(data) || data.identity !== identity || !Array.isArray(data.changes)
            || !data.local || typeof data.local !== 'object' || Array.isArray(data.local)) {
            throw fail('The saved Quick Reply result needs recovery.', 'ROLEPLAY_QUICK_REPLY_RECOVERY');
        }
        return previous;
    }
    assertRoleplayWorldInfoCurrent(base, snapshot);
    return withRoleplayAccount(base, snapshot.account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        const resolved = boundCommands(context.directories, snapshot.hookPolicy.quickReply, actions);
        const current = saved.records[0].chat_metadata?.variables ?? {};
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw fail('The saved chat variables are damaged.');
        const local = structuredClone(current), changes = [], results = [];
        for (const { action, command } of resolved) {
            const before = Object.hasOwn(local, command.key) ? local[command.key] : null;
            if (command.operation === 'getvar') results.push({ action, value: before });
            else {
                const after = command.operation === 'addvar' ? addValue(before, command.value) : command.value;
                local[command.key] = after;
                changes.push({ action, key: command.key, before, after });
                results.push({ action, value: after });
            }
        }
        const data = { identity, actions, changes, results, local, baseline: roleplayHash(current) };
        const value = { ...data, hash: roleplayHash(data) };
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT) throw fail('The activated Quick Reply result exceeds its saved limit.');
        writeArtifact(context.directories, context.job.id, 'roleplay-quick-replies', value);
        return value;
    });
}

export function assertRoleplayQuickReplyProof(directories, job, records, output) {
    const actions = output.quickReply?.actions;
    if (!Array.isArray(actions) || !actions.length || !job.intent.request?.worldInfo?.hookPolicy?.quickReply?.enabled) {
        throw fail('This job has no authorised automatic Quick Reply actions.', 'ROLEPLAY_QUICK_REPLY_RECOVERY');
    }
    const stored = readArtifact(directories, job.id, 'roleplay-quick-replies');
    const { hash, ...data } = stored ?? {};
    const current = records[0].chat_metadata?.variables ?? {};
    const selection = readArtifact(directories, job.id, 'roleplay-world-info');
    if (!stored || hash !== roleplayHash(data) || output.quickReply.hash !== hash
        || !selection || roleplayHash(actions) !== roleplayHash(selection.hookEvents?.actions)
        || roleplayHash(actions) !== roleplayHash(stored.actions)
        || stored.identity !== roleplayHash({ intent: job.intent, worldInfoHash: roleplayHash(selection), actions })
        || stored.baseline !== roleplayHash(current) || !Array.isArray(stored.changes)
        || roleplayHash(output.quickReply.changes) !== roleplayHash(stored.changes)) {
        throw fail('The saved Quick Reply completion needs recovery.', 'ROLEPLAY_QUICK_REPLY_RECOVERY');
    }
    const expected = structuredClone(current);
    for (const change of stored.changes) {
        if (!KEY.test(change.key) || ['__proto__', 'constructor', 'prototype'].includes(change.key)
            || roleplayHash(Object.hasOwn(expected, change.key) ? expected[change.key] : null) !== roleplayHash(change.before)) {
            throw fail('The saved Quick Reply variable source changed.', 'ROLEPLAY_QUICK_REPLY_SOURCE_CHANGED');
        }
        expected[change.key] = change.after;
    }
    if (roleplayHash(expected) !== roleplayHash(stored.local)) {
        throw fail('The saved Quick Reply variables differ from the accepted actions.', 'ROLEPLAY_QUICK_REPLY_RECOVERY');
    }
    for (const change of stored.changes) {
        records[0].chat_metadata ??= {};
        records[0].chat_metadata.variables ??= {};
        records[0].chat_metadata.variables[change.key] = change.after;
    }
    return stored;
}
