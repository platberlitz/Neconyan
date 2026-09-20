/**
 * Pure merge helpers for the Conversation store sync boundary. They compare the
 * last acknowledged server snapshot, the current browser state and a fresh
 * server read, and decide how to reconcile them without executing anything.
 */
import { MAX_THREAD_MESSAGES } from './constants.js';

export function isPlainConversationObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cloneConversationValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalConversationValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalConversationValue);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = canonicalConversationValue(value[key]);
            return result;
        }, {});
    }
    return value;
}

export function conversationValuesEqual(left, right) {
    return JSON.stringify(canonicalConversationValue(left)) === JSON.stringify(canonicalConversationValue(right));
}

function copyBranch(branch) {
    return isPlainConversationObject(branch) ? cloneConversationValue(branch) : branch;
}

/** True when a branch or thread identity is intact: same createdAt, so its receipts apply. */
export function isSameConversationBranchIdentity(savedBranch, currentBranch) {
    return isPlainConversationObject(savedBranch)
        && isPlainConversationObject(currentBranch)
        && String(savedBranch.createdAt || '') === String(currentBranch.createdAt || '');
}

function messageId(message) {
    return String(message?.id || '');
}

/**
 * Merge one branch's message list. Server order is authoritative, but every
 * server message the browser has never seen (a native append) is inserted at
 * its server position; browser edits and deletions of known messages win, and
 * brand-new browser messages are appended after the server list.
 */
function mergeMessageLists(serverMessages, localMessages, savedMessages) {
    const serverList = Array.isArray(serverMessages) ? serverMessages : [];
    const localList = Array.isArray(localMessages) ? localMessages : [];
    const savedList = Array.isArray(savedMessages) ? savedMessages : [];
    if (conversationValuesEqual(localList, savedList)) return cloneConversationValue(serverList);
    if (conversationValuesEqual(serverList, savedList)) return cloneConversationValue(localList);
    // Legacy messages have no stable identity. Match complete content by occurrence,
    // without manufacturing ids or timestamps during a read.
    const entries = list => {
        const counts = new Map();
        return list.map(message => {
            const id = messageId(message);
            if (id) return [`id:${id}`, message];
            const content = JSON.stringify(canonicalConversationValue(message));
            const occurrence = counts.get(content) || 0;
            counts.set(content, occurrence + 1);
            return [`legacy:${content}:${occurrence}`, message];
        });
    };
    const savedById = new Map(entries(savedList));
    const localById = new Map(entries(localList));
    const serverEntries = entries(serverList);
    const serverIds = new Set(serverEntries.map(([id]) => id));
    const legacyKeys = map => [...map.keys()].filter(key => key.startsWith('legacy:'));
    const savedLegacy = legacyKeys(savedById);
    const localLegacy = legacyKeys(localById);
    const serverLegacy = legacyKeys(new Map(serverEntries));
    const removed = keys => savedLegacy.some(key => !keys.includes(key));
    const added = keys => keys.some(key => !savedById.has(key));
    const ambiguousDeletion = savedLegacy.some(key => !key.endsWith(':0') && !localById.has(key) && !serverIds.has(key)
        && (localById.has(key.slice(0, key.lastIndexOf(':')) + ':0') || serverIds.has(key.slice(0, key.lastIndexOf(':')) + ':0')));
    if (ambiguousDeletion || (removed(localLegacy) && added(localLegacy)) || (removed(serverLegacy) && added(serverLegacy))
        || localLegacy.some(key => !savedById.has(key) && serverIds.has(key))
        || (removed(serverLegacy) && serverEntries.some(([key]) => key.startsWith('id:') && !savedById.has(key)))
        || (removed(localLegacy) && [...localById.keys()].some(key => key.startsWith('id:') && !savedById.has(key)))) return null;
    if (conversationValuesEqual(serverList, localList)) return cloneConversationValue(serverList);
    const merged = [];

    for (const [id, serverMessage] of serverEntries) {
        const local = localById.get(id);
        const saved = savedById.get(id);
        if (!local) {
            // Absent locally. If the browser had already acknowledged it and the
            // server has not touched it, the browser deleted it: honor that.
            // Otherwise it is an unseen native append (or the server also
            // changed it, where the server wins).
            if (saved && conversationValuesEqual(serverMessage, saved)) {
                continue;
            }
            merged.push(cloneConversationValue(serverMessage));
            continue;
        }
        if (!saved) {
            // The browser never saw a baseline for an id the server already
            // has, so a browser-side edit of it is stale: the server wins.
            merged.push(cloneConversationValue(serverMessage));
            continue;
        }
        // Local changes win; an untouched browser copy keeps the server value.
        merged.push(cloneConversationValue(conversationValuesEqual(local, saved) ? serverMessage : local));
    }

    for (const [id, message] of entries(localList)) {
        if (id && serverIds.has(id)) {
            continue;
        }
        // A message the browser had acknowledged but the server no longer has
        // was deleted there; keep it only when the browser edited it meanwhile.
        if (id && savedById.has(id) && conversationValuesEqual(message, savedById.get(id))) {
            continue;
        }
        merged.push(cloneConversationValue(message));
    }

    return merged.length <= MAX_THREAD_MESSAGES ? merged : null;
}

