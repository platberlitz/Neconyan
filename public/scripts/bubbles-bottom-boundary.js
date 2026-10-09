import { resolveEchoSurface, disposeEchoLayout } from './echo-message-layout.js';
/** The lower-edge decoration owns no layout, message content or input handlers. */
export function createBubblesBottomBoundary({ chat, toolbar, getMode, documentRef = document, windowRef = window }) {
    if (!chat || !toolbar) return null;
    const cap = documentRef.createElement('div');
    cap.id = 'neconyan-bubbles-bottom-boundary';
    cap.hidden = true;
    cap.setAttribute('aria-hidden', 'true');
    const surface = documentRef.createElement('div');
    cap.append(surface);
    chat.parentElement.append(cap);
    let frame = 0, disposed = false, activeRow = null, ownedClip = '', previousClip = '', previousPriority = '';
    let transitionDeadline = 0, ownedChatStyle = chat.getAttribute('style');
    const transitions = new Set();
    let activeTargets = [];
    let activePaint = null, nextTargetId = 0;
    const targetIds = new WeakMap();
    const transitionKey = (target, pseudo, property) => {
        if (!targetIds.has(target)) targetIds.set(target, ++nextTargetId);
        return `${targetIds.get(target)}:${pseudo || ''}:${property}`;
    };
    const clear = () => {
        cap.hidden = true;
        if (ownedClip && chat.style.getPropertyValue('clip-path') === ownedClip) {
            if (previousClip) chat.style.setProperty('clip-path', previousClip, previousPriority);
            else chat.style.removeProperty('clip-path');
        }
        ownedClip = '';
        ownedChatStyle = chat.getAttribute('style');
    };
    const queue = () => {
        if (!disposed && !frame) frame = windowRef.requestAnimationFrame(update);
    };
    const resize = new windowRef.ResizeObserver(queue);
    for (const element of [chat, toolbar, chat.parentElement, documentRef.getElementById('send_form')]) {
        if (element) resize.observe(element);
    }
    const setRow = (row, targets = row ? [row] : [], paint = row) => {
        if (row === activeRow && paint === activePaint && targets.length === activeTargets.length && targets.every((target, i) => target === activeTargets[i])) return;
        for (const target of activeTargets) resize.unobserve(target);
        activeRow = row;
        activeTargets = targets;
        activePaint = paint;
        transitions.clear();
        if (row) {
            for (const target of targets) resize.observe(target);
            // A selected row may enter the edge after transitionrun already fired off-screen.
            for (const target of targets) for (const animation of target.getAnimations?.() || []) {
                if (animation.playState === 'running' && /^(background|border|opacity)/.test(animation.transitionProperty || '')) {
                    transitions.add(transitionKey(target, animation.effect?.pseudoElement, animation.transitionProperty));
                }
            }
            if (transitions.size) transitionDeadline = windowRef.performance.now() + 1000;
        }
    };
    function update() {
        frame = 0;
        if (disposed) return;
        clear();
        const body = documentRef.body;
        const sheld = documentRef.getElementById('sheld');
        const echo = body.classList?.contains('echostyle') === true;
        if (windowRef.innerWidth <= 768 || !body.matches(echo ? '.neconyan.echostyle:not(.sbterm):not(.sbstory)' : '.neconyan.bubblechat:not(.sbterm):not(.sbstory)')
            || getMode() !== 'roleplay' || sheld?.dataset.sbtwMode === 'on' || sheld?.dataset.sbConversationMode === 'on'
            || windowRef.getComputedStyle(chat).clipPath !== 'none') {
            setRow(null); return;
        }
        const viewport = chat.getBoundingClientRect(), bar = toolbar.getBoundingClientRect();
        if (!viewport.height || !bar.height || Math.abs(viewport.bottom - bar.top) > 1 || windowRef.getComputedStyle(toolbar).visibility === 'hidden') {
            setRow(null); return;
        }
        // clientWidth excludes a visible scrollbar. The notch must never reach its lane.
        const contentLeft = viewport.left + chat.clientLeft;
        const contentRight = contentLeft + chat.clientWidth;
        const y = viewport.bottom - 1;
        let row = null;
        for (const fraction of [0.5, 0.25, 0.75]) {
            for (const element of documentRef.elementsFromPoint(contentLeft + (contentRight - contentLeft) * fraction, y)) {
                const candidate = element.closest('.mes');
                if (candidate?.parentElement === chat && !candidate.closest('.sb-message-screenshot-shell')) {
                    row = candidate; break;
                }
            }
            if (row) break;
        }
        const descriptor = row && echo ? resolveEchoSurface(row, y, windowRef) : null;
        setRow(row, descriptor?.targets, descriptor?.paint || row);
        if (!row || (!echo && row.querySelector('.edit_textarea, .reasoning_edit_textarea'))) return;
        if (echo && !descriptor) return;
        const box = descriptor?.box || row.getBoundingClientRect(), style = windowRef.getComputedStyle(descriptor?.paint || row);
        const corners = descriptor ? windowRef.getComputedStyle(descriptor.radius) : style;
        const underlay = descriptor?.underlay ? windowRef.getComputedStyle(descriptor.underlay) : style;
        const paint = echo ? descriptor.underlay ? { background: style.background, opacity: style.opacity, display: 'block' }
            : { background: 'none', opacity: '1', display: 'none' } : windowRef.getComputedStyle(row, '::before');
        if (echo && box.right - box.left <= bar.width + 1) return;
        const bottom = bar.top + 4;
        const height = Math.max(4, parseFloat(corners.borderBottomLeftRadius) || 0, parseFloat(corners.borderBottomRightRadius) || 0);
        const top = bottom - height;
        if (box.top >= top || box.bottom <= bottom + 1) return;
        const left = Math.max(contentLeft, box.left), right = Math.min(contentRight, box.right);
        if (right <= left) return;
        const notchTop = Math.max(0, top - viewport.top);
        const l = left - viewport.left, r = right - viewport.left;
        previousClip = chat.style.getPropertyValue('clip-path');
        previousPriority = chat.style.getPropertyPriority('clip-path');
        let lane = null;
        const editor = echo && row.querySelector('.mes_text .edit_textarea');
        if (editor && editor.scrollHeight > editor.clientHeight) {
            const editorBox = editor.getBoundingClientRect(), editorStyle = windowRef.getComputedStyle(editor);
            const start = Math.max(left, editorBox.left + editor.clientLeft + editor.clientWidth);
            const end = Math.min(right, editorBox.right - (parseFloat(editorStyle.borderRightWidth) || 0));
            if (y > editorBox.top && y < editorBox.bottom && end - start > 0.5) lane = { start, end };
        }
        const laneNotch = lane ? `,${lane.end - viewport.left}px ${notchTop}px,${lane.end - viewport.left}px 100%,${lane.start - viewport.left}px 100%,${lane.start - viewport.left}px ${notchTop}px` : '';
        chat.style.clipPath = `polygon(0 0,100% 0,100% 100%,${r}px 100%,${r}px ${notchTop}px${laneNotch},${l}px ${notchTop}px,${l}px 100%,0 100%)`;
        ownedClip = chat.style.getPropertyValue('clip-path');
        ownedChatStyle = chat.getAttribute('style');
        Object.assign(cap.style, {
            left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${height}px`,
            background: underlay.background, borderLeft: style.borderLeft, borderRight: style.borderRight, borderBottom: style.borderBottom,
            borderBottomLeftRadius: corners.borderBottomLeftRadius, borderBottomRightRadius: corners.borderBottomRightRadius,
            clipPath: lane ? `polygon(0 0,${lane.start - left}px 0,${lane.start - left}px 100%,${lane.end - left}px 100%,${lane.end - left}px 0,100% 0,100% 100%,0 100%)` : 'none',
        });
        Object.assign(surface.style, { background: paint.background, opacity: paint.opacity, display: paint.display, borderRadius: 'inherit' });
        cap.dataset.messageId = row.getAttribute('mesid') || '';
        cap.hidden = false;
        if (transitions.size && windowRef.performance.now() < transitionDeadline) queue();
        else transitions.clear();
    }
    const onScroll = () => { clear(); queue(); };
    const onTransition = event => {
        if (!activeTargets.includes(event.target) || !/^(background|border|opacity)/.test(event.propertyName)) return;
        const key = transitionKey(event.target, event.pseudoElement, event.propertyName);
        if (event.type === 'transitionrun') {
            transitions.add(key);
            // Native selection lasts 200ms; a lost transition-end event cannot leave a frame loop alive.
            transitionDeadline = windowRef.performance.now() + 1000;
        } else transitions.delete(key);
        queue();
    };
    const observer = new windowRef.MutationObserver(records => {
        if (records.some(record => !(record.target === chat && record.type === 'attributes' && record.attributeName === 'style' && chat.getAttribute('style') === ownedChatStyle) && !cap.contains(record.target)
            && !record.target.parentElement?.closest('.sb-message-screenshot-shell'))) queue();
    });
    observer.observe(chat, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'is_user', 'is_system', 'open'] });
    for (const element of [documentRef.documentElement, documentRef.body, documentRef.getElementById('sheld'), documentRef.getElementById('sbstory-bar'), toolbar]) {
        if (element) observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-sb-theme', 'data-neconyan-palette', 'data-neconyan-calico-tone', 'data-neconyan-accent', 'data-neconyan-ui-theme', 'data-neconyan-chat-mode', 'data-sbtw-mode', 'data-sb-conversation-mode'] });
    }
    const onStylesheet = event => { if (event.target.matches?.('link[rel="stylesheet"]') || chat.contains(event.target)) queue(); };
    documentRef.addEventListener('load', onStylesheet, true);
    documentRef.addEventListener('error', onStylesheet, true);
    chat.addEventListener('scroll', onScroll, { passive: true });
    windowRef.addEventListener('resize', onScroll);
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) chat.addEventListener(type, onTransition);
    queue();
    return { dispose() {
        disposed = true;
        if (frame) windowRef.cancelAnimationFrame(frame);
        clear(); resize.disconnect(); observer.disconnect(); cap.remove();
        disposeEchoLayout(chat);
        chat.removeEventListener('scroll', onScroll); windowRef.removeEventListener('resize', onScroll);
        documentRef.removeEventListener('load', onStylesheet, true); documentRef.removeEventListener('error', onStylesheet, true);
        for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) chat.removeEventListener(type, onTransition);
    } };
}
