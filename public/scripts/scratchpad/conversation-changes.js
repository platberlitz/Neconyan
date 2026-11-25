import { t } from '../i18n.js';
import { fail } from './proposals.js';
import { sourceCharacters, sourceUserName } from './context.js';
import { refuseUndo } from './undo-errors.js';

// Conversation threads live in their own store, so these modules load only when a change touches one.
async function conversationModules() {
    const [context, threads, timeline, sync, state] = await Promise.all([
        import('../neconyan-conversation/context.js'),
        import('../neconyan-conversation/thread-store.js'),
        import('../neconyan-conversation/timeline-render.js'),
        import('../neconyan-conversation/store-sync.js'),
        import('../neconyan-conversation/state.js'),
    ]);
    return { context, threads, timeline, sync, state };
}

function snapshot(message) {
    return {
        id: String(message?.id ?? ''),
        role: String(message?.role ?? ''),
        name: String(message?.name ?? ''),
        mes: String(message?.mes ?? ''),
    };
}

function sameSnapshot(message, expected) {
    if (!message || !expected) return false;
    const live = snapshot(message);
    return live.id === expected.id && live.role === expected.role && live.name === expected.name && live.mes === expected.mes;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function threadOptions(target) {
    return {
        branchId: String(target.branchId || ''),
        create: false,
        groupId: String(target.groupId || ''),
        personaId: String(target.personaId || ''),
    };
}

function branchFor(modules, target) {
    if (!target.avatar || !target.branchId) return null;
    const branch = modules.context.getActiveConversationBranch(target.avatar, threadOptions(target));
    return branch && String(branch.id) === String(target.branchId) && Array.isArray(branch.messages) ? branch : null;
}

function generationRunning(modules) {
    const state = modules.state.conversationState;
    return Boolean(state?.generationActive || state?.conversationReplyBusy || modules.state.regenerationBusyKeys?.size);
}

function messageName(message, source) {
    if (message?.name) return String(message.name);
    if (message?.role === 'user') return sourceUserName(source);
    return message?.role === 'system' ? 'System' : 'Character';
}

/** Save the new thread and wait for the store to reach the server, putting the old thread back if it does not. */
async function saveThread(modules, target, next, previous) {
    const context = {
        avatar: target.avatar,
        branchId: target.branchId,
        groupId: target.groupId || '',
        personaId: target.personaId || '',
    };
    modules.timeline.saveConversationMessageThread({ ...context, messages: next });
    let saved = false;
    try {
        saved = await modules.sync.persistConversationStoreNow();
    } catch {
        saved = false;
    }
    if (saved !== false) return;
    modules.timeline.saveConversationMessageThread({ ...context, messages: previous });
    fail(t`The Conversation could not be saved, so nothing was changed. Try again in a moment.`);
}

function liveMessages(branch) {
    return branch.messages.map(message => clone(message));
}

/** A review plan for one edit, insert or delete in the Conversation branch that was shared. */
export async function conversationChatPlan(change, source, { conflict, isCurrentSource }) {
    if (change.action === 'hide' || change.action === 'unhide') fail(t`Conversation messages cannot be hidden.`);
    if (!['edit', 'insert', 'delete'].includes(change.action)) fail('Scratchpad does not know this chat change.');
    const modules = await conversationModules();
    const target = {
        avatar: source.avatar,
        branchId: source.branchId,
        groupId: source.groupId || '',
        personaId: source.personaId || '',
    };
    const branch = branchFor(modules, target);
    if (!branch) fail(t`This Conversation branch is no longer open, so nothing was saved.`);

    const guard = () => {
        if (!isCurrentSource(source)) conflict();
        if (generationRunning(modules)) fail(t`Wait for the Conversation reply to finish before saving this change.`);
        const live = branchFor(modules, target);
        if (!live) conflict();
        return live;
    };

    if (change.action === 'insert') {
        const after = change.after;
        const anchor = after >= 0 ? branch.messages[after] : null;
        if (after >= 0 && !anchor) fail(`Message #${after} is no longer in this Conversation.`);
        const expected = anchor ? snapshot(anchor) : null;
        const speaker = change.speaker === 'user' ? 'user' : 'character';
        const members = speaker === 'character' ? sourceCharacters(source) : [];
        const wanted = String(change.name || '').trim().toLowerCase();
        const matched = speaker === 'character' && wanted
            ? members.find(member => String(member?.name || '').trim().toLowerCase() === wanted)
            : null;
        const name = matched?.name || change.name || (speaker === 'user' ? sourceUserName(source) : (members[0]?.name || 'Character'));
        const isPartner = Boolean(source.groupId && matched?.avatar && String(matched.avatar) !== String(source.avatar));
        return {
            target: after >= 0 ? `After message #${after}` : 'At the start of the Conversation',
            field: `New message from ${name}`,
            before: '',
            after: change.text,
            editable: true,
            async commit(edited) {
                const live = guard();
                if (after >= 0 && !sameSnapshot(live.messages[after], expected)) conflict();
                const text = String(edited ?? '');
                if (!text.trim()) fail(t`A new message needs some text.`);
                const message = modules.threads.createConversationMessage(isPartner
                    ? { role: 'partner', name, mes: text, extra: { partner_avatar: String(matched.avatar) } }
                    : { role: speaker, name, mes: text });
                const previous = liveMessages(live);
                const next = liveMessages(live);
                next.splice(after + 1, 0, message);
                await saveThread(modules, target, next, previous);
                return {
                    undo: {
                        kind: 'conversation-insert',
                        chatKey: source.key,
                        ...target,
                        id: String(message.id),
                        index: after + 1,
                        message: snapshot(message),
                    },
                };
            },
        };
    }

    const index = change.message;
    const message = branch.messages[index];
    if (!message) fail(`Message #${index} is no longer in this Conversation.`);
    const expected = snapshot(message);
    const label = `Message #${index} from ${messageName(message, source)}`;

    if (change.action === 'edit') {
        return {
            target: label,
            field: 'Message text',
            before: expected.mes,
            after: change.text,
            editable: true,
            async commit(edited) {
                const live = guard();
                if (!sameSnapshot(live.messages[index], expected)) conflict();
                const text = String(edited ?? '');
                if (!text.trim()) fail(t`A message cannot be left empty. Delete it instead.`);
                const previous = liveMessages(live);
                const next = liveMessages(live);
                next[index].mes = text;
                if (next[index].extra && typeof next[index].extra === 'object') delete next[index].extra.token_count;
                await saveThread(modules, target, next, previous);
                return {
                    undo: {
                        kind: 'conversation-edit',
                        chatKey: source.key,
                        ...target,
                        id: expected.id,
                        index,
                        role: expected.role,
                        name: expected.name,
                        before: expected.mes,
                        after: text,
                    },
                };
            },
        };
    }

    return {
        target: label,
        field: 'Whole message',
        before: expected.mes,
        after: '',
        editable: false,
        async commit() {
            const live = guard();
            if (!sameSnapshot(live.messages[index], expected)) conflict();
            const previous = liveMessages(live);
            const next = liveMessages(live);
            const [removed] = next.splice(index, 1);
            await saveThread(modules, target, next, previous);
            return {
                undo: {
                    kind: 'conversation-delete',
                    chatKey: source.key,
                    ...target,
                    id: expected.id,
                    index,
                    length: next.length,
                    previous: index > 0 ? snapshot(next[index - 1]) : null,
                    next: index < next.length ? snapshot(next[index]) : null,
                    message: removed,
                },
            };
        },
    };
}

/** Put a Conversation message back as it was, stopping when the thread changed after Scratchpad saved. */
export async function undoConversationChange(undo, { conflict }) {
    const modules = await conversationModules();
    const branch = branchFor(modules, undo);
    if (!branch) refuseUndo(t`This Conversation branch no longer exists, so the change cannot be undone.`);
    if (generationRunning(modules)) refuseUndo(t`Wait for the Conversation reply to finish before undoing this change.`);
    const messages = branch.messages;
    const previous = liveMessages(branch);
    const next = liveMessages(branch);
    const found = messages.findIndex(message => String(message?.id ?? '') === String(undo.id));

    if (undo.kind === 'conversation-edit') {
        if (found < 0 || String(messages[found].mes ?? '') !== String(undo.after ?? '')) conflict('message');
        next[found].mes = String(undo.before ?? '');
        if (next[found].extra && typeof next[found].extra === 'object') delete next[found].extra.token_count;
    } else if (undo.kind === 'conversation-insert') {
        if (found < 0 || !sameSnapshot(messages[found], undo.message)) conflict('message');
        next.splice(found, 1);
    } else if (undo.kind === 'conversation-delete') {
        const index = Number(undo.index);
        if (found >= 0 || !undo.message || !Number.isInteger(index) || index < 0 || index > messages.length) conflict('chat');
        if (undo.length !== undefined && messages.length !== Number(undo.length)) conflict('chat');
        if (undo.previous && !sameSnapshot(messages[index - 1], undo.previous)) conflict('chat');
        if (undo.next && !sameSnapshot(messages[index], undo.next)) conflict('chat');
        next.splice(index, 0, clone(undo.message));
    } else {
        refuseUndo(t`Automatic undo is not available for this change.`);
    }

    await saveThread(modules, undo, next, previous);
}
