/**
 * Conversation Mode REST API - DM delete
 *
 * Deleting a DM changes the server's own latest copy of the Conversation store
 * in one write and takes no client version: a page that has fallen behind still
 * deletes what it shows, and nothing the page holds is trusted. Open jobs for the
 * deleted threads are cancelled, so no reply or automatic message can recreate
 * them (a job in flight is also refused by the server's own checks, because the
 * thread it targets no longer exists or was replaced).
 */

import { getSettingsVersion } from '../settings-version.js';
import { getJob, isTerminal, listJobs, requestCancellation } from '../jobs/store.js';
import { abortJob } from '../jobs/runner.js';
import {
    getConversationThreadKey,
    readConversationStoreForWrite,
    readUserSettingsWithStatus,
    saveConversationStore,
} from './conversation-store.js';
import { normalizeConversationGroupRecord } from './conversation-groups.js';
import { normalizeConversationSettings } from './conversation-generation.js';
import { createConversationBranch } from './conversation-threads.js';
import {
    getConversationPersonaId,
    hasOwn,
    isObject,
    scopeConversationStorageKey,
    seedConversationReadBoundary,
    unScopeConversationStorageKey,
} from './conversation-utils.js';

const normalizeGroupRecord = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);
const CANCEL_REASON = 'The Conversation DM was deleted.';

/** The test the automation worker uses to decide whose reminder it is. */
const samePersona = (reminder, personaId) => String(reminder?.personaId || '') === String(personaId || '');

/** The record a deleted solo DM leaves when its pal has a Character Schedule: the schedule, nothing to answer from. */
function isScheduleOnlyRecord(record) {
    return isObject(record) && isObject(record.schedule)
        && (!record.settings || (isObject(record.settings) && !Object.keys(record.settings).length))
        && !record.memorySummary
        && Object.values(isObject(record.branches) ? record.branches : {})
            .every(branch => !branch?.memorySummary && !(Array.isArray(branch?.messages) && branch.messages.length));
}

function createKeptScheduleRecord(schedule) {
    const branch = createConversationBranch('Main', 'main');
    seedConversationReadBoundary(branch);
    return { settings: {}, schedule, activeBranchId: 'main', branches: { main: branch } };
}

/** Stop every open job whose target is one of the deleted or replaced threads, and the work below it. */
function cancelJobsForDeletedThreads(request, scope) {
    const directories = request.user.directories;
    const owner = request.user.profile?.handle;
    const replaced = new Set(Object.keys(scope.replaceKeys));
    const removed = new Set(scope.removeKeys);
    try {
        for (const job of listJobs(directories, { owner, includeDismissed: true })) {
            const id = job.target?.kind === 'conversation' ? job.target.id : null;
            if (typeof id !== 'string' || isTerminal(job)) continue;
            if (!removed.has(id) && !replaced.has(id) && !(scope.keyPrefix && id.startsWith(scope.keyPrefix))) continue;
            try {
                const requested = requestCancellation(directories, job.id, { reason: CANCEL_REASON });
                const pending = [requested.job.id];
                const visited = new Set();
                for (const jobId of pending) {
                    if (visited.has(jobId)) continue;
                    visited.add(jobId);
                    const current = getJob(directories, jobId);
                    if (!current || current.owner !== owner) continue;
                    pending.push(...(current.children ?? []));
                    abortJob(jobId);
                }
            } catch (error) {
                console.error('Conversation DM delete: a job could not be cancelled', error);
            }
        }
    } catch (error) {
        console.error('Conversation DM delete: jobs could not be listed', error);
    }
}

/**
 * Delete a solo DM (`avatar`) or a group DM (`groupId`) for one persona.
 * @returns {Promise<{ changed: boolean, scope: object, store: object, version: number } | { ok: false, status: number, body: object }>}
 */
