import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { isTrueBoolean } from '../../utils.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { t } from '../../i18n.js';
import { revealUi, setUiVisibility } from '../../ui-motion.js';

const INPUT_HISTORY_STORAGE_KEY = 'st--inputHistory';

class Settings {
    /**@type {number}*/ maxHistory = 10;
    /**@type {boolean}*/ showButtons = true;
    /**@type {boolean}*/ showArrowButtons = true;
    /**@type {boolean}*/ showHistoryButton = true;
}
/**@type {Settings}*/
const settings = Object.assign(new Settings, extension_settings.inputHistory ?? {});
extension_settings.inputHistory = settings;

/**@type {HTMLTextAreaElement} */
let ta;
/**@type {string} */
let taValue;
/**@type {HTMLElement} */
let buttonWrap;
/**@type {HTMLElement} */
let arrowsWrap;
/**@type {HTMLElement} */
let btnHistory;
/**@type {HTMLElement} */
let historyMenu;
/**@type {MutationObserver} */
let buttonPlacementObserver;

const placeButtonWrap = () => {
    if (!buttonWrap) return;

    const guidedContainer = document.querySelector('#gg-action-button-container');
    if (guidedContainer) {
        if (buttonWrap.parentElement !== guidedContainer || guidedContainer.firstElementChild !== buttonWrap) {
            guidedContainer.prepend(buttonWrap);
        }
        buttonWrap.classList.remove('stih--standalone');
        return;
    }

    const sendForm = document.querySelector('#send_form');
    const nonQrFormItems = document.querySelector('#nonQRFormItems');
    if (!sendForm || !nonQrFormItems) return;

    if (buttonWrap.parentElement !== sendForm || buttonWrap.nextElementSibling !== nonQrFormItems) {
        sendForm.insertBefore(buttonWrap, nonQrFormItems);
    }
    buttonWrap.classList.add('stih--standalone');
};

const startButtonPlacementObserver = () => {
    if (buttonPlacementObserver) return;

    buttonPlacementObserver = new MutationObserver(() => placeButtonWrap());
    buttonPlacementObserver.observe(document.querySelector('#send_form') ?? document.body, { childList: true, subtree: true });
};


SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'inputhistory-config',
    callback: ({ key, get }, value) => {
        if (!key) {
            toastr.error('Required argument "key" missing for /inputhistory-conf');
            return;
        }
        const keys = Object.keys(settings);
        const types = {
            maxHistory: Number,
            showButtons: isTrueBoolean,
            showArrowButtons: isTrueBoolean,
            showHistoryButton: isTrueBoolean,
        };
        if (!keys.includes(key)) {
            toastr.error(`Invalid "key" argument "${key}" supplied for /inputhistory-conf`);
            return;
        }
        if (isTrueBoolean(get)) {
            toastr.info(`Input History setting ${key} = ${JSON.stringify(settings[key])}`);
            return JSON.stringify(settings[key]);
        }
        settings[key] = types[key](value.trim());
        updateButtons();
        saveSettingsDebounced();
    },
    aliases: ['ih-config'],
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({ name: 'key',
            description: 'Key of the setting to change or retrieve',
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: Object.keys(settings),
            isRequired: true,
        }),
        SlashCommandNamedArgument.fromProps({ name: 'get',
            description: 'Whether to retrieve the setting\'s current value without changing it.',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            isRequired: false,
            defaultValue: 'false',
            enumList: ['true', 'false'],
        }),
    ],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({ description: 'the new config value',
            typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN],
            isRequired: false,
        }),
    ],
    helpString: 'Change Input History configuration. Use <code>get=true</code> to retrieve the current value.',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'inputhistory-add',
    callback: (args, value) => {
        if (value.trim() == '') {
            toastr.error('Required string missing for /inputhistory-add');
            return;
        }
        addToInputHistory(value);
    },
    aliases: ['ih-add'],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({ description: 'string to add to input history',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        }),
    ],
    helpString: 'Adds input string to Input History (typically used for Quick Reply macros).',
}));

const HISTORY_MENU_GAP_PX = 8;
const HISTORY_MENU_EDGE_PX = 12;
const HISTORY_MENU_MIN_ABOVE_PX = 220;

const getHistoryMenuAnchor = () => [buttonWrap, ta, document.querySelector('#send_form')]
    .map(element => element?.getBoundingClientRect())
    .find(rect => rect && (rect.width || rect.height));

