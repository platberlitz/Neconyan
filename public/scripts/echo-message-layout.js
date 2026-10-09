/** Echo decoration measures native boxes; it never moves a message control. */
export function isEchoMessage(message, windowRef = window, documentRef = document) {
    const body = documentRef.body, shell = documentRef.getElementById('sheld');
    return windowRef.innerWidth > 768 && body.matches('.neconyan.echostyle:not(.sbterm):not(.sbstory)')
        && body.dataset.neconyanChatMode === 'roleplay' && shell?.dataset.sbtwMode !== 'on'
        && shell?.dataset.sbConversationMode !== 'on' && message?.matches('.mes:not(.smallSysMes):not([is_system="true"])');
}

const properties = ['cat-top', 'cat-left', 'plate-top', 'plate-left', 'plate-width', 'plate-height', 'clearance'];
let headerObserver;
export function refreshEchoHeader(message) {
    if (!message?.isConnected) return;
    const sentinel = message.querySelector(':scope > .nn-echo-header-bottom');
    if (!sentinel) { message.classList.remove('nn-echo-cutoff'); return; }
    const chat = document.getElementById('chat'), viewport = chat.getBoundingClientRect();
    const plate = message.querySelector(':scope > .nn-echo-header-plate');
    const exempt = plate.getBoundingClientRect().height > chat.clientHeight
        || message.querySelector('.mes_reasoning_details[open], .edit_textarea, .reasoning_edit_textarea, .extraMesButtons.expanded, [aria-expanded="true"]')
        || [message.querySelector('.mesAvatarWrapper'), message.querySelector('.ch_name'), message.querySelector('.mes_reasoning_details')]
            .some(member => member?.contains(document.activeElement));
    message.classList.toggle('nn-echo-cutoff', !exempt && sentinel.getBoundingClientRect().bottom > viewport.bottom);
}
function write(message, name, value) {
    const key = '--nn-echo-' + name;
    if (message.style.getPropertyValue(key) !== value) message.style.setProperty(key, value);
}
export function clearEchoMessage(message) {
    if (!message) return;
    message.classList.remove('nn-echo-layout', 'nn-echo-cutoff');
    for (const name of properties) message.style.removeProperty('--nn-echo-' + name);
    message.querySelector(':scope > .nn-echo-header-plate')?.remove();
    const sentinel = message.querySelector(':scope > .nn-echo-header-bottom');
    if (sentinel) { headerObserver?.unobserve(sentinel); sentinel.remove(); }
    clearEchoFooter(message);
}
function clearEchoFooter(message) {
    message.classList.remove('nn-echo-footer-adjacent');
    for (const element of message.querySelectorAll?.('.nn-echo-reading-footer, .nn-echo-footer-joined, .nn-echo-joined-end, .nn-echo-overlay-footer, .nn-echo-reserves-footer') || []) {
        element.classList.remove('nn-echo-reading-footer', 'nn-echo-footer-joined', 'nn-echo-joined-end', 'nn-echo-overlay-footer', 'nn-echo-reserves-footer');
        for (const property of ['footer-space', 'footer-top', 'footer-left', 'footer-width']) element.style.removeProperty('--nn-echo-' + property);
    }
}
function measureEchoFooter(message, text, windowRef, enabled) {
    if (!enabled) { clearEchoFooter(message); return; }
    const block = text.parentElement, footer = block.querySelector(':scope > .nn-response-controls');
    if (!footer || footer !== block.lastElementChild || !footer.getBoundingClientRect().height || windowRef.getComputedStyle(footer).visibility === 'hidden') {
        clearEchoFooter(message); return;
    }
    footer.classList.add('nn-echo-reading-footer');
    const notes = text.nextElementSibling?.matches('.ica--companion-ledger') ? text.nextElementSibling : null;
    const end = notes?.getBoundingClientRect().height ? notes : text;
    let adjacent = true;
    for (let element = end.nextElementSibling; element && element !== footer; element = element.nextElementSibling) {
        const box = element.getBoundingClientRect(), style = windowRef.getComputedStyle(element);
        // Empty media/file/bias wrappers can still reserve margin; the final geometric check covers it.
        if (box.height > 0 && style.display !== 'none') adjacent = false;
    }
    message.classList.toggle('nn-echo-footer-adjacent', adjacent);
    if (adjacent) {
        footer.classList.remove('nn-echo-overlay-footer');
        const panel = end.getBoundingClientRect(), control = footer.getBoundingClientRect();
        adjacent = Math.abs(panel.bottom - control.top) <= 1
            && Math.abs(panel.left - control.left) <= 1 && Math.abs(panel.right - control.right) <= 1;
        message.classList.toggle('nn-echo-footer-adjacent', adjacent);
    }
    footer.classList.toggle('nn-echo-overlay-footer', !adjacent);
    for (const element of [text, notes].filter(Boolean)) {
        element.classList.toggle('nn-echo-reserves-footer', !adjacent && element === end);
        if (adjacent || element !== end) element.style.removeProperty('--nn-echo-footer-space');
    }
    if (!adjacent) {
        const height = footer.getBoundingClientRect().height;
        write(end, 'footer-space', height + 'px');
        const panel = end.getBoundingClientRect(), container = block.getBoundingClientRect(), style = windowRef.getComputedStyle(end);
        const left = parseFloat(style.borderLeftWidth) || 0, right = parseFloat(style.borderRightWidth) || 0, bottom = parseFloat(style.borderBottomWidth) || 0;
        write(footer, 'footer-top', panel.bottom - bottom - container.top - block.clientTop - height + 'px');
        write(footer, 'footer-left', panel.left + left - container.left - block.clientLeft + 'px');
        write(footer, 'footer-width', panel.width - left - right + 'px');
    } else {
        for (const property of ['footer-top', 'footer-left', 'footer-width']) footer.style.removeProperty('--nn-echo-' + property);
    }
    const panel = end.getBoundingClientRect(), bottom = footer.getBoundingClientRect();
    const joined = adjacent && Math.abs(panel.bottom - bottom.top) <= 1
        && Math.abs(panel.left - bottom.left) <= 1 && Math.abs(panel.right - bottom.right) <= 1;
    footer.classList.toggle('nn-echo-footer-joined', joined);
    for (const element of [text, notes].filter(Boolean)) element.classList.toggle('nn-echo-joined-end', joined && element === end);
}
export function disposeEchoLayout(chat) {
    for (const message of chat.querySelectorAll?.(':scope > .mes.nn-echo-layout') || []) clearEchoMessage(message);
    headerObserver?.disconnect(); headerObserver = null;
}
export function measureEchoMessage(message) {
    if (!message) return;
    if (!message.isConnected) { clearEchoMessage(message); return; }
    const documentRef = message.ownerDocument, windowRef = documentRef.defaultView || window;
    if (!isEchoMessage(message, windowRef, documentRef)) { clearEchoMessage(message); return; }
    message.classList.add('nn-echo-layout');
    const exported = !!message.closest('.sb-message-screenshot-surface');
    if (exported) {
        message.classList.remove('nn-echo-cutoff');
        message.querySelector(':scope > .nn-echo-header-bottom')?.remove();
    }
    const desktop = windowRef.innerWidth > 1000;
    if (!desktop) {
        message.classList.remove('nn-echo-cutoff');
        for (const name of properties.filter(name => name.startsWith('plate-') || name === 'clearance')) message.style.removeProperty('--nn-echo-' + name);
        message.querySelector(':scope > .nn-echo-header-plate')?.remove();
        const sentinel = message.querySelector(':scope > .nn-echo-header-bottom');
        if (sentinel) { headerObserver?.unobserve(sentinel); sentinel.remove(); }
    }
    const text = message.querySelector(':scope > .mes_block > .mes_text');
    if (!text) return;
    measureEchoFooter(message, text, windowRef, desktop && !exported);
    const row = message.getBoundingClientRect(), panel = desktop ? text.getBoundingClientRect() : row;
    const values = {
        'cat-top': panel.top - row.top - message.clientTop - 41,
        'cat-left': (message.getAttribute('is_user') === 'true' ? panel.right - 79 : panel.left - 17) - row.left - message.clientLeft,
    };
    if (desktop) {
        let plate = message.querySelector(':scope > .nn-echo-header-plate');
        if (!plate) {
            plate = documentRef.createElement('div'); plate.className = 'nn-echo-header-plate';
            plate.setAttribute('aria-hidden', 'true'); message.append(plate);
        }
        const members = [message.querySelector(':scope > .mesAvatarWrapper'), message.querySelector('.ch_name'), message.querySelector('.mes_reasoning_details')];
        const boxes = members.filter(Boolean).map(el => el.getBoundingClientRect()).filter(box => box.width && box.height);
        if (boxes.length) {
            const left = Math.min(...boxes.map(b => b.left)), right = Math.max(...boxes.map(b => b.right));
            const top = Math.min(...boxes.map(b => b.top)), bottom = Math.max(...boxes.map(b => b.bottom));
            Object.assign(values, { 'plate-left': left - row.left - message.clientLeft - 10, 'plate-top': top - row.top - message.clientTop - 8,
                'plate-width': right - left + 20, 'plate-height': bottom - top + 16,
                clearance: Math.max(44, bottom - (text.getBoundingClientRect().top - (parseFloat(windowRef.getComputedStyle(text).marginTop) || 0)) + 50) });
        }
    }
    for (const [name, value] of Object.entries(values)) write(message, name, value + 'px');
    if (desktop && !exported) {
        let sentinel = message.querySelector(':scope > .nn-echo-header-bottom');
        if (!headerObserver) headerObserver = new IntersectionObserver(entries => {
            for (const entry of entries) refreshEchoHeader(entry.target.parentElement);
        }, { root: document.getElementById('chat'), threshold: [0, 1] });
        if (!sentinel) {
            sentinel = document.createElement('span'); sentinel.className = 'nn-echo-header-bottom';
            sentinel.setAttribute('aria-hidden', 'true'); message.append(sentinel); headerObserver.observe(sentinel);
        }
        refreshEchoHeader(message);
    }
}

