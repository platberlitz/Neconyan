import { isHostSystemOrToolMessage } from './attribution-store.js';
import { stripAllColorMetadataLines } from './color-blocks.js';
import { refreshMessageDom } from './dom-engine.js';
import { areChatBindingsEqual, captureChatBinding, queueChatSave } from './live-colors.js';
import { getContext } from './st-api.js';
import { toast } from './utils.js';

const FONT_TAG_PATTERN = /<(\/?)font\b[^<>]*>/gi;
const COLOR_ONLY_FONT_TAG = /^<font\s+color\s*=\s*(["']?)#?[0-9a-f]{3,8}\1\s*>$/i;

/** Remove font tags whose only job is a color, with their closing tags; other font tags stay. */
export function stripColorFontTags(text) {
    const source = String(text ?? '');
    if (!/<font\b/i.test(source)) return source;
    const stack = [];
    let result = '';
    let cursor = 0;
    let match;
    FONT_TAG_PATTERN.lastIndex = 0;
    while ((match = FONT_TAG_PATTERN.exec(source))) {
        let remove = false;
        if (match[1]) {
            if (stack.length) remove = stack.pop();
        } else {
            remove = COLOR_ONLY_FONT_TAG.test(match[0]);
            stack.push(remove);
        }
        if (!remove) continue;
        result += source.slice(cursor, match.index);
        cursor = match.index + match[0].length;
    }
    return cursor ? result + source.slice(cursor) : source;
}

export function cleanColorMarkupText(text, options = {}) {
    const withoutLines = stripAllColorMetadataLines(text);
    return options.fontTags ? stripColorFontTags(withoutLines) : withoutLines;
}

function isCleanableMessage(msg) {
    // User messages are never written by this extension, and tool or system
    // messages have their own repair action.
    return !!msg && !msg.is_user && !isHostSystemOrToolMessage(msg);
}

/** Clean every character message and swipe in place; returns what changed so it can be undone. */
export function cleanChatColorMarkup(chat, options = {}) {
    const report = { changes: [], messageCount: 0, swipeCount: 0 };
    if (!Array.isArray(chat)) return report;
    chat.forEach((msg, index) => {
        if (!isCleanableMessage(msg)) return;
        const mes = typeof msg.mes === 'string' ? msg.mes : null;
        const cleanedMes = mes === null ? null : cleanColorMarkupText(mes, options);
        const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
        const cleanedSwipes = swipes?.map(swipe => (typeof swipe === 'string' ? cleanColorMarkupText(swipe, options) : swipe));
        const changedSwipes = swipes ? cleanedSwipes.filter((swipe, i) => swipe !== swipes[i]).length : 0;
        const mesChanged = mes !== null && cleanedMes !== mes;
        if (!mesChanged && !changedSwipes) return;
        report.changes.push({ index, message: msg, mes, swipes: swipes ? [...swipes] : null });
        if (mesChanged) msg.mes = cleanedMes;
        if (changedSwipes) msg.swipes = cleanedSwipes;
        report.messageCount++;
        report.swipeCount += changedSwipes;
    });
    return report;
}

export function restoreChatColorMarkup(chat, changes) {
    const restored = [];
    for (const change of changes || []) {
        const msg = chat?.[change.index];
        if (msg !== change.message) continue;
        if (change.mes !== null) msg.mes = change.mes;
        if (change.swipes) msg.swipes = [...change.swipes];
        restored.push(change.index);
    }
    return restored;
}

async function refreshMessages(chat, indices) {
    for (const index of indices) await refreshMessageDom(index, chat[index]);
}

/** Clean the open chat, save it, redraw the changed messages and offer an undo. */
export async function applyChatColorMarkupCleanup(options = {}) {
    const chat = getContext()?.chat;
    const binding = captureChatBinding();
    const report = cleanChatColorMarkup(chat, options);
    if (!report.messageCount) {
        if (!options.silent) toast.info(options.fontTags ? 'No messages had color lines or color tags to remove.' : 'No messages had color lines to remove.');
        return { ...report, undo: null };
    }

    queueChatSave();
    await refreshMessages(chat, report.changes.map(change => change.index));

    const undo = async () => {
        if (!areChatBindingsEqual(binding, captureChatBinding())) {
            toast.warning('The chat changed, so the cleanup was not undone.');
            return false;
        }
        const restored = restoreChatColorMarkup(getContext()?.chat, report.changes);
        if (!restored.length) return false;
        queueChatSave();
        await refreshMessages(getContext()?.chat, restored);
        toast.info(`Restored ${restored.length} message${restored.length === 1 ? '' : 's'}.`);
        return true;
    };
    return { ...report, undo };
}
