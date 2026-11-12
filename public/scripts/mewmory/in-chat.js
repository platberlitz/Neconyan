/** Chat-side Mewmory controls: what each reply used, off-the-record messages and the message menu entry. */
export const MEWMORY_OFF_RECORD_KEY = 'mewmory_off_record';
export const MEWMORY_RECALL_LIMIT = 40;

/** Reduces a recall inspection to what a reply keeps: the memory ids it used and how many original passages came along. */
export function recallSummary(inspection, now = Date.now()) {
    const selected = inspection?.retrieval?.selected;
    if (!Array.isArray(selected)) return null;
    const ids = selected.filter(id => typeof id === 'string' && id);
    const records = [...new Set(ids.filter(id => !id.startsWith('source:')))].slice(0, MEWMORY_RECALL_LIMIT);
    return { at: now, records, passages: ids.filter(id => id.startsWith('source:')).length };
}

function stampExtra(extra, { summary, offRecord }) {
    const next = { ...(extra && typeof extra === 'object' ? extra : {}) };
    if (summary) next.mewmoryRecall = summary;
    if (offRecord) next.mewmoryExclude = true;
    return next;
}

/** Writes the recall summary and the off-the-record flag onto a message and its current swipe. */
export function stampMessage(message, { summary = null, offRecord = false } = {}) {
    if (!message || typeof message !== 'object' || (!summary && !offRecord)) return false;
    message.extra = stampExtra(message.extra, { summary, offRecord });
    const swipe = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (swipe && typeof swipe === 'object') swipe.extra = stampExtra(swipe.extra, { summary, offRecord });
    return true;
}

/** Clears the off-the-record flag from a message and every swipe, so Mewmory reads it again. */
export function putBackOnRecord(message) {
    if (!message || typeof message !== 'object') return false;
    let changed = false;
    for (const holder of [message, ...(Array.isArray(message.swipe_info) ? message.swipe_info : [])]) {
        if (holder?.extra?.mewmoryExclude) {
            holder.extra = { ...holder.extra };
            delete holder.extra.mewmoryExclude;
            changed = true;
        }
    }
    return changed;
}

/** What the chips under a message should say, or null when it needs none. */
export function messageChips(message) {
    if (!message || (message.is_system && !message.extra?.mewmoryKeepHidden)) return null;
    const recall = message.extra?.mewmoryRecall;
    const used = Array.isArray(recall?.records) ? recall.records.length : 0;
    const passages = Number.isSafeInteger(recall?.passages) ? recall.passages : 0;
    const offRecord = message.extra?.mewmoryExclude === true;
    if (!used && !passages && !offRecord) return null;
    return { used, passages, offRecord };
}

export function usedLabel({ used, passages }) {
    if (used) return used === 1 ? 'Used 1 memory' : 'Used ' + used + ' memories';
    return passages === 1 ? 'Used 1 earlier passage' : 'Used ' + passages + ' earlier passages';
}

function chipButton(label, icon, kind) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mewmory-chip';
    chip.dataset.mewmoryChip = kind;
    const glyph = document.createElement('i');
    glyph.className = 'fa-solid ' + icon;
    glyph.setAttribute('aria-hidden', 'true');
    chip.append(glyph, document.createTextNode(label));
    return chip;
}

/** Adds, updates or removes the chip row of one rendered message. */
export function decorateMessage(element, message) {
    const block = element?.querySelector('.mes_block');
    if (!block) return;
    const chips = messageChips(message);
    let row = block.querySelector(':scope > .mewmory-chips');
    if (!chips) {
        row?.remove();
        return;
    }
    const signature = JSON.stringify(chips);
    if (row?.dataset.signature === signature) return;
    if (!row) {
        row = document.createElement('div');
        row.className = 'mewmory-chips';
        const bias = block.querySelector(':scope > .mes_bias');
        if (bias) bias.before(row);
        else block.append(row);
    }
    row.dataset.signature = signature;
    row.replaceChildren();
    if (chips.used || chips.passages) {
        const chip = chipButton(usedLabel(chips), 'fa-brain', 'used');
        chip.title = 'See which memories Mewmory gave this reply';
        row.append(chip);
    }
    if (chips.offRecord) {
        const chip = chipButton('Off the record', 'fa-eye-slash', 'off-record');
        chip.title = 'Mewmory does not read this message';
        row.append(chip);
    }
}

/** Reconciles every rendered message with its chat entry. */
export function decorateMessages(chatElement, messages) {
    if (!chatElement || !Array.isArray(messages)) return;
    for (const element of chatElement.querySelectorAll('.mes[mesid]')) {
        decorateMessage(element, messages[Number(element.getAttribute('mesid'))]);
    }
}