// The menu lives on <body> as a fixed layer, so iOS scrolls its list instead of the chat it covers.
const positionHistoryMenu = () => {
    if (!historyMenu) return;
    const anchor = getHistoryMenuAnchor();
    if (!anchor) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceAbove = anchor.top - HISTORY_MENU_GAP_PX - HISTORY_MENU_EDGE_PX;
    const spaceBelow = viewportHeight - anchor.bottom - HISTORY_MENU_GAP_PX - HISTORY_MENU_EDGE_PX;
    const below = spaceAbove < HISTORY_MENU_MIN_ABOVE_PX && spaceBelow > spaceAbove;
    const width = historyMenu.offsetWidth;
    const left = Math.max(HISTORY_MENU_EDGE_PX, Math.min(anchor.left, viewportWidth - width - HISTORY_MENU_EDGE_PX));
    historyMenu.classList.toggle('stih--below', below);
    historyMenu.style.setProperty('--stih-menu-left', `${Math.round(left)}px`);
    historyMenu.style.setProperty('--stih-menu-top', `${Math.round(below ? anchor.bottom + HISTORY_MENU_GAP_PX : anchor.top - HISTORY_MENU_GAP_PX)}px`);
    historyMenu.style.setProperty('--stih-menu-space', `${Math.max(0, Math.round(below ? spaceBelow : spaceAbove))}px`);
};

const onHistoryMenuKeydown = (event) => {
    if (event.key === 'Escape' && historyMenu) {
        event.preventDefault();
        event.stopPropagation();
        hideHistoryMenu();
        btnHistory.focus({ preventScroll: true });
    }
};

const hideHistoryMenu = () => {
    const menu = historyMenu;
    historyMenu = null;
    if (menu) {
        // A reopened menu takes the id while this one fades out.
        menu.removeAttribute('id');
        // A list still gliding from a swipe would turn the next tap into a scroll stop instead of a click.
        menu.querySelector('.stih--list')?.style.setProperty('overflow', 'hidden');
        setUiVisibility(menu, false, () => menu.remove(), { distance: 0 });
    }
    window.removeEventListener('resize', positionHistoryMenu);
    window.visualViewport?.removeEventListener('resize', positionHistoryMenu);
    window.visualViewport?.removeEventListener('scroll', positionHistoryMenu);
    btnHistory?.classList.remove('stih--hasMenu');
    btnHistory?.setAttribute('aria-expanded', 'false');
};
const showHistoryMenu = () => {
    if (historyMenu) return hideHistoryMenu();
    if (!ta || !buttonWrap || !getHistoryMenuAnchor()) return;
    btnHistory.classList.add('stih--hasMenu');
    btnHistory.setAttribute('aria-expanded', 'true');
    historyMenu = document.createElement('section');
    historyMenu.className = 'stih--history stih--active';
    historyMenu.id = 'stih-history';
    historyMenu.setAttribute('aria-label', t`Input History`);

    const header = document.createElement('div');
    header.className = 'stih--header';
    const heading = document.createElement('h3');
    heading.textContent = t`Input History`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stih--close';
    close.textContent = t`Close`;
    close.addEventListener('click', () => {
        hideHistoryMenu();
        btnHistory.focus({ preventScroll: true });
    });
    header.append(heading, close);
    const hint = document.createElement('p');
    hint.className = 'stih--hint';
    hint.textContent = t`Choose an input to replace your draft.`;
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole stih--search';
    search.placeholder = t`Search input history`;
    search.setAttribute('aria-label', t`Search input history`);
    const list = document.createElement('div');
    list.className = 'stih--list';
    const history = getInputHistory();
    for (const [index, text] of history.entries()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'stih--item';
        const title = document.createElement('span');
        title.className = 'stih--title';
        if (text.startsWith('/')) title.classList.add('stih--code');
        title.textContent = text;
        item.append(title);
        item.addEventListener('click', () => {
            hideHistoryMenu();
            inputHistoryIdx = index;
            ta.value = text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus({ preventScroll: true });
        });
        list.append(item);
    }
    const empty = document.createElement('p');
    empty.className = 'stih--empty';
    empty.setAttribute('role', 'status');
    empty.textContent = t`Your inputs will appear here after you send them.`;
    empty.hidden = history.length > 0;
    search.addEventListener('input', () => {
        const terms = search.value.toLowerCase().trim().split(/\s+/);
        let matches = 0;
        for (const item of list.querySelectorAll('.stih--item')) {
            item.hidden = !terms.every(term => item.textContent.toLowerCase().includes(term));
            if (!item.hidden) matches++;
        }
        empty.textContent = history.length ? t`No matching inputs. Try another search.` : t`Your inputs will appear here after you send them.`;
        empty.hidden = matches > 0;
    });
    list.append(empty);
    historyMenu.append(header, hint, search, list);
    historyMenu.addEventListener('keydown', onHistoryMenuKeydown);
    document.body.append(historyMenu);
    positionHistoryMenu();
    // Its translate lifts it above the composer, so only the opacity animates.
    revealUi(historyMenu, { distance: 0 });
    window.addEventListener('resize', positionHistoryMenu);
    window.visualViewport?.addEventListener('resize', positionHistoryMenu);
    window.visualViewport?.addEventListener('scroll', positionHistoryMenu);
    // Focus a button so opening history does not summon the phone keyboard.
    close.focus({ preventScroll: true });
};
const updateButtons = () => {
    if (!ta) return;

    if (!buttonWrap) {
        const wrap = document.createElement('div'); {
            buttonWrap = wrap;
            wrap.classList.add('stih--buttons');
            const arrows = document.createElement('div'); {
                arrowsWrap = arrows;
                arrows.classList.add('stih--arrows');
                const prev = document.createElement('button'); {
                    prev.type = 'button';
                    prev.classList.add('stih--button');
                    prev.classList.add('menu_button');
                    prev.classList.add('menu_button_icon');
                    prev.classList.add('fa-solid');
                    prev.classList.add('fa-chevron-up');
                    prev.title = t`Previous input`;
                    prev.setAttribute('aria-label', prev.title);
                    prev.addEventListener('click', () => inputHistoryBack());
                    arrows.append(prev);
                }
                const next = document.createElement('button'); {
                    next.type = 'button';
                    next.classList.add('stih--button');
                    next.classList.add('menu_button');
                    next.classList.add('menu_button_icon');
                    next.classList.add('fa-solid');
                    next.classList.add('fa-chevron-down');
                    next.title = t`Next input`;
                    next.setAttribute('aria-label', next.title);
                    next.addEventListener('click', () => inputHistoryForward());
                    arrows.append(next);
                }
                wrap.append(arrows);
            }
            const his = document.createElement('button'); {
                his.type = 'button';
                btnHistory = his;
                his.classList.add('stih--button');
                his.classList.add('menu_button');
                his.classList.add('menu_button_icon');
                his.classList.add('stih--menuTrigger');
                his.innerHTML = '<i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>';
                const label = document.createElement('span');
                label.textContent = t`History`;
                his.append(label);
                his.title = t`Input History`;
                his.setAttribute('aria-label', his.title);
                his.setAttribute('aria-expanded', 'false');
                his.setAttribute('aria-controls', 'stih-history');
                his.addEventListener('click', () => showInputHistory());
                wrap.append(his);
            }
            startButtonPlacementObserver();
        }
    }
    placeButtonWrap();
    buttonWrap.classList[settings.showButtons ? 'remove' : 'add']('stih--hidden');
    arrowsWrap.classList[settings.showArrowButtons ? 'remove' : 'add']('stih--hidden');
    btnHistory.classList[settings.showHistoryButton ? 'remove' : 'add']('stih--hidden');
    if (!settings.showButtons || !settings.showHistoryButton) hideHistoryMenu();
};

