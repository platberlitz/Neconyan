/** Echo decoration measures native boxes; it never moves a message control. */
export function isEchoMessage(message, windowRef = window, documentRef = document) {
    const body = documentRef.body, shell = documentRef.getElementById('sheld');
    return windowRef.innerWidth > 768 && body.matches('.neconyan.echostyle:not(.sbterm):not(.sbstory)')
        && body.dataset.neconyanChatMode === 'roleplay' && shell?.dataset.sbtwMode !== 'on'
        && shell?.dataset.sbConversationMode !== 'on' && message?.matches('.mes:not(.smallSysMes):not([is_system="true"])');
}

const properties = ['cat-top', 'cat-left', 'plate-top', 'plate-left', 'plate-width', 'plate-height', 'clearance'];
let headerObserver, rowObserver, scrollChat = null, scrollFrame = 0;
const visibleRows = new Set();
// A scroll can carry the header sentinel from above the chat to below it without the
// sentinel observer seeing a crossing, so rows on screen are rechecked once per scrolled frame.
function onEchoChatScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        for (const row of visibleRows) refreshEchoHeader(row);
    });
}
function watchEchoRow(message) {
    const chat = document.getElementById('chat');
    if (!rowObserver) rowObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) { visibleRows.delete(entry.target); continue; }
            visibleRows.add(entry.target); refreshEchoHeader(entry.target);
        }
    }, { root: chat, threshold: 0 });
    if (chat && scrollChat !== chat) {
        scrollChat?.removeEventListener('scroll', onEchoChatScroll);
        scrollChat = chat; chat.addEventListener('scroll', onEchoChatScroll, { passive: true });
    }
    rowObserver.observe(message);
}
function unwatchEchoRow(message) {
    rowObserver?.unobserve(message);
    visibleRows.delete(message);
}
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
    if (message.classList.contains('nn-echo-layout') || message.classList.contains('nn-echo-cutoff')) {
        message.classList.remove('nn-echo-layout', 'nn-echo-cutoff');
    }
    for (const name of properties) message.style.removeProperty('--nn-echo-' + name);
    message.querySelector(':scope > .nn-echo-header-plate')?.remove();
    const sentinel = message.querySelector(':scope > .nn-echo-header-bottom');
    if (sentinel) { headerObserver?.unobserve(sentinel); sentinel.remove(); }
    unwatchEchoRow(message);
    clearEchoFooter(message);
}
function clearEchoFooter(message) {
    if (message.classList.contains('nn-echo-footer-adjacent')) message.classList.remove('nn-echo-footer-adjacent');
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
    rowObserver?.disconnect(); rowObserver = null; visibleRows.clear();
    scrollChat?.removeEventListener('scroll', onEchoChatScroll); scrollChat = null;
    if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
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
        unwatchEchoRow(message);
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
        watchEchoRow(message);
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

/** Tide decoration measures the same native boxes as Echo, from the header plate to the last bubble. */
export function isTideMessage(message, windowRef = window, documentRef = document) {
    const body = documentRef.body, shell = documentRef.getElementById('sheld');
    return windowRef.innerWidth > 768 && body.matches('.neconyan.tidestyle:not(.sbterm):not(.sbstory)')
        && body.dataset.neconyanChatMode === 'roleplay' && shell?.dataset.sbtwMode !== 'on'
        && shell?.dataset.sbConversationMode !== 'on' && message?.matches('.mes:not(.smallSysMes):not([is_system="true"])');
}

const tideProperties = ['cat-top', 'cat-left', 'plate-top', 'plate-left', 'plate-width', 'plate-height', 'box-top', 'box-left', 'box-width', 'box-height', 'clearance'];

function tideRoleplayActive(documentRef) {
    const body = documentRef.body;
    return body?.matches('.neconyan.tidestyle:not(.sbterm):not(.sbstory)') === true && body.dataset.neconyanChatMode === 'roleplay';
}

/** CSS :has() cannot see text nodes, so the marker names empty paragraphs that only contain breaks. */
export function isTideEmptyParagraph(childNodes) {
    let text = '';
    for (const node of childNodes || []) {
        if (node?.nodeType === 1) { if (node.tagName !== 'BR') return false; continue; }
        text += node?.textContent ?? '';
    }
    return text.trim() === '';
}
export function markTideEmptyParagraphs(message) {
    if (!message?.querySelectorAll) return;
    const paragraphs = [...message.querySelectorAll('.mes_text > p')];
    if (!tideRoleplayActive(message.ownerDocument || document)) {
        for (const paragraph of paragraphs) paragraph.removeAttribute('data-nn-tide-empty');
        return;
    }
    for (const paragraph of paragraphs) {
        // Set and remove on every pass, so an edit that fills a paragraph clears its stale marker.
        if (isTideEmptyParagraph(paragraph.childNodes)) paragraph.setAttribute('data-nn-tide-empty', '');
        else paragraph.removeAttribute('data-nn-tide-empty');
    }
}

function writeTide(element, name, value) {
    const key = '--nn-tide-' + name;
    if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
}
export function clearTideMessage(message, clearEmptyMarkers = true) {
    if (!message) return;
    const hasLayout = message.classList.contains('nn-tide-layout');
    const properties = tideProperties.map(name => '--nn-tide-' + name).filter(key => message.style.getPropertyValue(key));
    const plate = message.querySelector(':scope > .nn-tide-header-plate');
    const container = message.querySelector(':scope > .nn-tide-container');
    const markers = clearEmptyMarkers ? [...message.querySelectorAll('[data-nn-tide-empty]')] : [];
    // A row with none of our state is left completely alone: no class, style, node or attribute
    // mutation for any other style on any pass.
    if (!hasLayout && !properties.length && !plate && !container && !markers.length) return;
    if (hasLayout) message.classList.remove('nn-tide-layout');
    for (const key of properties) message.style.removeProperty(key);
    plate?.remove();
    container?.remove();
    for (const paragraph of markers) paragraph.removeAttribute('data-nn-tide-empty');
}

function tideBoxVisible(element, windowRef) {
    if (!element) return false;
    const box = element.getBoundingClientRect(), style = windowRef.getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}
/** A wrapper paints nothing of its own, so its painted extent is its visible children: a block-level
    wrapper (controls, media, files, bias) never stretches the container to the reading column. */
function tidePaintedBoxes(element, windowRef) {
    if (element.matches(':is(.mes_media_wrapper, .mes_file_wrapper, .mes_bias, .nn-response-controls)')) {
        const boxes = [...element.children].filter(child => tideBoxVisible(child, windowRef)).map(child => child.getBoundingClientRect());
        if (boxes.length) return boxes;
    }
    return tideBoxVisible(element, windowRef) ? [element.getBoundingClientRect()] : [];
}
/** The message container: every visible member plus 12px, its top line through the closed header. */
export function resolveTideBox(message, windowRef) {
    const row = message.getBoundingClientRect();
    const members = [];
    const plate = message.querySelector(':scope > .nn-tide-header-plate');
    if (tideBoxVisible(plate, windowRef)) members.push(plate);
    const text = message.querySelector(':scope > .mes_block > .mes_text');
    if (text) for (const child of text.children) if (tideBoxVisible(child, windowRef)) members.push(child);
    for (const card of message.querySelectorAll('.ica--companion-card')) if (tideBoxVisible(card, windowRef)) members.push(card);
    for (const extra of message.querySelectorAll(':scope > .mes_block > :is(.mes_media_wrapper, .mes_file_wrapper, .mes_bias)')) {
        if (tideBoxVisible(extra, windowRef)) members.push(extra);
    }
    const controls = message.querySelector(':scope > .mes_block > .nn-response-controls');
    if (tideBoxVisible(controls, windowRef)) members.push(controls);
    const boxes = members.flatMap(element => tidePaintedBoxes(element, windowRef));
    if (!boxes.length) return null;
    // The top line is the vertical centre of the closed header alone, so open reasoning never moves it.
    const header = [message.querySelector(':scope > .mesAvatarWrapper'), message.querySelector('.ch_name'), message.querySelector('.mes_reasoning_summary')]
        .filter(element => tideBoxVisible(element, windowRef)).map(element => element.getBoundingClientRect());
    const top = header.length
        ? (Math.min(...header.map(box => box.top)) + Math.max(...header.map(box => box.bottom))) / 2
        : Math.min(...boxes.map(box => box.top));
    const left = Math.min(...boxes.map(box => box.left)), right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return {
        'box-top': top - row.top - message.clientTop,
        'box-left': left - 12 - row.left - message.clientLeft,
        'box-width': right - left + 24,
        'box-height': bottom + 12 - top,
    };
}
export function measureTideMessage(message) {
    if (!message) return;
    if (!message.isConnected) { clearTideMessage(message, true); return; }
    const documentRef = message.ownerDocument, windowRef = documentRef.defaultView || window;
    // Marking runs at every width, so the empty paragraphs are hidden on the phone grid too.
    markTideEmptyParagraphs(message);
    if (!isTideMessage(message, windowRef, documentRef)) { clearTideMessage(message, !tideRoleplayActive(documentRef)); return; }
    message.classList.add('nn-tide-layout');
    const text = message.querySelector(':scope > .mes_block > .mes_text');
    if (!text) return;
    let plate = message.querySelector(':scope > .nn-tide-header-plate');
    if (!plate) {
        plate = documentRef.createElement('div'); plate.className = 'nn-tide-header-plate';
        plate.setAttribute('aria-hidden', 'true'); message.append(plate);
    }
    const row = message.getBoundingClientRect();
    const members = [message.querySelector(':scope > .mesAvatarWrapper'), message.querySelector('.ch_name'), message.querySelector('.mes_reasoning_details')];
    const boxes = members.filter(Boolean).map(element => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ element, box }) => tideBoxVisible(element, windowRef) && box.width && box.height);
    if (!boxes.length) {
        // No visible member: the plate would have nothing to wrap, so the sleeper keeps calico's default.
        for (const name of tideProperties) message.style.removeProperty('--nn-tide-' + name);
        plate.remove();
        return;
    }
    const left = Math.min(...boxes.map(({ box }) => box.left)), right = Math.max(...boxes.map(({ box }) => box.right));
    const top = Math.min(...boxes.map(({ box }) => box.top)), bottom = Math.max(...boxes.map(({ box }) => box.bottom));
    const textStyle = windowRef.getComputedStyle(text), textMarginTop = parseFloat(textStyle.marginTop) || 0;
    const values = {
        'plate-left': left - row.left - message.clientLeft - 10,
        'plate-top': top - row.top - message.clientTop - 8,
        'plate-width': right - left + 20,
        'plate-height': bottom - top + 16,
        'cat-top': top - 8 - row.top - message.clientTop - 41,
        'cat-left': (message.getAttribute('is_user') === 'true' ? right + 10 - 79 : left - 10 - 17) - row.left - message.clientLeft,
    };
    values.clearance = Math.max(8, bottom + 8 - (text.getBoundingClientRect().top - textMarginTop) + 8);
    for (const [name, value] of Object.entries(values)) writeTide(message, name, value + 'px');
    // The container wraps every member; without one there is nothing to paint, so both come and go together.
    let container = message.querySelector(':scope > .nn-tide-container');
    const box = resolveTideBox(message, windowRef);
    if (!box) {
        for (const name of ['box-top', 'box-left', 'box-width', 'box-height']) message.style.removeProperty('--nn-tide-' + name);
        container?.remove();
        return;
    }
    if (!container) {
        container = documentRef.createElement('div'); container.className = 'nn-tide-container';
        container.setAttribute('aria-hidden', 'true'); message.prepend(container);
    }
    for (const [name, value] of Object.entries(box)) writeTide(message, name, value + 'px');
}

/** The message container is the one surface a Tide row paints its lower edge from. */
export function resolveTideSurface(row, y, windowRef = window) {
    if (row.matches('.smallSysMes, [is_system="true"]')) return null;
    const container = row.querySelector(':scope > .nn-tide-container');
    if (!container) return null;
    const box = container.getBoundingClientRect();
    return y >= box.top && y < box.bottom ? { box, paint: container, radius: container, targets: [row], underlay: container } : null;
}
export function disposeTideLayout(chat) {
    for (const message of chat.querySelectorAll?.(':scope > .mes.nn-tide-layout') || []) clearTideMessage(message);
}