/**
 * Merge an object's plain fields with the same three-way rule as messages:
 * a field only the browser changed is kept, a field only the server changed
 * follows the server, and a field both changed follows the server. Nested
 * structures that need their own merge (branches, messages, protected records)
 * are excluded by the caller.
 */
function mergePlainFields(serverObject, localObject, savedObject, skip = new Set()) {
    const server = isPlainConversationObject(serverObject) ? serverObject : {};
    const local = isPlainConversationObject(localObject) ? localObject : {};
    const saved = isPlainConversationObject(savedObject) ? savedObject : {};
    const result = {};
    for (const key of new Set([...Object.keys(server), ...Object.keys(local)])) {
        if (skip.has(key)) {
            continue;
        }
        const serverValue = server[key];
        const localValue = local[key];
        const savedValue = saved[key];
        if (conversationValuesEqual(localValue, savedValue)) {
            if (key in server) {
                result[key] = cloneConversationValue(serverValue);
            }
        } else if (conversationValuesEqual(serverValue, savedValue)) {
            if (key in local) {
                result[key] = cloneConversationValue(localValue);
            }
        } else if (key in server) {
            // Both sides changed differently: the server wins shared metadata.
            result[key] = cloneConversationValue(serverValue);
        }
    }
    return result;
}

function mergeBranch(serverBranch, localBranch, savedBranch) {
    if (!isPlainConversationObject(serverBranch)) {
        return isPlainConversationObject(localBranch) ? copyBranch(localBranch) : serverBranch;
    }
    if (!isPlainConversationObject(localBranch)) {
        return copyBranch(serverBranch);
    }
    const merged = mergePlainFields(serverBranch, localBranch, savedBranch, new Set(['messages', 'serverOperations', 'automationClaims', 'messageEditRevision', 'messageContentHash']));
    for (const key of ['messageEditRevision', 'messageContentHash']) {
        if (serverBranch[key] !== undefined) merged[key] = serverBranch[key];
    }
    merged.messages = mergeMessageLists(serverBranch.messages, localBranch.messages, savedBranch?.messages);
    if (!merged.messages) return null;
    if (isSameConversationBranchIdentity(savedBranch, localBranch)) {
        for (const key of ['serverOperations', 'automationClaims']) {
            if (isPlainConversationObject(localBranch[key])) {
                merged[key] = cloneConversationValue(localBranch[key]);
            }
        }
    }
    return merged;
}