eventSource.on(event_types.APP_READY, async () => {
    ta = document.querySelector('#send_textarea');
    if (!ta) {
        console.error('Input History: Textarea #send_textarea not found.');
        return;
    }

    ta.addEventListener('keydown', (evt) => {
        if (evt.altKey) {
            if (evt.key == 'ArrowUp') {
                evt.preventDefault();
                evt.stopPropagation();
                inputHistoryBack();
            } else if (evt.key == 'ArrowDown') {
                evt.preventDefault();
                evt.stopPropagation();
                inputHistoryForward();
            }
        }
    });
    ta.addEventListener('input', () => {
        if (ta.value.trim() != '') taValue = ta.value;
    });
    document.addEventListener('pointerdown', (event) => {
        if (historyMenu && !buttonWrap.contains(event.target) && !historyMenu.contains(event.target)) hideHistoryMenu();
    });
    updateButtons();
    buttonWrap.addEventListener('keydown', onHistoryMenuKeydown);
});
eventSource.on(event_types.GENERATION_STARTED, () => {
    addToInputHistory(taValue);
});
eventSource.on(event_types.CHAT_COMMAND_STARTED, text => {
    addToInputHistory(text);
});


let inputHistoryIdx = -1;
export function getInputHistory() {
    try {
        return JSON.parse(accountStorage.getItem(INPUT_HISTORY_STORAGE_KEY) ?? '[]');
    } catch {
        return [];
    }
}
export function setInputHistory(inputHistory) {
    try {
        accountStorage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(inputHistory));
    } catch {
        // Persistence failure does not discard the caller's in-memory history.
    }
}
export function addToInputHistory(text) {
    text = text?.trim();
    if (text?.length) {
        const history = getInputHistory();
        if (history[0] != text) {
            history.unshift(text);
            while (history.length > settings.maxHistory) {
                history.pop();
            }
            setInputHistory(history);
        }
        inputHistoryIdx = -1;
    }
}
export function inputHistoryBack() {
    const history = getInputHistory();
    if (inputHistoryIdx + 1 < history.length) {
        inputHistoryIdx++;
    }
    ta.value = history[inputHistoryIdx] ?? '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
export function inputHistoryForward() {
    const history = getInputHistory();
    if (inputHistoryIdx >= 0) {
        inputHistoryIdx--;
    }
    if (history.length == 0 || inputHistoryIdx < 0) {
        ta.value = '';
    } else {
        ta.value = history[inputHistoryIdx];
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
export function showInputHistory() {
    showHistoryMenu();
}
