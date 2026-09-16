// Localise known UI captions only, never editable values or user-authored messages.
const controls = 'button,summary,label,option,[role="tab"],.menu_button,.sb-shell-title,.sb-shell-description';
const userText = '[data-i18n-ignore],.mes_text,.mes_reasoning,.sb-conversation-message-text,.ch_name,.name_text,pre,code,textarea,[contenteditable="true"]';

export function localizeControls(root, dictionary) {
    if (!root?.querySelectorAll) return;
    const elements = [...root.querySelectorAll(controls)];
    if (root.matches?.(controls)) elements.unshift(root);
    for (const element of elements) {
        if (element.closest(userText)) continue;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
            if (text.parentElement.closest(userText) || text.parentElement.closest('[data-i18n]')) continue;
            const key = text.data.trim();
            if (key && Object.hasOwn(dictionary, key) && dictionary[key] !== key) {
                text.data = text.data.replace(key, dictionary[key]);
            }
        }
    }
    for (const element of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
        if (element.closest(userText)) continue;
        for (const attribute of ['title', 'placeholder', 'aria-label']) {
            const key = element.getAttribute(attribute);
            if (key && Object.hasOwn(dictionary, key) && dictionary[key] !== key) element.setAttribute(attribute, dictionary[key]);
        }
    }
}