export async function deleteConversationThreads(request, { avatar = '', groupId = '', personaId = '' } = {}) {
    const persona = getConversationPersonaId(personaId);
    const settings = readUserSettingsWithStatus(request);
    if (!settings.ok) return { ok: false, status: 500, body: { error: 'settings_read_failed' } };
    const version = getSettingsVersion(settings.data);
    // This read, the edit and the save below run in one tick, so there is nothing to retry.
    const context = readConversationStoreForWrite(request, version, normalizeGroupRecord);
    if (!context.ok) return context;
    const { store } = context;
    const scope = { removeKeys: [], keyPrefix: '', groupId: '', personaId: persona, reminderIds: [], replaceKeys: {} };
    let changed = false;

    if (groupId) {
        const unscopedPrefix = `group:${groupId}:`;
        scope.groupId = groupId;
        scope.keyPrefix = scopeConversationStorageKey(unscopedPrefix, persona);
        for (const key of Object.keys(store.characters)) {
            const local = unScopeConversationStorageKey(key, persona);
            const legacy = persona && unScopeConversationStorageKey(key, '') !== null && key.startsWith(unscopedPrefix)
                && String(store.legacyThreadPersonaAssignments[key] || '').trim() === persona;
            if ((local !== null && local.startsWith(unscopedPrefix)) || legacy) {
                scope.removeKeys.push(key);
                delete store.characters[key];
                delete store.legacyThreadPersonaAssignments[key];
                changed = true;
            }
        }
        const remaining = store.groups.filter(group => !(String(group?.id) === groupId && getConversationPersonaId(group?.personaId) === persona));
        if (remaining.length !== store.groups.length) {
            store.groups = remaining;
            changed = true;
        }
        for (const reminder of store.reminders) {
            if (String(reminder?.groupId || '') === groupId && samePersona(reminder, persona)) scope.reminderIds.push(reminder.id);
        }
    } else {
        const soloKey = getConversationThreadKey(avatar, '', persona);
        const record = hasOwn(store.characters, soloKey) ? store.characters[soloKey] : undefined;
        if (isObject(record?.schedule)) {
            // The Character Schedule is kept (group DMs read it); everything else of this DM goes.
            if (!isScheduleOnlyRecord(record)) {
                store.characters[soloKey] = createKeptScheduleRecord(record.schedule);
                scope.replaceKeys[soloKey] = store.characters[soloKey];
                changed = true;
            }
        } else {
            scope.removeKeys.push(soloKey);
            if (record !== undefined) {
                delete store.characters[soloKey];
                delete store.legacyThreadPersonaAssignments[soloKey];
                changed = true;
            }
        }
        // An unscoped legacy thread assigned to this persona is this persona's DM too; an unassigned one may belong to another.
        const legacyKey = persona ? getConversationThreadKey(avatar, '', '') : '';
        if (legacyKey && legacyKey !== soloKey && hasOwn(store.characters, legacyKey)
            && String(store.legacyThreadPersonaAssignments[legacyKey] || '').trim() === persona) {
            scope.removeKeys.push(legacyKey);
            delete store.characters[legacyKey];
            delete store.legacyThreadPersonaAssignments[legacyKey];
            changed = true;
        }
        for (const reminder of store.reminders) {
            if (!reminder?.fired && reminder?.avatar === avatar && !reminder?.groupId && samePersona(reminder, persona)) scope.reminderIds.push(reminder.id);
        }
    }
    if (scope.reminderIds.length) {
        const ids = new Set(scope.reminderIds);
        store.reminders = store.reminders.filter(reminder => !ids.has(reminder?.id));
        changed = true;
    }
    if (!changed) return { changed: false, scope, store, version };

    // Trusted: this route edits the server's own copy, cloned above and saved in this tick, with no store from the browser in it.
    // That is what the memory guard (which restores server memory over a browser-sent store) must not do here: it would copy the deleted DM's memory back.
    const saved = await saveConversationStore(request, store, version, { trustedConversationEffects: true, settingsSnapshot: context.snapshot });
    if (!saved.ok) return { ok: false, status: saved.status || 500, body: saved.body || { error: 'save_failed' } };
    for (const key of Object.keys(scope.replaceKeys)) scope.replaceKeys[key] = saved.store.characters[key];
    cancelJobsForDeletedThreads(request, scope);
    return { changed: true, scope, store: saved.store, version: saved.version };
}
