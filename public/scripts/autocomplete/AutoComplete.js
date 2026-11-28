import { t } from '../i18n.js';
import { power_user } from '../power-user.js';
import { debounce, escapeRegex } from '../utils.js';
import { AutoCompleteOption } from './AutoCompleteOption.js';
import { AutoCompleteFuzzyScore } from './AutoCompleteFuzzyScore.js';
import { BlankAutoCompleteOption } from './BlankAutoCompleteOption.js';
import { AutoCompleteNameResult } from './AutoCompleteNameResult.js';
import { AutoCompleteSecondaryNameResult } from './AutoCompleteSecondaryNameResult.js';

/**@readonly*/
/**@enum {Number}*/
export const AUTOCOMPLETE_WIDTH = {
    'INPUT': 0,
    'CHAT': 1,
    'FULL': 2,
};

/**@readonly*/
/**@enum {Number}*/
export const AUTOCOMPLETE_SELECT_KEY = {
    'TAB': 1, // 2^0
    'ENTER': 2, // 2^1
};

/** @readonly */
/** @enum {Number} */
export const AUTOCOMPLETE_STATE = {
    DISABLED: 0,
    MIN_LENGTH: 1,
    ALWAYS: 2,
};

export class AutoComplete {
    /**@type {HTMLTextAreaElement|HTMLInputElement}*/ textarea;
    /**@type {boolean}*/ isFloating = false;
    /**@type {()=>boolean}*/ checkIfActivate;
    /**@type {(text:string, index:number) => Promise<AutoCompleteNameResult>}*/ getNameAt;

    /**@type {boolean}*/ isActive = false;
    /**@type {boolean}*/ isReplaceable = false;
    /**@type {boolean}*/ isShowingDetails = false;
    /**@type {boolean}*/ wasForced = false;
    /**@type {boolean}*/ isForceHidden = false;
    /**@type {boolean}*/ canBeAutoHidden = false;
    /**@type {boolean}*/ isNativeReplacing = false;
    /**@type {boolean}*/ isComposing = false;
    /**@type {boolean}*/ isApplyingCompletion = false;
    /**@type {number}*/ showRequest = 0;

    /**@type {string}*/ text;
    /**@type {AutoCompleteNameResult}*/ parserResult;
    /**@type {AutoCompleteSecondaryNameResult}*/ secondaryParserResult;
    get effectiveParserResult() { return this.secondaryParserResult ?? this.parserResult; }
    /**@type {string}*/ name;

    /**@type {boolean}*/ startQuote;
    /**@type {boolean}*/ endQuote;
    /**@type {number}*/ selectionStart;
    /**@type {number}*/ selectionEnd;

    /**@type {RegExp}*/ fuzzyRegex;

    /**@type {AutoCompleteOption[]}*/ result = [];
    /**@type {AutoCompleteOption}*/ selectedItem = null;

    /**@type {HTMLElement}*/ clone;
    /**@type {HTMLElement}*/ domWrap;
    /**@type {HTMLElement}*/ dom;
    /**@type {HTMLElement}*/ detailsWrap;
    /**@type {HTMLElement}*/ detailsDom;

    /**@type {function}*/ renderDebounced;
    /**@type {function}*/ renderDetailsDebounced;
    /**@type {function}*/ updatePositionDebounced;
    /**@type {function}*/ updateDetailsPositionDebounced;
    /**@type {function}*/ updateFloatingPositionDebounced;
    /**@type {() => void}*/ windowResizeHandler;

    /**@type {(item:AutoCompleteOption)=>any}*/ onSelect;

    get matchType() {
        return power_user.stscript.matching ?? 'fuzzy';
    }

    get autoHide() {
        return power_user.stscript.autocomplete.autoHide ?? false;
    }


