/**
 * Pure merge helpers for the Conversation store sync boundary. They compare the
 * last acknowledged server snapshot, the current browser state and a fresh
 * server read, and decide how to reconcile them without executing anything.
 */

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
    const savedById = new Map((Array.isArray(savedMessages) ? savedMessages : []).filter(item => messageId(item)).map(item => [messageId(item), item]));
    const localById = new Map(localList.filter(item => messageId(item)).map(item => [messageId(item), item]));
    const serverIds = new Set(serverList.map(messageId).filter(Boolean));
    const merged = [];

    for (const serverMessage of serverList) {
        const id = messageId(serverMessage);
        const local = id ? localById.get(id) : null;
        const saved = id ? savedById.get(id) : null;
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

    for (const message of localList) {
        const id = messageId(message);
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

    return merged;
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
    const merged = mergePlainFields(serverBranch, localBranch, savedBranch, new Set(['messages', 'serverOperations', 'automationClaims']));
    merged.messages = mergeMessageLists(serverBranch.messages, localBranch.messages, savedBranch?.messages);
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
            // A brand-new server branch against a brand-new local branch: keep both.
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
