// The messages that were already in the chat when it loaded. A slow first paint
// can render one of them after the prompt mode changes; that late render must
// not be mistaken for a new reply and start an automatic colorize request.
const textsById = new Map();
let textByObject = new WeakMap();

function messageId(msg) {
    const id = msg?.id ?? msg?.send_date ?? '';
    return id === null || id === undefined ? '' : String(id);
}

export function captureLoadedMessageBaseline(chat) {
    textsById.clear();
    textByObject = new WeakMap();
    if (!Array.isArray(chat)) return;
    for (const msg of chat) {
        if (!msg || typeof msg !== 'object') continue;
        const text = String(msg.mes ?? '');
        textByObject.set(msg, text);
        const id = messageId(msg);
        if (!id) continue;
        const texts = textsById.get(id) || new Set();
        texts.add(text);
        textsById.set(id, texts);
    }
}

export function isUnchangedLoadedMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const text = String(msg.mes ?? '');
    if (textByObject.get(msg) === text) return true;
    const id = messageId(msg);
    return !!id && textsById.get(id)?.has(text) === true;
}
