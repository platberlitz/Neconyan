import { extensionNames, findExtension, getExtensionManifest, getExtensionType } from './extensions.js';
import { eventSource, event_types } from './events.js';
import { getRequestHeaders } from '../script.js';
import { accountStorage } from './util/AccountStorage.js';

/**
 * Neconyan Settings Tabs Overhaul
 * Self-contained settings tab layout and search integration.
 */

(function () {
    const tabStyles = `
        /* Tab bar container */
        .sb-settings-tabs-nav {
            display: flex;
            flex-direction: row;
            gap: 8px;
            margin: 12px 0 16px 0;
            border-bottom: 1px solid color-mix(in srgb, var(--sb-shell-border, #cfcfc5) 20%, transparent);
            padding-bottom: 8px;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }

        /* Tab buttons */
        .sb-settings-tab-btn {
            background: var(--sb-card-bg, #2f3238);
            color: var(--sb-text-muted, #999992);
            border: 1px solid color-mix(in srgb, var(--sb-shell-border, #cfcfc5) 15%, transparent);
            border-radius: var(--sb-radius-button, 14px);
            padding: 10px 16px;
            font-family: var(--sb-font-display, "Fredoka One", "Figtree", sans-serif);
            font-size: calc(var(--mainFontSize, 16px) * 0.88);
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease-in-out;
            white-space: nowrap;
        }

        .sb-settings-tab-btn:hover {
            background: var(--sb-bg-hover, #393d41);
            color: var(--sb-text-color, #cfcfc5);
        }

        .sb-settings-tab-btn.active {
            background: var(--color-primary, var(--sb-accent, #c9c6a8));
            color: var(--sb-on-accent, #050607);
            border-color: var(--color-primary, var(--sb-accent, #c9c6a8));
            box-shadow: 0 4px 12px color-mix(in srgb, var(--color-primary, var(--sb-accent, #c9c6a8)) 25%, transparent);
        }

        /* Content grid layout on desktop */
        @media (min-width: 769px) {
            #user-settings-block-content {
                display: grid !important;
                grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) !important;
                gap: 16px !important;
                align-items: start !important;
            }

            /* Hide original columns so they don't affect layout boxes */
            [name="UserSettingsFirstColumn"],
            [name="UserSettingsSecondColumn"],
            [name="UserSettingsThirdColumn"] {
                display: contents !important;
            }
        }

        /* Standard responsive fallback for tablet/mobile */
        @media (max-width: 768px) {
            #user-settings-block-content {
                display: flex !important;
                flex-direction: column !important;
                gap: 12px !important;
            }
        }

        /* Declarative visibility rules based on active tab.
           Only drawers that carry a tag are hidden. An untagged drawer -- a third-party one that
           landed here after tagDrawersWithCategories() last ran -- stays visible rather than
           vanishing from all four tabs; tagUntaggedDrawers() then settles it into one. */
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="appearance"] .inline-drawer[data-settings-tab]:not([data-settings-tab="appearance"]),
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="chat-writing"] .inline-drawer[data-settings-tab]:not([data-settings-tab="chat-writing"]),
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="system-device"] .inline-drawer[data-settings-tab]:not([data-settings-tab="system-device"]),
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="cache-account"] .inline-drawer[data-settings-tab]:not([data-settings-tab="cache-account"]) {
            display: none !important;
        }

        /* Highlighting of search results inside inactive tabs */
        .highlighted-drawer {
            border-color: var(--color-primary, var(--sb-accent, #c9c6a8)) !important;
            box-shadow: 0 0 10px color-mix(in srgb, var(--color-primary, var(--sb-accent, #c9c6a8)) 30%, transparent) !important;
        }

        /* Style for account and cache drawers when placed inside the content block */
        #sb-account-settings-drawer #account_controls,
        #sb-account-settings-drawer #passkey_controls,
        #sb-cache-settings-drawer #user-settings-utility-actions {
            background: none !important;
            border: none !important;
            padding: 8px 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            width: 100% !important;
        }

        #sb-cache-settings-drawer #user-settings-utility-actions {
            flex-direction: column !important;
            align-items: stretch !important;
        }

        #sb-cache-settings-drawer #user-settings-utility-actions .sb-settings-utility-note {
            flex: 0 0 auto !important;
            margin-bottom: 12px !important;
        }

        #sb-cache-settings-drawer #user-settings-utility-actions .sb-settings-utility-action {
            flex: 0 0 auto !important;
        }
    `;

    function injectStyles() {
        if (document.getElementById('sb-settings-tabs-styles')) {
            return;
        }
        const style = document.createElement('style');
        style.id = 'sb-settings-tabs-styles';
        style.textContent = tabStyles;
        document.head.appendChild(style);
    }

    function promoteNestedDrawers() {
        // Promote nested subdrawers from AppearanceSection
        const parentAppearance = document.getElementById('AppearanceSection');
        const col1 = document.querySelector('[name="UserSettingsFirstColumn"]');
        if (parentAppearance && col1) {
            // Give parent drawer header a cleaner title
            const mainHeaderSpan = parentAppearance.querySelector(':scope > .inline-drawer-header b span');
            if (mainHeaderSpan) {
                mainHeaderSpan.textContent = 'UI Theme';
                mainHeaderSpan.setAttribute('data-i18n', 'UI Theme');
            }

            // Keep palettes and accent controls separate from full UI themes
            const themePresets = parentAppearance.querySelector('#UI-presets-block > .sb-theme-presets');
            if (themePresets && !document.getElementById('sb-theme-presets-drawer')) {
                const presetsDrawer = document.createElement('div');
                presetsDrawer.id = 'sb-theme-presets-drawer';
                presetsDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
                presetsDrawer.innerHTML = `
                    <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable">
                        <b><i class="fa-solid fa-swatchbook"></i> <span data-i18n="Accent Profiles">Accent Profiles</span></b>
                        <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                    </div>
                    <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                    </div>
                `;
                parentAppearance.insertAdjacentElement('afterend', presetsDrawer);
                presetsDrawer.querySelector('.inline-drawer-content').appendChild(themePresets);
            }

            // Find AppearanceLayoutSection
            const layoutSec = document.getElementById('AppearanceLayoutSection');
            if (layoutSec) {
                col1.appendChild(layoutSec);
            }

            // Find ThemeTogglesSection
            const togglesSec = document.getElementById('ThemeTogglesSection');
            if (togglesSec) {
                col1.appendChild(togglesSec);
            }

            // Find Theme Colors inline-drawer
            const themeColorsDrawer = Array.from(parentAppearance.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Theme Colors');
            });
            if (themeColorsDrawer) {
                themeColorsDrawer.id = 'sb-theme-colors-drawer';
                themeColorsDrawer.classList.add('sb-settings-subdrawer');
                col1.appendChild(themeColorsDrawer);
            }

            // Promote Avatar & Chat Styles inline-drawer
            const avatarChatBlock = document.querySelector('[name="AvatarAndChatDisplay"]');
            if (avatarChatBlock && col1 && !document.getElementById('sb-avatar-chat-styles-drawer')) {
                const avatarChatDrawer = document.createElement('div');
                avatarChatDrawer.id = 'sb-avatar-chat-styles-drawer';
                avatarChatDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
                avatarChatDrawer.innerHTML = `
                    <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Customize avatar shapes and chat bubble layouts.">
                        <b><i class="fa-solid fa-wand-magic-sparkles"></i> <span>Avatar &amp; Chat Styles</span></b>
                        <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                    </div>
                    <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                    </div>
                `;
                avatarChatBlock.parentNode.insertBefore(avatarChatDrawer, avatarChatBlock);
                avatarChatDrawer.querySelector('.inline-drawer-content').appendChild(avatarChatBlock);
                col1.appendChild(avatarChatDrawer);
            }
        }

        // Promote nested subdrawers from ChatCharactersSection
        const parentChatCharacters = document.getElementById('ChatCharactersSection');
        const col2 = document.querySelector('[name="UserSettingsSecondColumn"]');
        if (parentChatCharacters && col2) {
            // Find Auto-swipe drawer
            const autoSwipeDrawer = Array.from(parentChatCharacters.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Auto-swipe');
            });
            if (autoSwipeDrawer) {
                autoSwipeDrawer.id = 'sb-auto-swipe-drawer';
                col2.appendChild(autoSwipeDrawer);
            }

            // Find Auto-Continue drawer
            const autoContinueDrawer = Array.from(parentChatCharacters.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Auto-Continue');
            });
            if (autoContinueDrawer) {
                autoContinueDrawer.id = 'sb-auto-continue-drawer';
                col2.appendChild(autoContinueDrawer);
            }

            // Find other named nested drawers
            const customCss = document.getElementById('CustomCSS-block');
            if (customCss) col2.appendChild(customCss);

            const googleFont = document.getElementById('GoogleFont-block');
            if (googleFont) col2.appendChild(googleFont);

            const desktopSec = document.getElementById('DesktopSection');
            if (desktopSec) col2.appendChild(desktopSec);

            const mobileSec = document.getElementById('MobileSection');
            if (mobileSec) col2.appendChild(mobileSec);

            const autoComplete = document.querySelector('[name="AutoCompleteToggle"]');
            if (autoComplete) col2.appendChild(autoComplete);
        }

        // Wrap iOS WebKit Streaming Stability in its own inline-drawer
        const iosBlock = document.querySelector('[name="IOSWebKitStreamingToggles"]');
        if (iosBlock && col2 && !document.getElementById('sb-ios-webkit-streaming-drawer')) {
            const iosDrawer = document.createElement('div');
            iosDrawer.id = 'sb-ios-webkit-streaming-drawer';
            iosDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            iosDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Controls iPhone and iPad WebKit safeguards for long streamed generations.">
                    <b><i class="fa-solid fa-mobile-screen-button"></i> <span>iOS Streaming Stability</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                </div>
            `;
            iosBlock.parentNode.insertBefore(iosDrawer, iosBlock);
            iosDrawer.querySelector('.inline-drawer-content').appendChild(iosBlock);
            col2.appendChild(iosDrawer);
        }

        // Wrap Android Streaming Stability in its own inline-drawer
        const androidBlock = document.querySelector('[name="AndroidStreamingToggles"]');
        if (androidBlock && col2 && !document.getElementById('sb-android-streaming-drawer')) {
            const androidDrawer = document.createElement('div');
            androidDrawer.id = 'sb-android-streaming-drawer';
            androidDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            androidDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Controls Android browser safeguards for long streamed generations.">
                    <b><i class="fa-solid fa-mobile-screen"></i> <span>Android Streaming Stability</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                </div>
            `;
            androidBlock.parentNode.insertBefore(androidDrawer, androidBlock);
            androidDrawer.querySelector('.inline-drawer-content').appendChild(androidBlock);
            col2.appendChild(androidDrawer);
        }

        // Wrap Aggressive DOM Unloading in its own inline-drawer
        const domUnloadBlock = document.querySelector('[name="AggressiveDomUnloadToggles"]');
        if (domUnloadBlock && col2 && !document.getElementById('sb-aggressive-dom-unload-drawer')) {
            const domUnloadDrawer = document.createElement('div');
            domUnloadDrawer.id = 'sb-aggressive-dom-unload-drawer';
            domUnloadDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            domUnloadDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Drastically reduces rendered messages to prevent crashes on low-memory devices during long streams.">
                    <b><i class="fa-solid fa-memory"></i> <span>Aggressive DOM Unloading</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                </div>
            `;
            domUnloadBlock.parentNode.insertBefore(domUnloadDrawer, domUnloadBlock);
            domUnloadDrawer.querySelector('.inline-drawer-content').appendChild(domUnloadBlock);
            col2.appendChild(domUnloadDrawer);
        }
    }

    function ensureStscriptDrawer() {
        const source = document.querySelector('[name="STscriptToggles"]');
        const chatSection = document.getElementById('ChatCharactersSection');
        if (!(source instanceof HTMLElement) || !(chatSection instanceof HTMLElement)) return;
        if (source.closest('#sb-stscript-drawer')) return;

        const drawer = document.createElement('div');
        drawer.id = 'sb-stscript-drawer';
        drawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
        drawer.dataset.settingsTab = 'chat-writing';
        const header = document.createElement('div');
        header.className = 'inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable';
        header.title = 'Set the default flags used by the STscript parser.';
        header.innerHTML = '<b><i class="fa-solid fa-terminal" aria-hidden="true"></i> <span>STscript Settings</span></b><div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>';
        const body = document.createElement('div');
        body.className = 'inline-drawer-content sb-settings-subdrawer-body';
        body.style.display = 'none';
        body.append(...source.childNodes);
        drawer.append(header, body);
        chatSection.parentElement?.insertBefore(drawer, chatSection.nextSibling);
        source.remove();
    }

    function ensureSettingsHeaderIcons() {
        const content = document.getElementById('user-settings-block-content');
        if (!(content instanceof HTMLElement)) return;

        const icons = new Map([
            ['AppearanceSection', 'fa-palette'],
            ['sb-theme-presets-drawer', 'fa-swatchbook'],
            ['AppearanceLayoutSection', 'fa-ruler-combined'],
            ['sb-theme-colors-drawer', 'fa-fill-drip'],
            ['ThemeTogglesSection', 'fa-toggle-on'],
            ['sb-avatar-chat-styles-drawer', 'fa-wand-magic-sparkles'],
            ['ChatCharactersSection', 'fa-comments'],
            ['ChatMessageHandlingSection', 'fa-message'],
            ['sb-auto-swipe-drawer', 'fa-forward-step'],
            ['sb-auto-continue-drawer', 'fa-forward-fast'],
            ['CustomCSS-block', 'fa-code'],
            ['GoogleFont-block', 'fa-font'],
            ['sb-stscript-drawer', 'fa-terminal'],
            ['DesktopSection', 'fa-desktop'],
            ['MobileSection', 'fa-mobile-screen-button'],
        ]);
        const textIcons = [
            [/auto.?complete/i, 'fa-keyboard'],
            [/chat\s*\/\s*message/i, 'fa-message'],
            [/theme\s*color/i, 'fa-fill-drip'],
            [/visual\s*toggle/i, 'fa-toggle-on'],
            [/page\s*size|clarity/i, 'fa-ruler-combined'],
            [/avatar.*chat/i, 'fa-wand-magic-sparkles'],
            [/stscript/i, 'fa-terminal'],
            [/google\s*font/i, 'fa-font'],
            [/custom\s*css/i, 'fa-code'],
        ];

        for (const drawer of content.querySelectorAll('.inline-drawer')) {
            const header = drawer.querySelector(':scope > .inline-drawer-header');
            const label = header?.querySelector(':scope b, :scope strong, :scope span');
            if (!(header instanceof HTMLElement) || !(label instanceof HTMLElement) || label.querySelector('i')) continue;
            const icon = icons.get(drawer.id) || textIcons.find(([pattern]) => pattern.test(label.textContent || ''))?.[1];
            if (!icon) continue;
            const glyph = document.createElement('i');
            glyph.className = `fa-solid ${icon}`;
            glyph.setAttribute('aria-hidden', 'true');
            label.prepend(glyph, ' ');
        }
    }

    function createRetiredContentDrawer(parent) {
        if (!(parent instanceof HTMLElement) || document.getElementById('nn-retired-content-drawer')) return;
        const drawer = document.createElement('div');
        drawer.id = 'nn-retired-content-drawer';
        drawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer neconyan-retired-content-drawer';
        drawer.dataset.settingsTab = 'cache-account';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'inline-drawer-toggle inline-drawer-header neconyan-retired-content-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<span><i class="fa-solid fa-box-archive" aria-hidden="true"></i> <span>Old defaults &amp; recovery</span></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
        const body = document.createElement('div');
        body.id = 'nn-retired-content-body';
        toggle.setAttribute('aria-controls', body.id);
        body.className = 'inline-drawer-content sb-settings-subdrawer-body neconyan-retired-content-body';
        body.hidden = true;
        const intro = document.createElement('p');
        intro.className = 'neconyan-retired-content-copy';
        intro.textContent = 'Paw through untouched files left by older installs. Your edits and personal imports stay put.';
        const controls = document.createElement('div');
        controls.className = 'neconyan-retired-content-controls';
        const buttons = ['Check old defaults', 'Archive selected', 'Retry', 'Reload Neconyan'].map(label => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button menu_button_icon';
            button.textContent = label;
            controls.appendChild(button);
            return button;
        });
        const [checkButton, archiveButton, retryButton, reloadButton] = buttons;
        const status = document.createElement('p');
        status.className = 'neconyan-retired-content-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.tabIndex = -1;
        const list = document.createElement('div');
        body.append(intro, controls, status, list);
        drawer.append(toggle, body);
        parent.appendChild(drawer);

        const state = { handle: '', candidates: [], archived: [], selected: new Set(), busy: false, loaded: false, changed: false, retry: null, focus: null };
        const selectedCandidates = () => state.candidates.filter(entry => entry.state === 'ready' && state.selected.has(entry.id));
        const rememberFocus = () => { state.focus = body.contains(document.activeElement) ? document.activeElement : null; };
        const restoreFocus = () => {
            if (state.busy || !state.focus) return;
            const old = state.focus;
            state.focus = null;
            if (body.hidden || (document.activeElement !== document.body && document.activeElement !== old && !body.contains(document.activeElement))) return;
            const id = old.dataset?.retiredId;
            const target = id ? [...list.querySelectorAll('input, button')].find(element => element.dataset.retiredId === id) : old;
            if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
            else if (status.getClientRects().length) status.focus({ preventScroll: true });
        };
        const request = async (endpoint, payload) => {
            const response = await fetch(`/api/content/retired/${endpoint}`, {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
            return data;
        };
        const fetchInventory = async () => {
            const data = await request('list', {});
            if (typeof data.handle !== 'string' || !data.handle || !Array.isArray(data.candidates) || !Array.isArray(data.archived)) {
                throw new Error('The recovery list could not be read. Please retry.');
            }
            if (state.handle !== data.handle) {
                state.selected.clear();
                state.changed = false;
            }
            state.handle = data.handle;
            state.candidates = data.candidates;
            state.archived = data.archived;
            state.loaded = true;
            return Array.isArray(data.warnings) ? data.warnings.join(' ') : '';
        };
        const render = () => {
            list.replaceChildren();
            body.setAttribute('aria-busy', String(state.busy));
            const selected = selectedCandidates();
            archiveButton.textContent = selected.some(entry => entry.action === 'replace')
                ? selected.length === 1 ? 'Replace with Neconyan avatar' : 'Archive files and replace avatar'
                : 'Archive selected';
            for (const button of buttons) button.disabled = state.busy;
            archiveButton.disabled = state.busy || !state.handle || !selected.length;
            retryButton.hidden = !state.retry;
            reloadButton.hidden = !state.changed;
            for (const [title, entries, archived] of [
                ['Ready to archive', state.candidates.filter(entry => entry.state === 'ready'), false],
                ['Still in use', state.candidates.filter(entry => entry.state !== 'ready'), false],
                ['Archived', state.archived, true],
            ]) {
                const section = document.createElement('section');
                section.className = 'neconyan-retired-content-section';
                const heading = document.createElement('h4');
                heading.textContent = title;
                section.appendChild(heading);
                if (!entries.length) {
                    const empty = document.createElement('p');
                    empty.className = 'neconyan-retired-content-empty';
                    empty.textContent = archived ? 'Nothing is archived yet.' : 'Nothing here.';
                    section.appendChild(empty);
                }
                for (const entry of entries) {
                    const row = document.createElement(archived ? 'div' : 'label');
                    row.className = 'neconyan-retired-content-row';
                    const copy = document.createElement('div');
                    copy.className = 'neconyan-retired-content-row-copy';
                    const name = document.createElement('strong');
                    name.textContent = entry.name;
                    const detail = document.createElement('span');
                    detail.className = 'neconyan-retired-content-row-detail';
                    detail.textContent = entry.reason || (entry.status === 'attention'
                        ? 'This archive needs attention. Check the archived files before restoring.'
                        : entry.status === 'restored' ? `Restored as ${entry.restoredName || entry.name}.`
                            : entry.action === 'replace' ? 'Archive the old avatar and use the Neconyan avatar.' : '');
                    copy.append(name, detail);
                    row.appendChild(copy);
                    if (archived) {
                        const restore = document.createElement('button');
                        restore.type = 'button';
                        restore.className = 'menu_button menu_button_icon';
                        restore.dataset.retiredId = entry.id;
                        restore.textContent = entry.status === 'restoring' ? 'Retry restore' : 'Restore';
                        restore.disabled = state.busy || ['attention', 'pending'].includes(entry.status);
                        restore.addEventListener('click', () => restoreOne(entry.id));
                        row.appendChild(restore);
                    } else {
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.dataset.retiredId = entry.id;
                        checkbox.checked = state.selected.has(entry.id);
                        checkbox.disabled = state.busy || entry.state !== 'ready';
                        checkbox.setAttribute('aria-label', `Select ${entry.name}`);
                        checkbox.addEventListener('change', () => {
                            rememberFocus();
                            if (checkbox.checked) {
                                state.selected.add(entry.id);
                                for (const id of entry.dependencies || []) {
                                    if (state.candidates.some(candidate => candidate.id === id && candidate.state === 'ready')) state.selected.add(id);
                                }
                            } else {
                                state.selected.delete(entry.id);
                                for (const candidate of state.candidates) {
                                    if ((candidate.dependencies || []).includes(entry.id)) state.selected.delete(candidate.id);
                                }
                            }
                            render();
                        });
                        row.prepend(checkbox);
                    }
                    section.appendChild(row);
                }
                list.appendChild(section);
            }
            queueMicrotask(restoreFocus);
        };
        async function load() {
            if (state.busy) return;
            rememberFocus();
            state.busy = true;
            state.retry = null;
            status.textContent = 'Checking old defaults...';
            render();
            try {
                const warning = await fetchInventory();
                status.textContent = warning || (state.candidates.length ? '' : 'All tidy. No old defaults are waiting. Purrfect.');
            } catch (error) {
                status.textContent = error.message;
                state.retry = load;
            } finally {
                state.busy = false;
                render();
            }
        }
        async function archive() {
            if (state.busy || !selectedCandidates().length) return;
            rememberFocus();
            state.busy = true;
            state.retry = null;
            status.textContent = 'Archiving selected files...';
            const names = new Map(state.candidates.map(entry => [entry.id, entry.name]));
            const ids = selectedCandidates().map(entry => entry.id);
            const handle = state.handle;
            let message = '';
            render();
            try {
                const data = await request('archive', { handle, ids });
                if (!Array.isArray(data.results)) throw new Error('The archive result could not be read. Check old defaults before retrying.');
                const failed = data.results.filter(result => !result.ok);
                for (const result of data.results) {
                    if (result.ok) { state.selected.delete(result.id); state.changed = true; }
                }
                message = failed.length ? failed.map(result => `${names.get(result.id) || 'File'}: ${result.reason || 'Could not archive this file.'}`).join(' ')
                    : 'Selected old defaults are safely archived.';
                const warning = await fetchInventory();
                status.textContent = handle === state.handle ? [message, warning].filter(Boolean).join(' ') : 'Account changed. Check the files for this account.';
                if (failed.length) state.retry = archive;
            } catch (error) {
                status.textContent = [message, error.message].filter(Boolean).join(' ');
                state.retry = message ? load : archive;
            } finally {
                state.busy = false;
                render();
            }
        }
        async function restoreOne(id) {
            if (state.busy) return;
            rememberFocus();
            state.busy = true;
            state.retry = null;
            status.textContent = 'Restoring archived file...';
            const handle = state.handle;
            let message = '';
            render();
            try {
                const data = await request('restore', { handle, id });
                if (!data.ok || typeof data.name !== 'string') throw new Error('The restore result could not be read. Check old defaults before retrying.');
                message = `Restored as ${data.name}.`;
                state.changed = true;
                const warning = await fetchInventory();
                status.textContent = handle === state.handle ? [message, warning].filter(Boolean).join(' ') : 'Account changed. Check the files for this account.';
            } catch (error) {
                status.textContent = [message, error.message].filter(Boolean).join(' ');
                state.retry = message ? load : () => restoreOne(id);
            } finally {
                state.busy = false;
                render();
            }
        }
        toggle.addEventListener('click', event => {
            event.stopPropagation();
            const open = body.hidden;
            body.hidden = !open;
            body.style.display = open ? 'block' : 'none';
            toggle.setAttribute('aria-expanded', String(open));
            if (open && !state.loaded) void load();
        });
        checkButton.addEventListener('click', () => void load());
        archiveButton.addEventListener('click', () => void archive());
        retryButton.addEventListener('click', () => { if (state.retry) void state.retry(); });
        reloadButton.addEventListener('click', () => window.location.reload());
        render();
    }

    function promoteCacheAccount() {
        const col1 = document.querySelector('[name="UserSettingsFirstColumn"]');
        const col2 = document.querySelector('[name="UserSettingsSecondColumn"]');
        const accountControls = document.getElementById('account_controls');
        const cacheActions = document.getElementById('user-settings-utility-actions');

        // Create Account Controls drawer in Col 1
        if (accountControls && col1 && !document.getElementById('sb-account-settings-drawer')) {
            const accountDrawer = document.createElement('div');
            accountDrawer.id = 'sb-account-settings-drawer';
            accountDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            accountDrawer.setAttribute('data-settings-tab', 'cache-account');
            accountDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Manage your user account, login sessions, and administrative controls.">
                    <b><i class="fa-solid fa-user-shield"></i> <span>Account Settings</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:block">
                </div>
            `;
            accountControls.parentNode.insertBefore(accountDrawer, accountControls);
            accountDrawer.querySelector('.inline-drawer-content').appendChild(accountControls);
            const passkeyControls = document.getElementById('passkey_controls');
            if (passkeyControls) {
                accountDrawer.querySelector('.inline-drawer-content').appendChild(passkeyControls);
            }
            col1.appendChild(accountDrawer);
        } else if (document.getElementById('sb-account-settings-drawer')) {
            // Late-arriving passkey section still belongs in the account drawer.
            const passkeyControls = document.getElementById('passkey_controls');
            const accountDrawer = document.getElementById('sb-account-settings-drawer');
            if (passkeyControls && accountDrawer && !accountDrawer.contains(passkeyControls)) {
                accountDrawer.querySelector('.inline-drawer-content').appendChild(passkeyControls);
            }
        }

        // Create Cache Utilities drawer in Col 2
        if (cacheActions && col2 && !document.getElementById('sb-cache-settings-drawer')) {
            const cacheDrawer = document.createElement('div');
            cacheDrawer.id = 'sb-cache-settings-drawer';
            cacheDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            cacheDrawer.setAttribute('data-settings-tab', 'cache-account');
            cacheDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Clear temporary files, browser cache, and other local data.">
                    <b><i class="fa-solid fa-broom"></i> <span>Cache &amp; Storage Utilities</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:block">
                </div>
            `;
            cacheActions.parentNode.insertBefore(cacheDrawer, cacheActions);
            cacheDrawer.querySelector('.inline-drawer-content').appendChild(cacheActions);
            col2.appendChild(cacheDrawer);
        }

        createRetiredContentDrawer(col2 || col1);
    }

    function tagDrawersWithCategories() {
        const mappings = {
            // Appearance Tab
            'AppearanceSection': 'appearance',
            'sb-theme-presets-drawer': 'appearance',
            'sb-theme-colors-drawer': 'appearance',
            'sb-avatar-chat-styles-drawer': 'appearance',
            'AppearanceLayoutSection': 'appearance',
            'ThemeTogglesSection': 'appearance',
            'CustomCSS-block': 'appearance',
            'GoogleFont-block': 'appearance',

            // Chat & Writing Tab
            'ChatCharactersSection': 'chat-writing',
            'sb-auto-swipe-drawer': 'chat-writing',
            'sb-auto-continue-drawer': 'chat-writing',
            'AutoCompleteToggle': 'chat-writing', // will match name attribute or ID
            'ChatMessageHandlingSection': 'chat-writing',

            // System & Device Tab
            'SillyTavernImportSection': 'system-device',
            'DesktopSection': 'system-device',
            'MobileSection': 'system-device',
            'sb-ios-webkit-streaming-drawer': 'system-device',
            'sb-android-streaming-drawer': 'system-device',
            'sb-aggressive-dom-unload-drawer': 'system-device',

            // Cache & Account Tab
            'sb-account-settings-drawer': 'cache-account',
            'sb-cache-settings-drawer': 'cache-account',
        };

        for (const [idOrName, tab] of Object.entries(mappings)) {
            const el = document.getElementById(idOrName) || document.querySelector(`[name="${idOrName}"]`);
            if (el) {
                el.setAttribute('data-settings-tab', tab);
            }
        }
    }

    // Third-party extensions append their settings drawers long after initialize() runs, and the
    // map above only knows this fork's own drawers. Give the leftovers a home so they show up in
    // exactly one tab instead of every tab.
    const DEFAULT_SETTINGS_TAB = 'system-device';

    function tagUntaggedDrawers() {
        const content = document.getElementById('user-settings-block-content');
        if (!content) return;

        content.querySelectorAll('.inline-drawer:not([data-settings-tab])').forEach(drawer => {
            // A drawer nested inside an already-tagged section rides its parent's visibility.
            if (drawer.parentElement?.closest('.inline-drawer[data-settings-tab]')) return;
            drawer.setAttribute('data-settings-tab', DEFAULT_SETTINGS_TAB);
        });
    }

    const SETTINGS_CATEGORIES = Object.freeze([
        { id: 'appearance', label: 'Appearance', icon: 'fa-palette' },
        { id: 'chat-writing', label: 'Chat & Writing', icon: 'fa-comments' },
        { id: 'system-device', label: 'System & Device', icon: 'fa-laptop-code' },
        { id: 'cache-account', label: 'Cache & Account', icon: 'fa-user-shield' },
    ]);
    const settingsControllerState = { controller: null };
    const extensionsControllerState = { controller: null };

    function getSettingsCategory(categoryId) {
        return SETTINGS_CATEGORIES.find(category => category.id === categoryId) || SETTINGS_CATEGORIES[0];
    }

    function getSettingsTopDrawers(content) {
        if (!(content instanceof HTMLElement)) {
            return [];
        }

        return Array.from(content.querySelectorAll('.inline-drawer[data-settings-tab]')).filter(drawer => (
            !drawer.parentElement?.closest('.inline-drawer[data-settings-tab]')
        ));
    }

    function normalizeSettingsSearchText(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    }

    function clearSettingsSearch(searchInput) {
        if (!searchInput || !searchInput.value) {
            return;
        }
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function markSearchIndexIgnored(element) {
        element?.setAttribute('data-sb-search-index-ignore', 'true');
        return element;
    }

    function createSettingsNavigator(content) {
        if (!(content instanceof HTMLElement) || !(content.parentElement instanceof HTMLElement)) {
            return null;
        }

        const existingLayout = content.closest('.sb-settings-layout');
        if (existingLayout instanceof HTMLElement) {
            return existingLayout;
        }

        const sourceParent = content.parentElement;
        const layout = document.createElement('div');
        layout.className = 'sb-settings-layout';

        const navColumn = document.createElement('div');
        navColumn.className = 'sb-settings-nav-column';

        const nav = markSearchIndexIgnored(document.createElement('nav'));
        nav.id = 'sb-settings-tabs';
        nav.className = 'sb-settings-tabs-nav';
        nav.setAttribute('aria-label', 'Settings categories');

        const detail = document.createElement('div');
        detail.className = 'sb-settings-detail';

        const searchBar = markSearchIndexIgnored(document.createElement('div'));
        searchBar.className = 'sb-settings-search';
        const searchLabel = document.createElement('label');
        searchLabel.className = 'sb-settings-search-label';
        searchLabel.textContent = 'Find a setting';
        const searchInput = document.getElementById('settingsSearch');
        if (searchInput instanceof HTMLInputElement || searchInput instanceof HTMLTextAreaElement) {
            searchInput.classList.remove('sb-legacy-search-hidden');
            searchInput.setAttribute('aria-label', 'Find a setting');
            searchLabel.htmlFor = searchInput.id;
            searchBar.append(searchLabel, searchInput);
        }

        const heading = markSearchIndexIgnored(document.createElement('h3'));
        heading.className = 'sb-settings-detail-heading';
        const resultCount = document.createElement('p');
        resultCount.className = 'sb-settings-search-count';
        resultCount.setAttribute('role', 'status');
        resultCount.setAttribute('aria-live', 'polite');
        const noResults = document.createElement('p');
        noResults.className = 'sb-settings-no-results';
        noResults.textContent = 'No settings match that search.';
        noResults.hidden = true;

        const mobileSelect = markSearchIndexIgnored(document.createElement('select'));
        mobileSelect.className = 'sb-settings-category-select';
        mobileSelect.setAttribute('aria-label', 'Settings category');
        mobileSelect.name = 'sb-settings-category';
        mobileSelect.hidden = false;

        for (const category of SETTINGS_CATEGORIES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sb-settings-tab-btn';
            button.dataset.tab = category.id;
            button.innerHTML = `<i class="fa-solid ${category.icon}" aria-hidden="true"></i><span>${category.label}</span>`;
            nav.appendChild(button);

            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = category.label;
            mobileSelect.appendChild(option);
        }

        navColumn.append(nav, mobileSelect);
        layout.append(navColumn, detail);
        sourceParent.insertBefore(layout, content);
        detail.append(searchBar, heading, resultCount, noResults, content);

        return {
            layout,
            nav,
            detail,
            heading,
            resultCount,
            noResults,
            mobileSelect,
            searchInput,
            content,
            settingsBlock: document.getElementById('user-settings-block'),
        };
    }

    function createSettingsController(content) {
        const refs = createSettingsNavigator(content);
        if (!refs) {
            return null;
        }

        let activeCategory = getSettingsCategory(refs.content.dataset.activeTab).id;
        let query = '';
        let drawers = [];

        const setCategory = categoryId => {
            activeCategory = getSettingsCategory(categoryId).id;
            const category = getSettingsCategory(activeCategory);
            for (const root of [refs.layout, refs.detail, refs.content, refs.settingsBlock]) {
                root?.setAttribute('data-active-tab', activeCategory);
            }
            refs.heading.textContent = category.label;
            refs.nav.querySelectorAll('.sb-settings-tab-btn').forEach(button => {
                const isActive = button.dataset.tab === activeCategory;
                button.classList.toggle('active', isActive);
                if (isActive) {
                    button.setAttribute('aria-current', 'page');
                } else {
                    button.removeAttribute('aria-current');
                }
            });
            refs.mobileSelect.value = activeCategory;
        };

        const applySearch = () => {
            drawers = getSettingsTopDrawers(refs.content);
            query = normalizeSettingsSearchText(refs.searchInput?.value);
            if (query) {
                refs.content.setAttribute('data-search-active', 'true');
            } else {
                refs.content.removeAttribute('data-search-active');
            }
            refs.heading.textContent = query ? 'Search results' : getSettingsCategory(activeCategory).label;

            let matches = 0;
            for (const drawer of drawers) {
                const isMatch = !query || normalizeSettingsSearchText(drawer.textContent).includes(query);
                drawer.hidden = !isMatch;
                matches += Number(isMatch);
            }

            refs.resultCount.textContent = query ? `${matches} setting${matches === 1 ? '' : 's'} found` : '';
            refs.noResults.hidden = !query || matches > 0;
        };

        const revealTarget = target => {
            if (!(target instanceof HTMLElement) || !refs.content.contains(target)) {
                return;
            }

            const drawer = target.closest('.inline-drawer[data-settings-tab]');
            if (drawer?.dataset.settingsTab) {
                setCategory(drawer.dataset.settingsTab);
            }
            clearSettingsSearch(refs.searchInput);
            applySearch();
        };

        refs.nav.querySelectorAll('.sb-settings-tab-btn').forEach(button => {
            button.addEventListener('click', () => {
                clearSettingsSearch(refs.searchInput);
                setCategory(button.dataset.tab);
                applySearch();
            });
        });
        refs.mobileSelect.addEventListener('change', () => {
            clearSettingsSearch(refs.searchInput);
            setCategory(refs.mobileSelect.value);
            applySearch();
        });
        refs.content.addEventListener('sb:reveal-search-target', event => {
            revealTarget(event.detail?.target || event.target);
        });

        const refresh = () => {
            setCategory(activeCategory);
            applySearch();
        };

        refresh();
        return { refs, refresh, revealTarget };
    }

    function setupSearchIntegration(controller) {
        const searchInput = controller?.refs?.searchInput;
        if (!(searchInput instanceof HTMLInputElement || searchInput instanceof HTMLTextAreaElement)
            || searchInput.dataset.sbSettingsSearchBound === 'true') {
            return;
        }

        searchInput.dataset.sbSettingsSearchBound = 'true';
        const handleSearchChange = () => controller.refresh();
        searchInput.addEventListener('input', handleSearchChange);
        searchInput.addEventListener('change', handleSearchChange);
    }

    function watchForLateDrawers(controller) {
        const content = document.getElementById('user-settings-block-content');
        if (!content || typeof MutationObserver === 'undefined') return;

        let queued = 0;
        const observer = new MutationObserver(() => {
            if (queued) return;
            queued = requestAnimationFrame(() => {
                queued = 0;
                ensureStscriptDrawer();
                ensureSettingsHeaderIcons();
                tagDrawersWithCategories();
                tagUntaggedDrawers();
                controller?.refresh();
            });
        });

        observer.observe(content, { childList: true, subtree: true });
    }

    const extensionUnitSessionKeys = new WeakMap();
    let nextExtensionUnitSessionKey = 0;
    const extensionPinsStorageKey = 'NeconyanPinnedExtensions.v1';

    function readPinnedExtensionKeys() {
        try {
            const value = JSON.parse(accountStorage.getItem(extensionPinsStorageKey) || '[]');
            return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []);
        } catch {
            return new Set();
        }
    }

    function writePinnedExtensionKeys(keys) {
        accountStorage.setItem(extensionPinsStorageKey, JSON.stringify([...keys]));
    }

    function titleCaseExtensionId(value) {
        return String(value || '')
            .replace(/(?:[_-]?container)$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, character => character.toUpperCase())
            .trim();
    }

    function getExtensionUnitLabel(unit) {
        const explicitName = unit.dataset.extensionName?.trim();
        const header = unit.querySelector('.inline-drawer-header, summary');
        const headerLabel = header?.querySelector('[data-i18n]') || header?.querySelector('b, strong') || header;
        const candidate = unit.querySelector('.extension_name') || headerLabel
            || unit.querySelector('h3, h4, strong');
        const label = candidate?.textContent?.replace(/\s+/g, ' ').trim();
        const explicitLabel = explicitName && !/^(?:Neconyan|Silly(?:Bunny|Tavern))[-_]/i.test(explicitName) ? explicitName : '';
        return explicitLabel || label || titleCaseExtensionId(unit.getAttribute('data-extension-id') || unit.id) || 'Extension';
    }

    function getExtensionUnitId(unit) {
        const existingId = String(unit.id || '').trim();
        if (existingId) {
            return `id:${existingId}`;
        }

        if (!extensionUnitSessionKeys.has(unit)) {
            nextExtensionUnitSessionKey += 1;
            extensionUnitSessionKeys.set(unit, `session-${nextExtensionUnitSessionKey}`);
        }
        return extensionUnitSessionKeys.get(unit);
    }

    function getExtensionUnitSearchText(unit, name, id) {
        const attributeText = Array.from(unit.querySelectorAll('[title], [aria-label]'))
            .flatMap(element => [element.getAttribute('title'), element.getAttribute('aria-label')])
            .filter(Boolean)
            .join(' ');
        return normalizeSettingsSearchText([name, id, unit.textContent, unit.getAttribute('title'), attributeText].join(' '));
    }

    function getExtensionSettingsUnits(host) {
        if (!(host instanceof HTMLElement)) {
            return [];
        }

        return Array.from(host.children).filter(unit => (
            unit instanceof HTMLElement
            && !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK'].includes(unit.tagName)
            && (unit.children.length > 0 || Boolean(unit.textContent.trim()))
        ));
    }

    function normalizeExtensionLookup(value) {
        return String(value || '')
            .replace(/^id:/i, '')
            .replace(/^third-party[\\/]/i, '')
            .replace(/(?:[_-]?container)$/i, '')
            .replace(/[^a-z0-9]+/gi, '')
            .toLowerCase();
    }

    function getLiveThirdPartyExtensions() {
        const names = typeof extensionNames !== 'undefined' && Array.isArray(extensionNames) ? extensionNames : [];
        const seen = new Set();
        return names.flatMap(name => {
            const type = typeof getExtensionType === 'function' ? getExtensionType(name) : '';
            if (!['local', 'global'].includes(type)) {
                return [];
            }

            const extension = typeof findExtension === 'function' ? findExtension(name) : null;
            const canonicalName = extension?.name || name;
            const key = normalizeExtensionLookup(canonicalName);
            if (!key || seen.has(key)) {
                return [];
            }

            seen.add(key);
            const manifest = typeof getExtensionManifest === 'function' ? getExtensionManifest(canonicalName) || {} : {};
            const displayName = String(manifest.display_name || titleCaseExtensionId(canonicalName) || canonicalName).trim();
            return [{
                key: `third-party:${key}`,
                name: displayName,
                canonicalName,
                displayName,
                searchText: normalizeSettingsSearchText(`${displayName} ${canonicalName} ${manifest.description || ''}`),
            }];
        });
    }

    function getExtensionUnitCandidates(unit, name, id) {
        const data = unit?.dataset || {};
        return [
            data.extensionName,
            data.extensionId,
            unit?.getAttribute?.('data-extension-name'),
            unit?.getAttribute?.('data-extension-id'),
            name,
            id,
            unit?.id,
        ].filter(Boolean);
    }

    function normalizeIncludedToolLookup(value) {
        return normalizeExtensionLookup(value).replace(/^neconyan/, '');
    }

    function getNeconyanNativeToolDefinitions() {
        const definitions = globalThis.NeconyanNativeTools?.getDefinitions?.();
        return Array.isArray(definitions) ? definitions : [];
    }

    function getIncludedToolDefinition(info) {
        if (info?.scope !== 'built-in') {
            return null;
        }

        const candidates = [
            info.name,
            ...(info.units || []).flatMap(unit => getExtensionUnitCandidates(unit, info.name, getExtensionUnitId(unit))),
        ].map(normalizeIncludedToolLookup).filter(Boolean);

        return getNeconyanNativeToolDefinitions().find(definition => (
            [definition.id, definition.label].filter(Boolean)
                .map(normalizeIncludedToolLookup)
                .some(candidate => candidates.includes(candidate))
        )) || null;
    }

    function getVisibleExtensionGroups(groups, scope) {
        return groups.filter(info => info.scope === scope && !getIncludedToolDefinition(info));
    }

    function findExtensionGroupForLabel(groups, label) {
        const targetText = normalizeSettingsSearchText(label);
        if (!targetText) {
            return null;
        }
        const exact = groups.filter(info => normalizeSettingsSearchText(info.name) === targetText);
        const contains = groups.filter(info => info.searchText.includes(targetText));
        return exact.find(info => getIncludedToolDefinition(info))
            || exact[0]
            || contains.find(info => getIncludedToolDefinition(info))
            || contains[0]
            || null;
    }

    function findExtensionGroupForTarget(groups, target) {
        return groups.find(info => info.units.some(unit => unit === target || unit.contains?.(target))) || null;
    }

    function openIncludedToolSettings(info) {
        const definition = getIncludedToolDefinition(info);
        const opener = globalThis.NeconyanNativeTools?.openSettings;
        if (!definition || typeof opener !== 'function') {
            return false;
        }
        void opener(definition);
        return true;
    }

    function findExtensionForUnit(unit, name, id, thirdPartyExtensions) {
        const candidates = getExtensionUnitCandidates(unit, name, id).map(normalizeExtensionLookup).filter(Boolean);
        return thirdPartyExtensions.find(extension => candidates.includes(normalizeExtensionLookup(extension.canonicalName))
            || candidates.includes(normalizeExtensionLookup(extension.displayName))) || null;
    }

    function collectExtensionGroups(units, thirdPartyExtensions) {
        const groups = new Map();
        for (const unit of units) {
            const id = getExtensionUnitId(unit);
            const name = getExtensionUnitLabel(unit);
            const registryEntry = findExtensionForUnit(unit, name, id, thirdPartyExtensions);
            const normalizedName = normalizeExtensionLookup(name);
            const key = registryEntry?.key || `built-in:${normalizedName || id}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    key,
                    scope: registryEntry ? 'third-party' : 'built-in',
                    name: registryEntry?.displayName || name,
                    units: [],
                    searchText: normalizeSettingsSearchText([registryEntry?.searchText, name, id, unit.textContent].filter(Boolean).join(' ')),
                };
                groups.set(key, group);
            }
            group.units.push(unit);
            group.searchText = normalizeSettingsSearchText(`${group.searchText} ${getExtensionUnitSearchText(unit, name, id)}`);
        }

        for (const extension of thirdPartyExtensions) {
            if (!groups.has(extension.key)) {
                groups.set(extension.key, { ...extension, scope: 'third-party', units: [] });
            }
        }

        return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name));
    }

    function createExtensionsController(root, firstHost, secondHost) {
        if (!(root instanceof HTMLElement) || !(firstHost instanceof HTMLElement) || !(secondHost instanceof HTMLElement)) {
            return null;
        }

        const block = root.querySelector(':scope > .extensions_block') || root.querySelector('.extensions_block');
        if (!(block instanceof HTMLElement)) {
            return null;
        }

        const existingLayout = block.querySelector(':scope > .sb-extensions-layout');
        if (existingLayout instanceof HTMLElement) {
            return null;
        }

        const layout = document.createElement('div');
        layout.className = 'sb-extensions-layout';
        const master = markSearchIndexIgnored(document.createElement('aside'));
        master.className = 'sb-extensions-master';
        const masterHeading = document.createElement('h3');
        masterHeading.textContent = 'Extension settings';
        const scope = document.createElement('div');
        scope.className = 'sb-extensions-scope';
        scope.setAttribute('role', 'group');
        scope.setAttribute('aria-label', 'Extension settings scope');
        const scopeButtons = new Map();
        for (const [value, label] of [['third-party', 'Third-party'], ['built-in', 'Built-in']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sb-extensions-scope-button';
            button.dataset.extensionsScope = value;
            button.textContent = label;
            button.setAttribute('aria-pressed', String(value === 'third-party'));
            scopeButtons.set(value, button);
            scope.appendChild(button);
        }
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'text_pole sb-extensions-search';
        searchInput.placeholder = 'Find an extension';
        searchInput.setAttribute('aria-label', 'Find an extension');
        const mobileSelect = markSearchIndexIgnored(document.createElement('select'));
        mobileSelect.className = 'sb-extensions-select';
        mobileSelect.setAttribute('aria-label', 'Choose an extension');
        const mobilePin = document.createElement('button');
        mobilePin.type = 'button';
        mobilePin.className = 'sb-extension-pin sb-extension-mobile-pin';
        mobilePin.setAttribute('aria-label', 'Pin selected extension');
        const count = document.createElement('p');
        count.className = 'sb-extensions-count';
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        const list = markSearchIndexIgnored(document.createElement('div'));
        list.className = 'sb-extensions-list';
        const detail = document.createElement('section');
        detail.className = 'sb-extension-detail';
        const empty = document.createElement('p');
        empty.className = 'sb-extensions-empty';

        master.append(masterHeading, scope, searchInput, mobileSelect, mobilePin, count, list);
        layout.append(master, detail);
        block.insertBefore(layout, firstHost);
        detail.append(firstHost, secondHost, empty);

        const state = {
            refs: { root, firstHost, secondHost, searchInput, mobileSelect, list, count, detail, empty, scope, scopeButtons },
            units: [],
            groups: [],
            allGroups: [],
            scope: 'third-party',
            selectedKey: '',
            query: '',
            refresh: null,
            setScope: null,
            focusUnit: null,
            mountedUnits: new Set(),
            mountedOrigins: new Map(),
            mountedHost: null,
            mountedKey: '',
            pinnedKeys: new Set(),
        };

        const ensureUnitPin = (unit, info) => {
            const header = unit.querySelector('.inline-drawer-toggle');
            if (!(header instanceof HTMLElement)) return;
            let pin = header.querySelector(':scope > .sb-extension-unit-pin');
            if (!pin) {
                pin = document.createElement('button');
                pin.type = 'button';
                pin.className = 'sb-extension-pin sb-extension-unit-pin';
                pin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
                pin.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    const key = pin.dataset.extensionId;
                    if (state.pinnedKeys.has(key)) state.pinnedKeys.delete(key); else state.pinnedKeys.add(key);
                    writePinnedExtensionKeys(state.pinnedKeys);
                    refresh();
                });
                header.appendChild(pin);
            }
            const pinned = state.pinnedKeys.has(info.key);
            pin.dataset.extensionId = info.key;
            pin.setAttribute('aria-pressed', String(pinned));
            const label = `${pinned ? 'Unpin' : 'Pin'} ${info.name}`;
            pin.setAttribute('aria-label', label);
            pin.title = label;
        };

        const refresh = () => {
            const units = [...getExtensionSettingsUnits(firstHost), ...getExtensionSettingsUnits(secondHost), ...state.mountedUnits];
            state.pinnedKeys = readPinnedExtensionKeys();
            const thirdPartyExtensions = getLiveThirdPartyExtensions();
            state.allGroups = collectExtensionGroups(units, thirdPartyExtensions);
            state.allGroups.sort((left, right) => {
                const pinDelta = Number(state.pinnedKeys.has(right.key)) - Number(state.pinnedKeys.has(left.key));
                return pinDelta || left.name.localeCompare(right.name);
            });
            const mountedGroup = state.allGroups.find(info => info.key === state.mountedKey);
            if (state.mountedHost?.isConnected && mountedGroup) {
                for (const unit of mountedGroup.units) {
                    if (state.mountedUnits.has(unit)) continue;
                    state.mountedUnits.add(unit);
                    state.mountedOrigins.set(unit, { parent: unit.parentElement, next: unit.nextSibling });
                    state.mountedHost.appendChild(unit);
                }
            }
            const infos = getVisibleExtensionGroups(state.allGroups, state.scope);
            state.units = units;
            state.groups = infos;
            state.query = normalizeSettingsSearchText(searchInput.value);
            const filtered = state.query
                ? infos.filter(info => info.searchText.includes(state.query))
                : infos;
            const selected = filtered.find(info => info.key === state.selectedKey) || filtered[0] || null;
            state.selectedKey = selected?.key || '';

            const focusedControl = list.contains(document.activeElement) ? document.activeElement : null;
            const existingRows = new Map(Array.from(list.querySelectorAll('.sb-extension-master-row'), row => [row.dataset.extensionId, row]));
            const rows = filtered.map(info => {
                let row = existingRows.get(info.key);
                if (!row) {
                    row = document.createElement('div');
                    row.className = 'sb-extension-master-row';
                    const selection = document.createElement('button');
                    selection.type = 'button';
                    selection.className = 'sb-extension-master-item';
                    selection.addEventListener('click', () => {
                        selection.focus({ preventScroll: true });
                        state.selectedKey = selection.dataset.extensionId;
                        refresh();
                    });
                    const pin = document.createElement('button');
                    pin.type = 'button';
                    pin.className = 'sb-extension-pin';
                    pin.addEventListener('click', event => {
                        event.stopPropagation();
                        const key = pin.dataset.extensionId;
                        if (state.pinnedKeys.has(key)) state.pinnedKeys.delete(key); else state.pinnedKeys.add(key);
                        writePinnedExtensionKeys(state.pinnedKeys);
                        refresh();
                    });
                    row.append(selection, pin);
                }
                const selection = row.querySelector('.sb-extension-master-item');
                const pin = row.querySelector('.sb-extension-pin');
                row.dataset.extensionId = info.key;
                selection.dataset.extensionId = info.key;
                selection.dataset.extensionName = info.name;
                if (selection.textContent !== info.name) selection.textContent = info.name;
                selection.setAttribute('aria-current', String(info.key === state.selectedKey));
                pin.dataset.extensionId = info.key;
                pin.setAttribute('aria-pressed', String(state.pinnedKeys.has(info.key)));
                pin.setAttribute('aria-label', `${state.pinnedKeys.has(info.key) ? 'Unpin' : 'Pin'} ${info.name}`);
                pin.title = pin.getAttribute('aria-label');
                if (!pin.firstChild) pin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
                return row;
            });
            // Reuse rows and their selection/pin buttons so WebKit never loses a pointer target.
            if (rows.length !== list.children.length || rows.some((row, index) => list.children[index] !== row)) list.replaceChildren(...rows);
            mobileSelect.replaceChildren(...filtered.map(info => {
                const option = document.createElement('option');
                option.value = info.key;
                option.dataset.extensionId = info.key;
                option.dataset.extensionName = info.name;
                option.textContent = info.name;
                return option;
            }));
            mobileSelect.value = state.selectedKey;
            mobilePin.dataset.extensionId = state.selectedKey;
            const selectedPinned = state.pinnedKeys.has(state.selectedKey);
            mobilePin.disabled = !state.selectedKey;
            mobilePin.setAttribute('aria-pressed', String(selectedPinned));
            mobilePin.setAttribute('aria-label', state.selectedKey ? `${selectedPinned ? 'Unpin' : 'Pin'} selected extension` : 'Pin selected extension');
            mobilePin.title = mobilePin.getAttribute('aria-label');
            if (!mobilePin.firstChild) mobilePin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
            count.textContent = `${filtered.length} ${state.scope === 'third-party' ? 'third-party' : 'built-in'} extension${filtered.length === 1 ? '' : 's'}`;
            empty.textContent = infos.length && state.query && !selected
                ? 'No extensions match that search.'
                : state.scope === 'third-party' && !infos.length
                    ? 'No third-party extensions installed. Use Install extension to add one.'
                    : selected && !selected.units.length
                        ? `No settings are available for ${selected.name}.`
                        : 'No built-in extension settings are available.';

            // Every matching extension panel stays on one scrollable page at every width, pinned
            // groups first, as on phones. `order` sequences the stacked panels without moving
            // them out of their extension hosts.
            const shownUnits = new Set(filtered.flatMap(info => info.units));
            empty.hidden = shownUnits.size > 0;
            let panelOrder = 0;
            for (const info of filtered) {
                for (const unit of info.units) {
                    panelOrder += 1;
                    ensureUnitPin(unit, info);
                    if (!state.mountedUnits.has(unit)) unit.style.order = String(panelOrder);
                }
            }
            for (const unit of units) {
                unit.hidden = !state.mountedUnits.has(unit) && !shownUnits.has(unit);
            }
            root.dataset.extensionsScope = state.scope;
            for (const [value, button] of scopeButtons) {
                button.setAttribute('aria-pressed', String(value === state.scope));
            }

            if (focusedControl?.isConnected && document.activeElement !== focusedControl) focusedControl.focus({ preventScroll: true });
        };

        state.refresh = refresh;
        if (typeof window.matchMedia === 'function') {
            window.matchMedia('(max-width: 768px)').addEventListener?.('change', () => refresh());
        }
        state.setScope = (nextScope, { clearSearch = true } = {}) => {
            state.scope = nextScope === 'built-in' ? 'built-in' : 'third-party';
            if (clearSearch) {
                searchInput.value = '';
            }
            state.selectedKey = '';
            refresh();
        };
        state.focusUnit = label => {
            const included = findExtensionGroupForLabel(state.allGroups, label);
            if (openIncludedToolSettings(included)) {
                return true;
            }
            state.setScope('built-in');
            const target = findExtensionGroupForLabel(state.groups, label);
            if (!target) {
                searchInput.value = label;
                refresh();
                return false;
            }
            state.selectedKey = target.key;
            refresh();
            target.units.find(unit => unit.isConnected)?.scrollIntoView({ block: 'center' });
            return true;
        };
        for (const [value, button] of scopeButtons) {
            button.addEventListener('click', () => state.setScope(value));
        }
        searchInput.addEventListener('input', refresh);
        searchInput.addEventListener('change', refresh);
        mobileSelect.addEventListener('change', () => {
            state.selectedKey = mobileSelect.value;
            refresh();
        });
        mobilePin.addEventListener('click', event => {
            event.stopPropagation();
            if (!state.selectedKey) return;
            if (state.pinnedKeys.has(state.selectedKey)) state.pinnedKeys.delete(state.selectedKey); else state.pinnedKeys.add(state.selectedKey);
            writePinnedExtensionKeys(state.pinnedKeys);
            refresh();
        });
        root.addEventListener('sb:reveal-search-target', event => {
            const target = event.detail?.target || event.target;
            refresh();
            const owner = findExtensionGroupForTarget(state.allGroups, target);
            if (!owner) {
                return;
            }
            if (openIncludedToolSettings(owner)) {
                event.stopPropagation();
                return;
            }
            searchInput.value = '';
            state.scope = owner.scope;
            state.selectedKey = owner.key;
            refresh();
        });

        if (typeof MutationObserver !== 'undefined') {
            let queued = 0;
            const observer = new MutationObserver(() => {
                if (queued) return;
                queued = requestAnimationFrame(() => {
                    queued = 0;
                    refresh();
                });
            });
            observer.observe(firstHost, { childList: true, subtree: true });
            observer.observe(secondHost, { childList: true, subtree: true });
        }

        for (const eventName of [event_types?.APP_READY, event_types?.EXTENSION_SETTINGS_LOADED, event_types?.EXTENSION_DISABLED].filter(Boolean)) {
            eventSource?.on?.(eventName, refresh);
        }

        refresh();
        globalThis.NeconyanExtensions = {
            resetThirdParty: () => state.setScope('third-party'),
            focusUnit: label => state.focusUnit(label),
            mountUnit: (label, host, extensionId = label) => {
                if (!(host instanceof HTMLElement)) return false;
                const normalize = normalizeIncludedToolLookup;
                const target = state.allGroups.find(info => normalize(info.name) === normalize(label)
                    || info.units.some(unit => getExtensionUnitCandidates(unit, info.name, getExtensionUnitId(unit))
                        .some(candidate => normalize(candidate) === normalize(extensionId))));
                if (!target?.units?.length) return false;
                state.mountedHost = host;
                state.mountedKey = target.key;
                for (const unit of target.units) {
                    if (!state.mountedUnits.has(unit)) {
                        state.mountedUnits.add(unit);
                        state.mountedOrigins.set(unit, { parent: unit.parentElement, next: unit.nextSibling });
                    }
                    host.appendChild(unit);
                    unit.hidden = false;
                }
                refresh();
                return target.units[0];
            },
            restoreMountedUnits: () => {
                state.mountedHost = null;
                state.mountedKey = '';
                for (const unit of [...state.mountedUnits].reverse()) {
                    const origin = state.mountedOrigins.get(unit);
                    if (!(origin?.parent instanceof HTMLElement)) continue;
                    origin.parent.insertBefore(unit, origin.next?.parentNode === origin.parent ? origin.next : null);
                }
                state.mountedUnits.clear();
                state.mountedOrigins.clear();
                refresh();
            },
        };
        return state;
    }

    function initializeSettings() {
        const content = document.getElementById('user-settings-block-content');
        if (!(content instanceof HTMLElement) || content.children.length === 0 || settingsControllerState.controller) {
            return;
        }

        injectStyles();
        promoteNestedDrawers();
        ensureStscriptDrawer();
        ensureSettingsHeaderIcons();
        promoteCacheAccount();
        tagDrawersWithCategories();
        tagUntaggedDrawers();
        settingsControllerState.controller = createSettingsController(content);
        setupSearchIntegration(settingsControllerState.controller);
        watchForLateDrawers(settingsControllerState.controller);
    }

    function initializeExtensions() {
        const root = document.getElementById('rm_extensions_block');
        const firstHost = document.getElementById('extensions_settings');
        const secondHost = document.getElementById('extensions_settings2');
        if (!(root instanceof HTMLElement) || !(firstHost instanceof HTMLElement) || !(secondHost instanceof HTMLElement)
            || extensionsControllerState.controller) {
            return;
        }

        injectStyles();
        extensionsControllerState.controller = createExtensionsController(root, firstHost, secondHost);
    }

    function initialize() {
        try {
            initializeSettings();
            initializeExtensions();
        } catch (error) {
            console.error('[Neconyan Settings Tabs] Initialization failed:', error);
        }
    }

    const pollInterval = setInterval(() => {
        initialize();
        if (settingsControllerState.controller && extensionsControllerState.controller) {
            clearInterval(pollInterval);
        }
    }, 100);
})();