    /**
     * @param {HTMLTextAreaElement|HTMLInputElement} textarea The textarea to receive autocomplete.
     * @param {() => boolean} checkIfActivate Function should return true only if under the current conditions, autocomplete should display (e.g., for slash commands: autoComplete.text[0] == '/')
     * @param {(text: string, index: number) => Promise<AutoCompleteNameResult>} getNameAt Function should return (unfiltered, matching against input is done in AutoComplete) information about name options at index in text.
     * @param {boolean} isFloating Whether autocomplete should float at the keyboard cursor.
     */
    constructor(textarea, checkIfActivate, getNameAt, isFloating = false) {
        this.textarea = textarea;
        this.checkIfActivate = checkIfActivate;
        this.getNameAt = getNameAt;
        this.isFloating = isFloating;

        this.domWrap = document.createElement('div'); {
            this.domWrap.classList.add('autoComplete-wrap');
            if (isFloating) this.domWrap.classList.add('isFloating');
        }
        this.headerDom = document.createElement('div'); {
            this.headerDom.classList.add('nn-ac-header');
            this.headerDom.setAttribute('role', 'toolbar');
            this.headerDom.setAttribute('aria-label', 'Autocomplete controls');
            this.headerDom.addEventListener('pointerdown', (evt) => evt.preventDefault());
            this.headerDom.addEventListener('mousedown', (evt) => evt.preventDefault());

            const title = document.createElement('span');
            title.classList.add('nn-ac-title');
            this.headerIconDom = document.createElement('i');
            this.headerIconDom.classList.add('fa-solid', 'fa-terminal', 'nn-ac-badge-icon');
            this.headerIconDom.setAttribute('aria-hidden', 'true');
            this.headerContextDom = document.createElement('span');
            this.headerContextDom.classList.add('nn-ac-context');
            this.headerContextDom.textContent = 'Slash commands';
            title.append(this.headerIconDom, this.headerContextDom);

            this.headerCountDom = document.createElement('span');
            this.headerCountDom.classList.add('nn-ac-count');
            this.headerCountDom.setAttribute('aria-live', 'polite');

            const hints = document.createElement('span');
            hints.classList.add('nn-ac-hints');
            hints.setAttribute('aria-hidden', 'true');
            for (const label of ['↑↓', 'Tab', 'Ctrl+Space']) {
                const key = document.createElement('kbd');
                key.textContent = label;
                hints.append(key);
            }

            this.detailsToggleBtn = document.createElement('button');
            this.detailsToggleBtn.type = 'button';
            this.detailsToggleBtn.classList.add('nn-ac-details-toggle');
            this.detailsToggleBtn.setAttribute('aria-label', 'Toggle command details');
            this.detailsToggleBtn.title = 'Toggle command details';
            this.detailsToggleBtn.setAttribute('aria-pressed', 'false');
            const toggleIcon = document.createElement('i');
            toggleIcon.classList.add('fa-solid', 'fa-circle-info');
            toggleIcon.setAttribute('aria-hidden', 'true');
            this.detailsToggleBtn.append(toggleIcon);
            this.bindNonBlurringAction(this.detailsToggleBtn, () => this.toggleDetails());

            const headingGroup = document.createElement('span');
            headingGroup.classList.add('nn-ac-header-left');
            headingGroup.append(title, this.headerCountDom);
            const controls = document.createElement('span');
            controls.classList.add('nn-ac-header-right');
            controls.append(hints, this.detailsToggleBtn);
            this.headerDom.append(headingGroup, controls);
            this.domWrap.append(this.headerDom);
        }
        this.dom = document.createElement('ul'); {
            this.dom.classList.add('autoComplete');
            this.domWrap.append(this.dom);
        }
        this.detailsWrap = document.createElement('div'); {
            this.detailsWrap.classList.add('autoComplete-detailsWrap');
            if (isFloating) this.detailsWrap.classList.add('isFloating');
        }
        this.detailsHeaderDom = document.createElement('div'); {
            this.detailsHeaderDom.classList.add('nn-ac-details-header');
            this.detailsHeaderDom.addEventListener('pointerdown', (evt) => evt.preventDefault());
            this.detailsHeaderDom.addEventListener('mousedown', (evt) => evt.preventDefault());

            const detailsTitle = document.createElement('span');
            detailsTitle.classList.add('nn-ac-details-title');
            const detailsIcon = document.createElement('i');
            detailsIcon.classList.add('fa-solid', 'fa-circle-info');
            detailsIcon.setAttribute('aria-hidden', 'true');
            this.detailsTitleTextDom = document.createElement('span');
            this.detailsTitleTextDom.classList.add('nn-ac-details-title-text');
            this.detailsTitleTextDom.textContent = 'Command details';
            detailsTitle.append(detailsIcon, this.detailsTitleTextDom);

            this.detailsCloseBtn = document.createElement('button');
            this.detailsCloseBtn.type = 'button';
            this.detailsCloseBtn.classList.add('nn-ac-details-close');
            this.detailsCloseBtn.setAttribute('aria-label', 'Close details');
            this.detailsCloseBtn.title = 'Close details';
            const closeIcon = document.createElement('i');
            closeIcon.classList.add('fa-solid', 'fa-xmark');
            closeIcon.setAttribute('aria-hidden', 'true');
            this.detailsCloseBtn.append(closeIcon);
            this.bindNonBlurringAction(this.detailsCloseBtn, () => this.closeDetails());

            this.detailsHeaderDom.append(detailsTitle, this.detailsCloseBtn);
            this.detailsWrap.append(this.detailsHeaderDom);
        }
        this.detailsDom = document.createElement('div'); {
            this.detailsDom.classList.add('autoComplete-details');
            this.detailsWrap.append(this.detailsDom);
        }

        this.renderDebounced = debounce(this.render.bind(this), 10);
        this.renderDetailsDebounced = debounce(this.renderDetails.bind(this), 10);
        this.updatePositionDebounced = debounce(this.updatePosition.bind(this), 10);
        this.updateDetailsPositionDebounced = debounce(this.updateDetailsPosition.bind(this), 10);
        this.updateFloatingPositionDebounced = debounce(this.updateFloatingPosition.bind(this), 10);

        textarea.addEventListener('beforeinput', (evt) => {
            this.selectionStart = this.textarea.selectionStart;
            this.selectionEnd = this.textarea.selectionEnd;
            this.isNativeReplacing = evt.inputType === 'insertReplacementText';
        });
        textarea.addEventListener('compositionstart', () => {
            this.isComposing = true;
        });
        textarea.addEventListener('compositionend', () => {
            this.isComposing = false;
            this.selectionStart = this.textarea.selectionStart;
            this.selectionEnd = this.textarea.selectionEnd;
        });
        textarea.addEventListener('input', (evt) => {
            this.selectionStart = this.textarea.selectionStart;
            this.selectionEnd = this.textarea.selectionEnd;

            if (this.isComposing || this.isNativeReplacing || this.isApplyingCompletion) {
                this.text = this.textarea.value;
                this.isNativeReplacing = false;
                return;
            }

            const allowedInputTypes = new Set([
                'insertText',
                'insertLineBreak',
                'deleteContentBackward',
                'deleteContentForward',
            ]);
            const shouldProcessInput = !evt.inputType || allowedInputTypes.has(evt.inputType);
            if (!shouldProcessInput) {
                this.text = this.textarea.value;
                return;
            }

            if (this.text != this.textarea.value) this.show(true, this.wasForced);
        });
        textarea.addEventListener('keydown', (evt) => this.handleKeyDown(evt));
        textarea.addEventListener('click', () => {
            this.selectionStart = this.textarea.selectionStart;
            this.selectionEnd = this.textarea.selectionEnd;
            if (this.isActive) this.show();
        });
        textarea.addEventListener('blur', () => this.hide());
        if (isFloating) {
            textarea.addEventListener('scroll', () => {
                if (this.isActive) {
                    this.updateFloatingPositionDebounced();
                }
            });
        }
        // Character/editor surfaces replace their textareas in place. Retire
        // the resize callback once its input leaves the document so viewport
        // changes cannot keep positioning a detached autocomplete forever.
        this.windowResizeHandler = () => {
            if (!this.getLayer()) {
                window.removeEventListener('resize', this.windowResizeHandler);
                window.visualViewport?.removeEventListener('resize', this.windowResizeHandler);
                window.visualViewport?.removeEventListener('scroll', this.windowResizeHandler);
                this.hide();
                return;
            }
            if (!this.isActive) {
                return;
            }
            this.updatePositionDebounced();
        };
        window.addEventListener('resize', this.windowResizeHandler);
        window.visualViewport?.addEventListener('resize', this.windowResizeHandler);
        window.visualViewport?.addEventListener('scroll', this.windowResizeHandler);
    }

