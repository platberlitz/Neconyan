import { MOBILE_SWIPE_RAIL_SELECTOR, resolveMobileShellNavScrollIndicators } from './mobile-shell-lifecycle/index.js';

/** Add phone overflow cues without wrapping, moving or inserting children into a rail. */
export function initMobileSwipeRails({ leftLabel, rightLabel }) {
    const phone = window.matchMedia('(max-width: 768px)');
    const records = new Map();
    let frame = 0;
    const pendingRoots = new Set([document.body]);
    const selectedTabs = new Set();
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    const setStyle = (element, property, value) => {
        if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
    };
    const toggle = (element, name, enabled) => {
        if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
    };

    function register(rail) {
        if (records.has(rail) || !(rail instanceof HTMLElement)) return;
        const chrome = document.createElement('div');
        chrome.className = 'sb-mobile-rail-chrome';
        const progressOnly = rail.id === 'leftSendForm';
        if (progressOnly) chrome.classList.add('sb-mobile-rail-progress-only');
        chrome.hidden = true;
        const buttons = (progressOnly ? [] : [-1, 1]).map(direction => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `sb-mobile-rail-arrow sb-mobile-rail-${direction < 0 ? 'left' : 'right'}`;
            button.setAttribute('aria-label', direction < 0 ? leftLabel : rightLabel);
            button.innerHTML = `<span aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${direction < 0 ? 'M10.5 3 5.5 8 10.5 13' : 'M5.5 3 10.5 8 5.5 13'}"/></svg></span>`;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                rail.scrollBy({
                    left: direction * rail.clientWidth * 0.68,
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
                });
                schedule();
            });
            chrome.append(button);
            return button;
        });
        const track = document.createElement('div');
        track.className = 'sb-mobile-rail-track';
        track.setAttribute('aria-hidden', 'true');
        track.innerHTML = '<div class="sb-mobile-rail-thumb"></div>';
        chrome.append(track);
        rail.parentElement.append(chrome);
        rail.addEventListener('scroll', schedule, { passive: true });
        const revealTab = event => {
            const tab = event.target.closest?.('[role="tab"]');
            if (phone.matches && tab && rail.contains(tab)) {
                tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            }
        };
        rail.addEventListener('click', revealTab);
        rail.addEventListener('focusin', revealTab);
        resize.observe(rail);
        records.set(rail, { chrome, buttons, revealTab, progressOnly });
    }

    function update() {
        frame = 0;
        for (const root of pendingRoots) {
            if (!root.isConnected) continue;
            if (root.matches?.(MOBILE_SWIPE_RAIL_SELECTOR)) register(root);
            root.querySelectorAll?.(MOBILE_SWIPE_RAIL_SELECTOR).forEach(register);
        }
        pendingRoots.clear();
        for (const [rail, { chrome, buttons, revealTab, progressOnly }] of records) {
            if (!rail.isConnected) {
                chrome.remove();
                resize.unobserve(rail);
                rail.removeEventListener('scroll', schedule);
                rail.removeEventListener('click', revealTab);
                rail.removeEventListener('focusin', revealTab);
                records.delete(rail);
                continue;
            }
            if (chrome.parentElement !== rail.parentElement) rail.parentElement.append(chrome);
            const style = getComputedStyle(rail);
            const visible = phone.matches && rail.getClientRects().length > 0
                && style.visibility !== 'hidden' && /auto|scroll/.test(style.overflowX);
            // Modern browsers use negative scrollLeft for RTL. Map to physical left/right.
            const scrollLeft = style.direction === 'rtl' ? rail.scrollWidth - rail.clientWidth + rail.scrollLeft : rail.scrollLeft;
            const state = resolveMobileShellNavScrollIndicators({
                scrollLeft, clientWidth: visible ? rail.clientWidth : 0, scrollWidth: rail.scrollWidth,
            });
            toggle(rail, 'sb-mobile-swipe-rail', state.hasOverflow && !progressOnly);
            toggle(rail, 'sb-can-scroll-left', state.canScrollLeft);
            toggle(rail, 'sb-can-scroll-right', state.canScrollRight);
            if (chrome.hidden === state.hasOverflow) chrome.hidden = !state.hasOverflow;
            if (!state.hasOverflow) continue;
            buttons.forEach((button, index) => {
                const enabled = index === 0 ? state.canScrollLeft : state.canScrollRight;
                if (button.hidden === enabled) button.hidden = !enabled;
                if (button.disabled === enabled) button.disabled = !enabled;
            });
            setStyle(chrome, '--sb-rail-thumb-width', `${state.thumbWidthPercent}%`);
            setStyle(chrome, '--sb-rail-thumb-left', `${state.thumbOffsetPercent}%`);
            // The sibling inherits drawer stacking and clipping, including dialog top layers.
            // Offset-parent coordinates also follow scaled composer and theme containers.
            const parent = chrome.offsetParent;
            if (!(parent instanceof HTMLElement)) continue;
            const box = rail.getBoundingClientRect();
            const origin = parent.getBoundingClientRect();
            const scaleX = origin.width / parent.offsetWidth || 1;
            const scaleY = origin.height / parent.offsetHeight || 1;
            setStyle(chrome, 'left', `${(box.left - origin.left) / scaleX + parent.scrollLeft - parent.clientLeft}px`);
            setStyle(chrome, 'top', `${(box.top - origin.top) / scaleY + parent.scrollTop - parent.clientTop}px`);
            setStyle(chrome, 'width', `${box.width / scaleX}px`);
            setStyle(chrome, 'height', `${box.height / scaleY}px`);
        }
        for (const tab of selectedTabs) {
            if (phone.matches && tab.isConnected && tab.getClientRects().length) {
                tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            }
        }
        selectedTabs.clear();
    }

    const observer = new MutationObserver(mutations => {
        let dirty = false;
        for (const mutation of mutations) {
            const target = mutation.target;
            if (!(target instanceof Element) || target.closest('.sb-mobile-rail-chrome')) continue;
            if (mutation.attributeName === 'aria-selected' && target.matches('[role="tab"][aria-selected="true"]')
                && target.closest(MOBILE_SWIPE_RAIL_SELECTOR)) selectedTabs.add(target);
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element && !node.matches('.sb-mobile-rail-chrome')) pendingRoots.add(node);
                }
            }
            // Ignore our own state classes, otherwise each scroll schedules another layout.
            if (mutation.attributeName === 'class') {
                const clean = value => (value || '').split(/\s+/).filter(name => !/^sb-(mobile-swipe-rail|can-scroll-left|can-scroll-right)$/.test(name)).join(' ');
                if (clean(mutation.oldValue) === clean(target.getAttribute('class'))) continue;
                if (target.matches(MOBILE_SWIPE_RAIL_SELECTOR)) pendingRoots.add(target);
            }
            if ([...records.keys()].some(rail => !rail.isConnected || target.contains(rail) || rail.contains(target))) dirty = true;
        }
        if (dirty || pendingRoots.size) schedule();
    });
    observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeOldValue: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-selected', 'data-sb-compact-mode'],
    });
    // Scrolling an ancestor moves unpositioned siblings relative to their offset parent.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('transitionend', schedule);
    document.addEventListener('animationend', schedule);
    document.addEventListener('load', event => {
        if (event.target instanceof Element && event.target.closest(MOBILE_SWIPE_RAIL_SELECTOR)) schedule();
    }, true);
    window.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule, { passive: true });
    phone.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    schedule();
}
