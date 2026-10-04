import { randomUUID } from 'node:crypto';
import { CHAT_LINK_ID } from '../public/scripts/chat-navigation-policy.js';

/** Browser copies cannot establish or transplant a server-owned link identity. */
export function protectConversationNavigation(store, previous, { enrol = null, restoreSnapshot = false, moves = [], retirePersona = '' } = {}) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) return store;
    const targets = {};
    const characters = Object.fromEntries(Object.entries(store.characters || {}).map(([key, thread]) => {
        if (!thread?.branches || typeof thread.branches !== 'object') return [key, thread];
        const branches = Object.fromEntries(Object.entries(thread.branches).map(([id, branch]) => {
            if (!branch || typeof branch !== 'object') return [id, branch];
            let old = previous?.characters?.[key]?.branches?.[id];
            const movedFrom = moves.find(move => move.to === key)?.from;
            if (movedFrom) old = previous?.characters?.[movedFrom]?.branches?.[id] || old;
            // Group canonicalisation can move an unchanged branch to another
            // member, never to a different persona, group or merged history.
            if (!old && !restoreSnapshot && CHAT_LINK_ID.test(branch.navigationId || '')) {
                const origin = previous?.navigationTargets?.[branch.navigationId];
                const source = previous?.characters?.[origin?.threadKey];
                const candidate = source?.branches?.[id];
                const scope = name => typeof name === 'string' ? name.slice(0, name.lastIndexOf(':')) : '';
                if (origin?.branchId === id && !store.characters?.[origin.threadKey] && thread.groupId
                    && thread.groupId === source?.groupId && scope(key) === scope(origin.threadKey)
                    && JSON.stringify(branch.messages) === JSON.stringify(candidate?.messages)) old = candidate;
            }
            const value = { ...branch };
            delete value.navigationId;
            const surviving = !restoreSnapshot && !(retirePersona && key.startsWith(`persona:${encodeURIComponent(retirePersona)}:`))
                && old && String(old.createdAt || '') === String(branch.createdAt || '')
                && (old.lifetimeSeed || '') === (branch.lifetimeSeed || '');
            if (surviving && CHAT_LINK_ID.test(old.navigationId || '')) value.navigationId = old.navigationId;
            if (enrol?.threadKey === key && enrol.branchId === id && old && surviving && (!value.navigationId || enrol.replace === true)) value.navigationId = randomUUID();
            if (value.navigationId) targets[value.navigationId] = { threadKey: key, branchId: id };
            return [id, value];
        }));
        return [key, { ...thread, branches }];
    }));
    const groups = Array.isArray(store.groups) ? store.groups.map(group => {
        const value = { ...group };
        delete value.navigationId;
        const old = previous?.groups?.find(item => item.id === group.id);
        if (!restoreSnapshot && old && String(old.createdAt || '') === String(group.createdAt || '')
            && String(old.personaId || '') === String(group.personaId || '') && group.personaId !== retirePersona
            && (old.lifetimeSeed || '') === (group.lifetimeSeed || '')) {
            if (CHAT_LINK_ID.test(old.navigationId || '')) value.navigationId = old.navigationId;
            if (enrol?.groupId === group.id && !value.navigationId) value.navigationId = randomUUID();
        }
        return value;
    }) : store.groups;
    const value = { ...store, ...(store.characters ? { characters } : {}), ...(Array.isArray(groups) ? { groups } : {}) };
    delete value.navigationTargets;
    if (Object.keys(targets).length || previous?.navigationTargets) value.navigationTargets = targets;
    return value;
}