    /**
     * Bind a click/tap action to a button without blurring the active textarea.
     * Handles mouse pointerdown, touch tap-without-drag, and programmatic click
     * without double-firing.
     * @param {HTMLButtonElement} button
     * @param {() => void} handler
     */
    bindNonBlurringAction(button, handler) {
        let handledByPointer = false;
        let pointerStart = null;
        button.addEventListener('pointerdown', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.pointerType === 'mouse') {
                handledByPointer = true;
                pointerStart = null;
                handler();
            } else {
                handledByPointer = false;
                pointerStart = { x: evt.clientX, y: evt.clientY };
            }
        });
        button.addEventListener('mousedown', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        });
        button.addEventListener('pointerup', (evt) => {
            if (!pointerStart) return;
            const moved = Math.hypot(evt.clientX - pointerStart.x, evt.clientY - pointerStart.y);
            pointerStart = null;
            if (moved <= 10) {
                evt.preventDefault();
                evt.stopPropagation();
                handledByPointer = true;
                handler();
            }
        });
        button.addEventListener('pointercancel', () => {
            pointerStart = null;
        });
        button.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (handledByPointer) {
                handledByPointer = false;
                return;
            }
            handler();
        });
    }

    /**
     * Get the bounding box of an autocomplete option row, supporting both
     * real block/flex/grid rows and upstream display: contents rows.
     * @param {AutoCompleteOption|null} item
     * @returns {DOMRect|null}
     */
    getItemRect(item) {
        const dom = item?.dom;
        if (!dom) return null;
        const rect = dom.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return rect;
        return dom.children[0]?.getBoundingClientRect() ?? rect;
    }

    /**
     * @returns {boolean} True when Neconyan's native shell styling (not Termeownal) is active.
     */
    isNeconyanLayout() {
        return Boolean(document.body?.classList.contains('neconyan') && !document.body?.classList.contains('sbterm'));
    }

    /**
     * Measure visualViewport-bounded viewport geometry.
     */
    getViewportMetrics() {
        const docW = document.documentElement?.clientWidth || window.innerWidth;
        const docH = document.documentElement?.clientHeight || window.innerHeight;
        const vv = window.visualViewport;
        const vpLeft = Math.max(0, vv ? vv.offsetLeft : 0);
        const vpTop = Math.max(0, vv ? vv.offsetTop : 0);
        const vpWidth = vv ? Math.min(vv.width, docW) : docW;
        const vpHeight = vv ? Math.min(vv.height, docH) : docH;
        const vpRight = Math.min(docW, vpLeft + vpWidth);
        const vpBottom = Math.min(docH, vpTop + vpHeight);
        return {
            docW,
            docH,
            vpLeft,
            vpTop,
            vpWidth,
            vpHeight,
            vpRight,
            vpBottom,
            isPhone: vpWidth <= 768,
        };
    }

    /**
     * Synchronise header context label, live match count, and details toggle state.
     */
    updateHeaderState() {
        if (!this.headerDom) return;
        const selectableItems = this.result.filter(it => it?.isSelectable !== false && !(it instanceof BlankAutoCompleteOption));
        const count = selectableItems.length;
        const isMacro = Boolean(this.domWrap.dataset.macrosAutocompleteStyle)
            || selectableItems.some(it => it?.dom?.classList?.contains('macro-ac-item'));

        let contextLabel = 'Slash commands';
        let detailsTitle = 'Command details';
        let iconClass = 'fa-terminal';
        if (isMacro) {
            contextLabel = 'Macros';
            detailsTitle = 'Macro details';
            iconClass = 'fa-code';
        } else if (count > 0 && selectableItems.every(it => it.type === 'namedArgument')) {
            contextLabel = 'Arguments';
            detailsTitle = 'Argument details';
        } else if (count > 0 && selectableItems.every(it => it.type === 'variable')) {
            contextLabel = 'Variables';
            detailsTitle = 'Variable details';
        } else if (count > 0 && selectableItems[0]?.type && selectableItems[0].type !== 'command' && selectableItems[0].type !== 'blank') {
            contextLabel = 'Options';
            detailsTitle = 'Option details';
        }

        if (this.headerContextDom) {
            this.headerContextDom.textContent = contextLabel;
        }
        if (this.headerIconDom) {
            this.headerIconDom.classList.toggle('fa-terminal', iconClass === 'fa-terminal');
            this.headerIconDom.classList.toggle('fa-code', iconClass === 'fa-code');
        }
        if (this.headerCountDom) {
            this.headerCountDom.textContent = count === 0
                ? t`No matches`
                : (count === 1 ? t`1 match` : t`${count} matches`);
        }
        if (this.detailsTitleTextDom) {
            this.detailsTitleTextDom.textContent = detailsTitle;
        }
        if (this.detailsToggleBtn) {
            const canToggle = count > 0 && Boolean(this.selectedItem) && this.isReplaceable;
            const active = canToggle && this.isShowingDetails;
            this.detailsToggleBtn.disabled = !canToggle;
            this.detailsToggleBtn.hidden = !canToggle;
            this.detailsToggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
            this.detailsToggleBtn.classList.toggle('is-active', active);
        }
    }

    /**
     * Dismiss the details panel without blurring the active textarea.
     */
    closeDetails() {
        this.isShowingDetails = false;
        if (!this.isReplaceable) {
            this.hide();
            return;
        }
        if (this.detailsWrap?.isConnected) {
            this.detailsWrap.remove();
        }
        this.updateHeaderState();
        this.updatePosition();
    }

    /**
     *
     * @param {AutoCompleteOption} option
     */
    makeItem(option) {
        const li = option.renderItem();
        let touchStart = null;
        const choose = (useNativeInsert) => {
            if (!this.result.includes(option)) return;
            this.selectedItem = option;
            this.select(useNativeInsert);
        };
        // Keep focus on the input, but let a touch scroll finish before choosing.
        li.addEventListener('pointerdown', (evt) => {
            if (evt.button !== 0) return;
            evt.preventDefault();
            if (evt.pointerType === 'mouse') choose(true);
            else touchStart = { id: evt.pointerId, x: evt.clientX, y: evt.clientY };
        });
        li.addEventListener('pointermove', (evt) => {
            if (touchStart && Math.hypot(evt.clientX - touchStart.x, evt.clientY - touchStart.y) > 10) touchStart = null;
        });
        li.addEventListener('pointercancel', () => { touchStart = null; });
        li.addEventListener('pointerup', (evt) => {
            if (touchStart?.id !== evt.pointerId) return;
            touchStart = null;
            evt.preventDefault();
            choose(false);
        });
        li.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        });
        return li;
    }


    /**
     *
     * @param {AutoCompleteOption} item
     */
    updateName(item) {
        const chars = Array.from(item.dom.querySelector('.name').children);
        if (item.forceFullNameMatch) {
            chars.forEach(c => c.classList.toggle('matched', true));
            return;
        }
        switch (this.matchType) {
            case 'strict': {
                chars.forEach((it, idx) => {
                    if (idx + item.nameOffset < item.name.length) {
                        it.classList.add('matched');
                    } else {
                        it.classList.remove('matched');
                    }
                });
                break;
            }
            case 'includes': {
                const start = item.name.toLowerCase().search(this.name);
                chars.forEach((it, idx) => {
                    if (idx + item.nameOffset < start) {
                        it.classList.remove('matched');
                    } else if (idx + item.nameOffset < start + item.name.length) {
                        it.classList.add('matched');
                    } else {
                        it.classList.remove('matched');
                    }
                });
                break;
            }
            case 'fuzzy': {
                item.name.replace(this.fuzzyRegex, (_, ...parts) => {
                    parts.splice(-2, 2);
                    if (parts.length == 2) {
                        chars.forEach(c => c.classList.remove('matched'));
                    } else {
                        let cIdx = item.nameOffset;
                        parts.forEach((it, idx) => {
                            if (it === null || it.length == 0) return '';
                            if (idx % 2 == 1) {
                                chars.slice(cIdx, cIdx + it.length).forEach(c => c.classList.add('matched'));
                            } else {
                                chars.slice(cIdx, cIdx + it.length).forEach(c => c.classList.remove('matched'));
                            }
                            cIdx += it.length;
                        });
                    }
                    return '';
                });
            }
        }
        return item;
    }

    /**
     * Calculate score for the fuzzy match.
     * @param {AutoCompleteOption} option
     * @returns The option.
     */
    fuzzyScore(option) {
        // might have been matched by the options matchProvider function instead
        if (!this.fuzzyRegex.test(option.name)) {
            option.score = new AutoCompleteFuzzyScore(Number.MAX_SAFE_INTEGER, -1);
            return option;
        }
        const parts = this.fuzzyRegex.exec(option.name).slice(1, -1);
        let start = null;
        let consecutive = [];
        let current = '';
        let offset = 0;
        parts.forEach((part, idx) => {
            if (idx % 2 == 0) {
                if (part.length > 0) {
                    if (current.length > 0) {
                        consecutive.push(current);
                    }
                    current = '';
                }
            } else {
                if (start === null) {
                    start = offset;
                }
                current += part;
            }
            offset += part.length;
        });
        if (current.length > 0) {
            consecutive.push(current);
        }
        consecutive.sort((a, b) => b.length - a.length);
        option.score = new AutoCompleteFuzzyScore(start, consecutive[0]?.length ?? 0);
        return option;
    }

    /**
     * Compare two auto complete options by their fuzzy score.
     * @param {AutoCompleteOption} a
     * @param {AutoCompleteOption} b
     */
    fuzzyScoreCompare(a, b) {
        if (a.score.start < b.score.start) return -1;
        if (a.score.start > b.score.start) return 1;
        if (a.score.longestConsecutive > b.score.longestConsecutive) return -1;
        if (a.score.longestConsecutive < b.score.longestConsecutive) return 1;
        return a.name.localeCompare(b.name);
    }

    basicAutoHideCheck() {
        // auto hide only if at least one char has been typed after the name + space
        return this.textarea.selectionStart > this.parserResult.start
            + this.parserResult.name.length
            + (this.startQuote ? 1 : 0)
            + (this.endQuote ? 1 : 0)
            + 1;
    }

    /**
     * Show the autocomplete.
     * @param {boolean} isInput Whether triggered by input.
     * @param {boolean} isForced Whether force-showing (ctrl+space).
     * @param {boolean} isSelect Whether an autocomplete option was just selected.
     */
    async show(isInput = false, isForced = false, isSelect = false) {
        const request = ++this.showRequest;
        //TODO check if isInput and isForced are both required
        this.text = this.textarea.value;
        this.selectionStart = this.textarea.selectionStart;
        this.selectionEnd = this.textarea.selectionEnd;
        this.isReplaceable = false;
        this.isShowForced = isForced; // Store forced state for checkIfActivate to access

        if (document.activeElement != this.textarea) {
            // only show with textarea in focus
            return this.hide();
        }
        if (!this.checkIfActivate()) {
            // only show if provider wants to
            return this.hide();
        }

        // disable force-hide if trigger was forced
        if (isForced) this.isForceHidden = false;

        // request provider to get name result (potentially "incomplete", i.e. not an actual existing name) for
        // cursor position
        const text = this.text;
        const cursor = this.selectionStart;
        const result = await this.getNameAt(text, cursor);
        if (request !== this.showRequest || text !== this.textarea.value
            || cursor !== this.textarea.selectionStart || document.activeElement !== this.textarea) return;
        this.parserResult = result;
        this.secondaryParserResult = null;

        if (!this.parserResult) {
            // don't show if no name result found, e.g., cursor's area is not a command
            return this.hide();
        }

        // need to know if name can be inside quotes, and then check if quotes are already there
        if (this.parserResult.canBeQuoted) {
            this.startQuote = this.text[this.parserResult.start] == '"';
            this.endQuote = this.startQuote && this.text[this.parserResult.start + this.parserResult.name.length + 1] == '"';
        } else {
            this.startQuote = false;
            this.endQuote = false;
        }

        // use lowercase name for matching
        this.name = this.parserResult.name.toLowerCase() ?? '';

        const isCursorInNamePart = this.textarea.selectionStart >= this.parserResult.start && this.textarea.selectionStart <= this.parserResult.start + this.parserResult.name.length + (this.startQuote ? 1 : 0);
        if (isForced || isInput || isSelect) {
            // if forced (ctrl+space) or user input or just selected an option...
            if (isCursorInNamePart) {
                // ...and cursor is somewhere in the name part (including right behind the final char)
                // -> show autocomplete for the (partial if cursor in the middle) name
                this.name = this.name.slice(0, this.textarea.selectionStart - (this.parserResult.start) - (this.startQuote ? 1 : 0));
                this.parserResult.name = this.name;
                this.isReplaceable = true;
                this.isForceHidden = false;
                this.canBeAutoHidden = false;
            } else {
                this.isReplaceable = false;
                this.canBeAutoHidden = this.basicAutoHideCheck();
            }
        } else {
            // if not forced and no user input -> just show details
            this.isReplaceable = false;
            this.canBeAutoHidden = this.basicAutoHideCheck();
        }

        if (isForced || isInput || isSelect) {
            // is forced or user input or just selected autocomplete option...
            if (!isCursorInNamePart) {
                // ...and cursor is not somwehere in the main name part -> check for secondary options (e.g., named arguments)
                const result = this.parserResult.getSecondaryNameAt(this.text, this.textarea.selectionStart, isSelect);
                if (result && (isForced || result.isRequired)) {
                    this.secondaryParserResult = result;
                    this.name = this.secondaryParserResult.name;
                    this.isReplaceable = isForced || this.secondaryParserResult.isRequired;
                    this.isForceHidden = false;
                    this.canBeAutoHidden = false;
                } else {
                    this.isReplaceable = false;
                    this.canBeAutoHidden = this.basicAutoHideCheck();
                }
            }
        }

        if (this.matchType == 'fuzzy') {
            // only build the fuzzy regex if match type is set to fuzzy
            this.fuzzyRegex = new RegExp(`^(.*?)${this.name.split('').map(char => `(${escapeRegex(char)})`).join('(.*?)')}(.*?)$`, 'i');
        }

        //TODO maybe move the matchers somewhere else; a single match function? matchType is available as property
        const matchers = {
            'strict': (name) => name.toLowerCase().startsWith(this.name),
            'includes': (name) => name.toLowerCase().includes(this.name),
            'fuzzy': (name) => this.fuzzyRegex.test(name),
        };

        this.result = this.effectiveParserResult.optionList
            // filter the list of options by the partial name according to the matching type
            .filter(it => this.isReplaceable || it.name == '' ? (it.matchProvider ? it.matchProvider(this.name) : matchers[this.matchType](it.name)) : it.name.toLowerCase() == this.name)
            // remove aliases
            .filter((it, idx, list) => list.findIndex(opt => opt.value == it.value) == idx);

        if (this.result.length == 0 && this.effectiveParserResult != this.parserResult && isForced) {
            // no matching secondary results and forced trigger -> show current command details
            this.secondaryParserResult = null;
            this.result = [this.effectiveParserResult.optionList.find(it => it.name == this.effectiveParserResult.name)];
            this.name = this.effectiveParserResult.name;
            this.fuzzyRegex = /(.*)(.*)(.*)/;
        }

        this.result = this.result
            // update remaining options
            .map(option => {
                // build element
                option.dom = this.makeItem(option);
                // update replacer and add quotes if necessary
                const optionName = option.valueProvider ? option.valueProvider(this.name) : option.name;
                if (this.effectiveParserResult.canBeQuoted) {
                    option.replacer = optionName.includes(' ') || this.startQuote || this.endQuote ? `"${optionName.replace(/"/g, '\\"')}"` : `${optionName}`;
                } else {
                    option.replacer = optionName;
                }
                // calculate fuzzy score if matching is fuzzy
                if (this.matchType == 'fuzzy') this.fuzzyScore(option);
                // update the name to highlight the matched chars
                this.updateName(option);
                return option;
            })
            // sort by priority first, then by fuzzy score or alphabetical
            .toSorted((a, b) => {
                // First compare by sortPriority (lower = higher priority)
                const priorityA = a.sortPriority ?? 100;
                const priorityB = b.sortPriority ?? 100;
                if (priorityA !== priorityB) {
                    return priorityA - priorityB;
                }
                // Then by fuzzy score or alphabetical
                if (this.matchType == 'fuzzy') {
                    return this.fuzzyScoreCompare(a, b);
                }
                return a.name.localeCompare(b.name);
            });


        if (this.isForceHidden) {
            // hidden with escape
            return this.hide();
        }
        if (this.autoHide && this.canBeAutoHidden && !isForced && this.effectiveParserResult == this.parserResult && this.result.length == 1) {
            // auto hide user setting enabled and somewhere after name part and would usually show command details
            return this.hide();
        }
        if (this.result.length == 0) {
            if (!isInput) {
                // no result and no input? hide autocomplete
                return this.hide();
            }
            if (this.effectiveParserResult instanceof AutoCompleteSecondaryNameResult && !this.effectiveParserResult.forceMatch) {
                // no result and matching is no forced? hide autocomplete
                return this.hide();
            }
            // otherwise add "no match" notice
            const option = new BlankAutoCompleteOption(
                this.name.length ?
                    this.effectiveParserResult.makeNoMatchText()
                    : this.effectiveParserResult.makeNoOptionsText()
                ,
            );
            this.result.push(option);
        } else if (this.result.length == 1 && this.effectiveParserResult && this.effectiveParserResult != this.secondaryParserResult && this.result[0].name == this.effectiveParserResult.name) {
            // only one result that is exactly the current value? just show hint, no autocomplete
            this.isReplaceable = false;
            this.isShowingDetails = false;
        } else if (!this.isReplaceable && this.result.length > 1) {
            return this.hide();
        }
        this.selectedItem = this.selectDefaultItem(this.result);
        this.isActive = true;
        this.wasForced = isForced;
        this.renderDebounced();
    }

    /**
     * Hide autocomplete.
     */
    hide() {
        this.showRequest++;
        if (this.domWrap?.isConnected) {
            this.domWrap.remove();
        }
        if (this.detailsWrap?.isConnected) {
            this.detailsWrap.remove();
        }
        this.isActive = false;
        this.isShowingDetails = false;
        this.wasForced = false;
        this.updateHeaderState();
    }


    /**
     * Create updated DOM.
     */
    render() {
        if (!this.isActive) return this.domWrap.remove();
        const layer = this.getLayer();
        if (!layer) return this.hide();
        this.updateHeaderState();
        if (this.isReplaceable) {
            this.dom.innerHTML = '';
            const frag = document.createDocumentFragment();
            for (const item of this.result) {
                if (item == this.selectedItem) {
                    item.dom.classList.add('selected');
                } else {
                    item.dom.classList.remove('selected');
                }
                if (!item.isSelectable) {
                    item.dom.classList.add('not-selectable');
                }
                frag.append(item.dom);
            }
            this.dom.append(frag);
            if (this.domWrap.parentElement !== layer) {
                layer.append(this.domWrap);
            }
            this.updatePosition();
        } else {
            this.domWrap.remove();
        }
        this.renderDetailsDebounced();
    }

    /**
     * Create updated DOM for details.
     */
    renderDetails() {
        if (!this.isActive) return this.detailsWrap.remove();
        if (!this.isShowingDetails && this.isReplaceable) {
            this.detailsWrap.remove();
            this.updateHeaderState();
            return;
        }
        const layer = this.getLayer();
        if (!layer) return this.hide();
        this.detailsDom.innerHTML = '';
        this.detailsDom.append(this.selectedItem?.renderDetails() ?? 'NO ITEM');
        if (this.detailsWrap.parentElement !== layer) {
            layer.append(this.detailsWrap);
        }
        this.updateHeaderState();
        this.updateDetailsPosition(layer);
    }

    /**
     * @returns {HTMLElement|null} closest ancestor dialog or body
     */
    getLayer() {
        return this.textarea?.isConnected ? this.textarea.closest('dialog, body') : null;
    }

    /**
     * Compute viewport-clamped non-floating Neconyan geometry for autocomplete list and details.
     * @param {HTMLElement} layer
     */
    computeNeconyanGeometry(layer) {
        const metrics = this.getViewportMetrics();
        const gutter = 8;
        const gap = 8;
        const inputRect = this.textarea.getBoundingClientRect();
        const sheldRect = document.querySelector('#sheld')?.getBoundingClientRect() ?? inputRect;
        const formRect = this.textarea.closest('#send_form')?.getBoundingClientRect() ?? null;
        const layerRect = layer === document.body
            ? { left: 0, top: 0, right: metrics.docW, bottom: metrics.docH, width: metrics.docW, height: metrics.docH }
            : layer.getBoundingClientRect();

        const anchorTop = formRect ? Math.min(inputRect.top, formRect.top) : inputRect.top;
        const popupBottom = Math.min(metrics.vpBottom - gutter, anchorTop - gap);
        const availH = Math.max(0, Math.floor(popupBottom - metrics.vpTop - gutter));

        const relLeft = (x) => Math.round(x - layerRect.left);
        const relRight = (x) => Math.round(layerRect.right - x);
        const relBottom = (y) => Math.ceil(layerRect.bottom - y);

        const minLeft = metrics.vpLeft + gutter;
        const maxRight = metrics.vpRight - gutter;

        // If two panels cannot fit, the details card takes the list's place until closed.
        const short = availH < 236;
        const showBoth = this.isShowingDetails && this.isReplaceable;
        const switchToDetails = showBoth && short;
        if (metrics.isPhone || short) {
            const showingStacked = showBoth && !short;
            const wrapMaxH = showingStacked
                ? Math.min(220, Math.floor((availH - gap) * 0.4))
                : Math.min(360, availH);
            return {
                gap,
                showingStacked,
                switchToDetails,
                popupBottom,
                availH,
                listLeft: minLeft,
                listRight: maxRight,
                detailsLeft: minLeft,
                detailsRight: maxRight,
                wrapMaxH,
                relLeft,
                relRight,
                relBottom,
            };
        }

        const rectMap = {};
        rectMap[AUTOCOMPLETE_WIDTH.INPUT] = inputRect;
        rectMap[AUTOCOMPLETE_WIDTH.CHAT] = sheldRect;
        rectMap[AUTOCOMPLETE_WIDTH.FULL] = { left: minLeft, right: maxRight };

        const prefLeft = power_user.stscript.autocomplete.width.left ?? AUTOCOMPLETE_WIDTH.CHAT;
        const prefRight = power_user.stscript.autocomplete.width.right ?? AUTOCOMPLETE_WIDTH.CHAT;
        const rawLeft = (rectMap[prefLeft] ?? sheldRect).left;
        const rawRight = (rectMap[prefRight] ?? sheldRect).right;

        let listLeft = Math.max(minLeft, Math.min(rawLeft, maxRight - 300));
        let listRight = Math.min(maxRight, Math.max(rawRight, listLeft + 300));
        let detailsLeft = listLeft;
        let detailsRight = listRight;

        if (this.isShowingDetails && this.isReplaceable) {
            const rightBound = Math.min(maxRight, Math.max(listRight, listLeft + 860));
            if (rightBound - listLeft < 620) {
                listLeft = Math.max(minLeft, rightBound - 620);
            }
            const span = Math.max(580, rightBound - listLeft);
            const detailsW = Math.min(430, Math.max(280, Math.round((span - gap) * 0.42)));
            listRight = Math.max(listLeft + 280, rightBound - detailsW - gap);
            detailsLeft = listRight + gap;
            detailsRight = rightBound;
        } else if (!this.isReplaceable) {
            detailsLeft = listLeft;
            detailsRight = Math.min(maxRight, Math.max(listRight, listLeft + 520));
        }

        return {
            gap,
            showingStacked: false,
            switchToDetails,
            popupBottom,
            availH,
            listLeft,
            listRight,
            detailsLeft,
            detailsRight,
            wrapMaxH: Math.min(440, availH),
            relLeft,
            relRight,
            relBottom,
        };
    }


    /**
     * Update position of DOM.
     */
    updatePosition() {
        if (!this.isActive) {
            return;
        }
        const layer = this.getLayer();
        if (!layer) {
            return this.hide();
        }
        if (this.isFloating) {
            this.updateFloatingPosition(layer);
        } else if (this.isNeconyanLayout()) {
            const geo = this.computeNeconyanGeometry(layer);
            const bottomVal = `${geo.relBottom(geo.popupBottom)}px`;
            this.domWrap.classList.toggle('nn-ac-layout-hidden', geo.switchToDetails || geo.availH < 64);
            this.domWrap.style.setProperty('--bottom', bottomVal);
            this.dom.style.setProperty('--bottom', bottomVal);
            this.domWrap.style.bottom = bottomVal;
            this.domWrap.style.setProperty('--leftOffset', `${geo.relLeft(geo.listLeft)}px`);
            this.domWrap.style.setProperty('--rightOffset', `${geo.relRight(geo.listRight)}px`);
            this.domWrap.style.setProperty('--nn-ac-wrap-max-h', `${geo.wrapMaxH}px`);
        } else {
            const rect = {};
            rect[AUTOCOMPLETE_WIDTH.INPUT] = this.textarea.getBoundingClientRect();
            rect[AUTOCOMPLETE_WIDTH.CHAT] = document.querySelector('#sheld')?.getBoundingClientRect() ?? rect[AUTOCOMPLETE_WIDTH.INPUT];
            rect[AUTOCOMPLETE_WIDTH.FULL] = layer.getBoundingClientRect();
            this.domWrap.style.setProperty('--bottom', `${window.innerHeight - rect[AUTOCOMPLETE_WIDTH.INPUT].top}px`);
            this.dom.style.setProperty('--bottom', `${window.innerHeight - rect[AUTOCOMPLETE_WIDTH.INPUT].top}px`);
            this.domWrap.style.bottom = `${window.innerHeight - rect[AUTOCOMPLETE_WIDTH.INPUT].top}px`;
            if (this.isShowingDetails) {
                this.domWrap.style.setProperty('--leftOffset', `max(1vw, ${rect[power_user.stscript.autocomplete.width.left].left}px)`);
                this.domWrap.style.setProperty('--rightOffset', `calc(100vw - min(${rect[power_user.stscript.autocomplete.width.right].right}px, ${this.isShowingDetails ? 74 : 99}vw))`);
            } else {
                this.domWrap.style.setProperty('--leftOffset', `max(1vw, ${rect[power_user.stscript.autocomplete.width.left].left}px)`);
                this.domWrap.style.setProperty('--rightOffset', `calc(100vw - min(99vw, ${rect[power_user.stscript.autocomplete.width.right].right}px))`);
            }
        }
        this.updateDetailsPosition(layer);
    }

    /**
     * Update position of details DOM.
     */
    updateDetailsPosition(layer = this.getLayer()) {
        if (!this.isActive) {
            return;
        }
        if (!layer) {
            return this.hide();
        }
        if (this.isShowingDetails || !this.isReplaceable) {
            if (this.isFloating) {
                this.updateFloatingDetailsPosition(null, layer);
            } else if (this.isNeconyanLayout()) {
                const geo = this.computeNeconyanGeometry(layer);
                const stackSpace = geo.showingStacked ? Math.ceil(this.domWrap.getBoundingClientRect().height) + geo.gap : 0;
                this.detailsWrap.classList.toggle('full', !this.isReplaceable);
                this.detailsWrap.classList.toggle('nn-ac-layout-hidden', geo.availH < 64);
                this.detailsWrap.style.setProperty('--leftOffset', `${geo.relLeft(geo.detailsLeft)}px`);
                this.detailsWrap.style.setProperty('--rightOffset', `${geo.relRight(geo.detailsRight)}px`);
                this.detailsWrap.style.setProperty('--bottomOffset', `${geo.relBottom(geo.popupBottom - stackSpace)}px`);
                this.detailsWrap.style.setProperty('--nn-ac-details-max-h', `${Math.min(480, geo.availH - stackSpace)}px`);
            } else {
                const rect = {};
                rect[AUTOCOMPLETE_WIDTH.INPUT] = this.textarea.getBoundingClientRect();
                rect[AUTOCOMPLETE_WIDTH.CHAT] = document.querySelector('#sheld')?.getBoundingClientRect() ?? rect[AUTOCOMPLETE_WIDTH.INPUT];
                rect[AUTOCOMPLETE_WIDTH.FULL] = layer.getBoundingClientRect();
                if (this.isReplaceable) {
                    this.detailsWrap.classList.remove('full');
                    const selRect = this.getItemRect(this.selectedItem);
                    this.detailsWrap.style.setProperty('--targetOffset', `${selRect ? selRect.top : rect[AUTOCOMPLETE_WIDTH.INPUT].top}`);
                    this.detailsWrap.style.setProperty('--rightOffset', '1vw');
                    this.detailsWrap.style.setProperty('--bottomOffset', `calc(100vh - ${rect[AUTOCOMPLETE_WIDTH.INPUT].top}px)`);
                    this.detailsWrap.style.setProperty('--leftOffset', `calc(100vw - ${this.domWrap.style.getPropertyValue('--rightOffset')})`);
                } else {
                    this.detailsWrap.classList.add('full');
                    this.detailsWrap.style.setProperty('--targetOffset', `${rect[AUTOCOMPLETE_WIDTH.INPUT].top}`);
                    this.detailsWrap.style.setProperty('--bottomOffset', `calc(100vh - ${rect[AUTOCOMPLETE_WIDTH.INPUT].top}px)`);
                    this.detailsWrap.style.setProperty('--leftOffset', `${rect[power_user.stscript.autocomplete.width.left].left}px`);
                    this.detailsWrap.style.setProperty('--rightOffset', `calc(100vw - ${rect[power_user.stscript.autocomplete.width.right].right}px)`);
                }
            }
        }
    }


    /**
     * Update position of floating autocomplete.
     */
    updateFloatingPosition(layer = this.getLayer()) {
        if (!layer) {
            return this.hide();
        }
        const location = this.getCursorPosition();
        const rect = this.textarea.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        // cursor is out of view -> hide
        if (location.bottom < rect.top || location.top > rect.bottom || location.left < rect.left || location.left > rect.right) {
            return this.hide();
        }
        const left = Math.max(rect.left, location.left) - layerRect.left;
        this.domWrap.style.setProperty('--targetOffset', `${left}`);
        if (location.top <= window.innerHeight / 2) {
            // if cursor is in lower half of window, show list above line
            this.domWrap.style.top = `${location.bottom - layerRect.top}px`;
            this.domWrap.style.bottom = 'auto';
            this.domWrap.style.maxHeight = `calc(${location.bottom - layerRect.top}px - ${this.textarea.closest('dialog') ? '0' : '1vh'})`;
        } else {
            // if cursor is in upper half of window, show list below line
            this.domWrap.style.top = 'auto';
            this.domWrap.style.bottom = `calc(${layerRect.height}px - ${location.top - layerRect.top}px)`;
            this.domWrap.style.maxHeight = `calc(${location.top - layerRect.top}px - ${this.textarea.closest('dialog') ? '0' : '1vh'})`;
        }
    }

    updateFloatingDetailsPosition(location = null, layer = this.getLayer()) {
        if (!layer) {
            return this.hide();
        }
        if (!location) location = this.getCursorPosition();
        const rect = this.textarea.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        if (location.bottom < rect.top || location.top > rect.bottom || location.left < rect.left || location.left > rect.right) {
            return this.hide();
        }
        let left = Math.max(rect.left, location.left) - layerRect.left;

        // Check if the autocomplete list is constrained by the right edge of the viewport.
        // If so, adjust the details panel position to align with the actual list position.
        // Only do this when the list is actually visible (isReplaceable).
        if (this.isReplaceable) {
            const listRect = this.dom.getBoundingClientRect();
            const listActualLeft = listRect.left - layerRect.left;
            const isConstrainedRight = listActualLeft < left - 5; // 5px tolerance

            if (isConstrainedRight) {
                // Use the actual list position instead of cursor position
                left = listActualLeft;
            }
        }

        this.detailsWrap.style.setProperty('--targetOffset', `${left}`);
        if (this.isReplaceable) {
            this.detailsWrap.classList.remove('full');
            if (left < window.innerWidth / 4) {
                // if cursor is in left part of screen, show details on right of list
                this.detailsWrap.classList.add('right');
                this.detailsWrap.classList.remove('left');
            } else {
                // if cursor is in right part of screen, show details on left of list
                this.detailsWrap.classList.remove('right');
                this.detailsWrap.classList.add('left');
            }
        } else {
            this.detailsWrap.classList.remove('left');
            this.detailsWrap.classList.remove('right');
            this.detailsWrap.classList.add('full');
        }
        if (location.top <= window.innerHeight / 2) {
            // if cursor is in lower half of window, show list above line
            this.detailsWrap.style.top = `${location.bottom - layerRect.top}px`;
            this.detailsWrap.style.bottom = 'auto';
            this.detailsWrap.style.maxHeight = `calc(${location.bottom - layerRect.top}px - ${this.textarea.closest('dialog') ? '0' : '1vh'})`;
        } else {
            // if cursor is in upper half of window, show list below line
            this.detailsWrap.style.top = 'auto';
            this.detailsWrap.style.bottom = `calc(${layerRect.height}px - ${location.top - layerRect.top}px)`;
            this.detailsWrap.style.maxHeight = `calc(${location.top - layerRect.top}px - ${this.textarea.closest('dialog') ? '0' : '1vh'})`;
        }
    }

    /**
     * Calculate (keyboard) cursor coordinates within textarea.
     * @returns {{left:number, top:number, bottom:number}}
     */
    getCursorPosition() {
        const inputRect = this.textarea.getBoundingClientRect();
        const style = window.getComputedStyle(this.textarea);
        if (!this.clone) {
            this.clone = document.createElement('div');
            for (const key of style) {
                this.clone.style[key] = style[key];
            }
            this.clone.style.position = 'fixed';
            this.clone.style.visibility = 'hidden';
            document.body.append(this.clone);
            const mo = new MutationObserver(muts => {
                if (muts.find(it => Array.from(it.removedNodes).includes(this.textarea))) {
                    this.clone.remove();
                }
            });
            mo.observe(this.textarea.parentElement, { childList: true });
        }
        this.clone.style.height = `${inputRect.height}px`;
        this.clone.style.left = `${inputRect.left}px`;
        this.clone.style.top = `${inputRect.top}px`;
        this.clone.style.whiteSpace = style.whiteSpace;
        this.clone.style.tabSize = style.tabSize;
        const text = this.textarea.value;
        const before = text.slice(0, this.textarea.selectionStart);
        this.clone.textContent = before;
        const locator = document.createElement('span');
        locator.textContent = text[this.textarea.selectionStart];
        this.clone.append(locator);
        this.clone.append(text.slice(this.textarea.selectionStart + 1));
        this.clone.scrollTop = this.textarea.scrollTop;
        this.clone.scrollLeft = this.textarea.scrollLeft;
        const locatorRect = locator.getBoundingClientRect();
        const location = {
            left: locatorRect.left,
            top: locatorRect.top,
            bottom: locatorRect.bottom,
        };
        return location;
    }


    /**
     * Toggle details view alongside autocomplete list.
     */
    toggleDetails() {
        this.isShowingDetails = !this.isShowingDetails;
        this.updateHeaderState();
        this.updatePosition();
        this.renderDetails();
    }


    /**
     * Select an item for autocomplete and put text into textarea.
     */
    async select(useNativeInsert = true) {
        if (this.textarea.value !== this.text || !this.selectedItem?.isSelectable) {
            this.hide();
            return;
        }
        let didUseNativeInsert = false;
        if (this.isReplaceable && this.selectedItem.value !== null) {
            // Apply per-option replacement offset (e.g., for closing tags that need to replace leading whitespace)
            const effectiveStart = this.effectiveParserResult.start + (this.selectedItem.replacementStartOffset ?? 0);
            const replaceEnd = this.effectiveParserResult.start + this.effectiveParserResult.name.length + (this.startQuote ? 1 : 0) + (this.endQuote ? 1 : 0);
            const replacementText = this.selectedItem.replacer;
            const nextCursor = effectiveStart + replacementText.length;
            const originalText = this.textarea.value;
            const expectedText = `${originalText.slice(0, effectiveStart)}${replacementText}${originalText.slice(replaceEnd)}`;
            const supportsExecCommand = useNativeInsert && !this.isNativeReplacing && !this.isComposing && typeof document.execCommand === 'function';
            if (!Number.isInteger(effectiveStart) || !Number.isInteger(replaceEnd)
                || effectiveStart < 0 || replaceEnd < effectiveStart || replaceEnd > originalText.length) return;

            this.textarea.focus({ preventScroll: true });
            this.textarea.setSelectionRange(effectiveStart, replaceEnd);

            this.isApplyingCompletion = true;
            try {
                if (supportsExecCommand) {
                    didUseNativeInsert = document.execCommand('insertText', false, replacementText)
                        && this.textarea.value === expectedText;
                }
            } catch {
                // Some mobile browsers reject native insertion while settling focus.
            } finally {
                this.isApplyingCompletion = false;
            }
            // Native insertion can report success after replacing the wrong range.
            // Always recover from the snapshot, never from an input listener's state.
            if (!didUseNativeInsert) this.textarea.value = expectedText;
            this.text = this.textarea.value;

            this.textarea.selectionStart = nextCursor;
            this.textarea.selectionEnd = nextCursor;
            this.show(false, false, true);
        } else {
            const selectionStart = this.textarea.selectionStart;
            const selectionEnd = this.textarea.selectionDirection;
            this.textarea.selectionStart = selectionStart;
            this.textarea.selectionDirection = selectionEnd;
        }
        this.wasForced = false;
        if (!didUseNativeInsert) {
            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        this.onSelect?.(this.selectedItem);
    }


    /**
     * Select the default item for the autocomplete list.
     * Selects the first selectable item if any is present, or falls back to the last item.
     * (To preserve context of where we are with multiple non-selectable options, if they are present for info)
     * @param {AutoCompleteOption[]} result The list of autocomplete options.
     * @returns {AutoCompleteOption} The item to select.
     */
    selectDefaultItem(result) {
        if (result.length === 0) return null;

        // Find first selectable item
        const firstSelectable = result.find(it => it.isSelectable);
        if (firstSelectable) return firstSelectable;

        // Fall back to last item
        return result[result.length - 1];
    }

    /**
     * Mark the item at newIdx in the autocomplete list as selected.
     * @param {number} newIdx
     */
    selectItemAtIndex(newIdx) {
        if (!this.result[newIdx]?.dom) return;
        this.selectedItem?.dom?.classList.remove('selected');
        this.selectedItem = this.result[newIdx];
        this.selectedItem.dom.classList.add('selected');
        const rect = this.getItemRect(this.selectedItem);
        const rectParent = this.dom.getBoundingClientRect();
        if (rect && (rect.top < rectParent.top || rect.bottom > rectParent.bottom)) {
            this.dom.scrollTop += rect.top < rectParent.top ? rect.top - rectParent.top : rect.bottom - rectParent.bottom;
        }
        this.renderDetailsDebounced();
    }

    /**
     * Handle keyboard events.
     * @param {KeyboardEvent} evt The event.
     */
    async handleKeyDown(evt) {
        // autocomplete is shown and cursor at end of current command name (or inside name and typed or forced)
        if (this.isActive && this.isReplaceable) {
            // actions in the list
            switch (evt.key) {
                case 'ArrowUp': {
                    // select previous item
                    if (evt.ctrlKey || evt.altKey || evt.shiftKey) return;
                    evt.preventDefault();
                    evt.stopPropagation();
                    const idx = this.result.indexOf(this.selectedItem);
                    let newIdx;
                    if (idx == 0) newIdx = this.result.length - 1;
                    else newIdx = idx - 1;
                    this.selectItemAtIndex(newIdx);
                    return;
                }
                case 'ArrowDown': {
                    // select next item
                    if (evt.ctrlKey || evt.altKey || evt.shiftKey) return;
                    evt.preventDefault();
                    evt.stopPropagation();
                    const idx = this.result.indexOf(this.selectedItem);
                    const newIdx = (idx + 1) % this.result.length;
                    this.selectItemAtIndex(newIdx);
                    return;
                }
                case 'Enter': {
                    // pick the selected item to autocomplete
                    if ((power_user.stscript.autocomplete.select & AUTOCOMPLETE_SELECT_KEY.ENTER) != AUTOCOMPLETE_SELECT_KEY.ENTER) break;
                    if (evt.ctrlKey || evt.altKey || evt.shiftKey || this.selectedItem.value == '') break;
                    if (this.selectedItem.name == this.name) break;
                    if (!this.selectedItem.isSelectable) break;
                    evt.preventDefault();
                    evt.stopImmediatePropagation();
                    this.select();
                    return;
                }
                case 'Tab': {
                    // pick the selected item to autocomplete
                    if ((power_user.stscript.autocomplete.select & AUTOCOMPLETE_SELECT_KEY.TAB) != AUTOCOMPLETE_SELECT_KEY.TAB) break;
                    if (evt.ctrlKey || evt.altKey || evt.shiftKey || this.selectedItem.value == '') break;
                    evt.preventDefault();
                    evt.stopImmediatePropagation();
                    if (!this.selectedItem.isSelectable) break;
                    this.select();
                    return;
                }
            }
        }
        // details are shown, cursor can be anywhere
        if (this.isActive) {
            switch (evt.key) {
                case 'Escape': {
                    // close autocomplete
                    if (evt.ctrlKey || evt.altKey || evt.shiftKey) return;
                    evt.preventDefault();
                    evt.stopPropagation();
                    this.isForceHidden = true;
                    this.wasForced = false;
                    this.hide();
                    return;
                }
                case 'Enter': {
                    // hide autocomplete on enter (send, execute, ...)
                    if (!evt.shiftKey) {
                        this.hide();
                        return;
                    }
                    break;
                }
            }
        }
        // autocomplete shown or not, cursor anywhere
        switch (evt.key) {
            // The first is a non-breaking space, the second is a regular space.
            case ' ':
            case ' ': {
                if (evt.ctrlKey || evt.altKey) {
                    if (this.isActive && this.isReplaceable) {
                        // ctrl-space to toggle details for selected item
                        this.toggleDetails();
                    } else {
                        // ctrl-space to force show autocomplete
                        this.show(false, true);
                    }
                    evt.preventDefault();
                    evt.stopPropagation();
                    return;
                }
                break;
            }
        }
        if (['Control', 'Shift', 'Alt'].includes(evt.key) || this.isComposing || evt.isComposing) {
            // ignore keydown on modifier keys and IME composition
            return;
        }
        // await keyup to see if cursor position or text has changed
        const oldText = this.textarea.value;
        this.pendingKeyUpCleanup?.();
        const didFireKeyUp = await new Promise(resolve => {
            const onKeyUp = () => {
                this.pendingKeyUpCleanup = null;
                resolve(true);
            };
            this.pendingKeyUpCleanup = () => {
                window.removeEventListener('keyup', onKeyUp);
                this.pendingKeyUpCleanup = null;
                resolve(false);
            };
            window.addEventListener('keyup', onKeyUp, { once: true });
        });
        if (!didFireKeyUp) {
            return;
        }
        if (this.selectionStart != this.textarea.selectionStart) {
            this.selectionStart = this.textarea.selectionStart;
            this.show(this.isReplaceable || oldText != this.textarea.value);
        } else if (this.isActive) {
            this.text != this.textarea.value && this.show(this.isReplaceable);
        }
    }
}