function mergeBranchMap(serverBranches, localBranches, savedBranches) {
    const merged = {};
    const serverMap = isPlainConversationObject(serverBranches) ? serverBranches : {};
    const localMap = isPlainConversationObject(localBranches) ? localBranches : {};
    const savedMap = isPlainConversationObject(savedBranches) ? savedBranches : {};
    for (const id of Object.keys(serverMap)) {
        // A branch present on the server but not locally was removed in the
        // browser: honor the deletion only when the server copy is unchanged,
        // otherwise the server changed it too and the conflict is reported.
        if (!Object.hasOwn(localMap, id)) {
            if (Object.hasOwn(savedMap, id)) {
                if (conversationValuesEqual(serverMap[id], savedMap[id])) {
                    continue;
                }
                return { conflict: true };
            }
            merged[id] = copyBranch(serverMap[id]);
            continue;
        }
        if (!Object.hasOwn(savedMap, id)) {
            // Different new branches under one key cannot be combined safely.
            const content = branch => Object.fromEntries(Object.entries(branch).filter(([key]) => !['messageEditRevision', 'messageContentHash', 'serverOperations', 'automationClaims'].includes(key)));
            if (!conversationValuesEqual(content(serverMap[id]), content(localMap[id]))) return { conflict: true };
            merged[id] = copyBranch(serverMap[id]);
            continue;
        }
        const localBranch = localMap[id];
        const savedBranch = savedMap[id];
        const localChanged = !conversationValuesEqual(localBranch, savedBranch);
        // A branch that changed its creation identity on either side is a new
        // generation. If the browser also edited its old copy, the two cannot be
        // combined into the replacement branch: report instead of guessing.
        if (!isSameConversationBranchIdentity(savedBranch, serverMap[id]) || !isSameConversationBranchIdentity(savedBranch, localBranch)) {
            if (localChanged) {
                return { conflict: true };
            }
            merged[id] = copyBranch(serverMap[id]);
            continue;
        }
        merged[id] = mergeBranch(serverMap[id], localBranch, savedBranch);
        if (!merged[id]) return { conflict: true };
    }
    for (const id of Object.keys(localMap)) {
        if (Object.hasOwn(serverMap, id)) {
            continue;
        }
        // A branch absent from the server was deleted there, or is a new local draft.
        if (Object.hasOwn(savedMap, id)) {
            continue;
        }
        merged[id] = copyBranch(localMap[id]);
    }
    return { branches: merged };
}

function mergeThread(serverThread, localThread, savedThread) {
    const merged = mergePlainFields(serverThread, localThread, savedThread, new Set(['branches', 'serverOperations']));
    const branches = mergeBranchMap(serverThread?.branches, localThread?.branches, savedThread?.branches);
    if (branches.conflict) {
        return { conflict: true };
    }
    if (Object.keys(branches.branches).length || isPlainConversationObject(localThread?.branches)) {
        merged.branches = branches.branches;
    }
    if (isSameConversationBranchIdentity(savedThread, localThread)) {
        if (isPlainConversationObject(localThread?.serverOperations)) {
            merged.serverOperations = cloneConversationValue(localThread.serverOperations);
        }
    }
    return { thread: merged };
}

function mergeCharacterMap(serverCharacters, localCharacters, savedCharacters) {
    const merged = isPlainConversationObject(serverCharacters) ? cloneConversationValue(serverCharacters) : {};
    const localMap = isPlainConversationObject(localCharacters) ? localCharacters : {};
    const savedMap = isPlainConversationObject(savedCharacters) ? savedCharacters : {};
    for (const key of Object.keys(localMap)) {
        const serverThread = merged[key];
        const localThread = localMap[key];
        if (isPlainConversationObject(serverThread)) {
            const result = mergeThread(serverThread, localThread, savedMap[key]);
            if (result.conflict) {
                return { conflict: true };
            }
            merged[key] = result.thread;
            continue;
        }
        if (Object.hasOwn(savedMap, key)) {
            // The thread is gone from the server: a local deletion stands.
            continue;
        }
        merged[key] = cloneConversationValue(localThread);
    }
    return { characters: merged };
}

/**
 * Merge the authoritative server store into the current browser store. Returns
 * null when both sides changed the same value differently; the caller keeps the
 * local edits and reports the conflict instead of saving over them.
 */
export function mergeConversationStore(serverStore, localStore, savedStore) {
    if (!isPlainConversationObject(serverStore)) {
        return cloneConversationValue(localStore);
    }
    if (!isPlainConversationObject(localStore) || !isPlainConversationObject(savedStore)) {
        return cloneConversationValue(serverStore);
    }
    const merged = { ...cloneConversationValue(serverStore) };
    const keys = new Set([...Object.keys(serverStore), ...Object.keys(localStore)]);
    for (const key of keys) {
        const serverValue = serverStore[key];
        const localValue = localStore[key];
        const savedValue = savedStore[key];
        const localChanged = !conversationValuesEqual(localValue, savedValue);
        const serverChanged = !conversationValuesEqual(serverValue, savedValue);
        if (!localChanged) {
            continue;
        }
        if (!serverChanged) {
            merged[key] = cloneConversationValue(localValue);
            continue;
        }
        if (key === 'characters') {
            const result = mergeCharacterMap(serverStore.characters, localStore.characters, savedStore.characters);
            if (result.conflict) {
                return null;
            }
            merged.characters = result.characters;
            continue;
        }
        if (!conversationValuesEqual(localValue, serverValue)) {
            return null;
        }
    }
    return merged;
}