/** Complete panel: Notes continue text paint and supply its final corners. */
export function resolveEchoSurface(row, y, windowRef = window) {
    if (row.matches('.smallSysMes, [is_system="true"]')) return null;
    if (windowRef.innerWidth <= 1000) return { box: row.getBoundingClientRect(), paint: row, radius: row, targets: [row] };
    const text = row.querySelector(':scope > .mes_block > .mes_text');
    if (!text) return null;
    const notes = text.nextElementSibling?.matches('.ica--companion-ledger') ? text.nextElementSibling : null;
    const first = text.getBoundingClientRect(), last = notes?.getBoundingClientRect() || first;
    const candidate = row.querySelector(':scope > .mes_block > .nn-response-controls.nn-echo-reading-footer');
    const footer = candidate?.matches?.('.nn-echo-reading-footer') && !candidate.classList.contains('nn-echo-overlay-footer') ? candidate : null;
    const footerBox = footer?.getBoundingClientRect();
    const joined = footer?.classList.contains('nn-echo-footer-joined');
    if (footerBox && y >= footerBox.top && y < footerBox.bottom && !joined) {
        return { box: footerBox, paint: footer, radius: footer, targets: [row, footer], underlay: row };
    }
    const target = footerBox && y >= footerBox.top && y < footerBox.bottom ? footer
        : notes && y >= last.top && y < last.bottom ? notes : y >= first.top && y < first.bottom ? text : null;
    if (!target) return null;
    return { box: { ...first.toJSON(), bottom: joined ? footerBox.bottom : last.bottom }, paint: target,
        radius: joined ? footer : notes || text, targets: [row, text, notes, joined ? footer : null].filter(Boolean), underlay: row };
}
