/** DOM construction uses text nodes: card and model text are never trusted markup. */
export function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

export function button(text, action, primary = false) {
    const node = element('button', `menu_button${primary ? ' menu_button_primary' : ''}`, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}

export function expandField(input, label) {
    const selection = [input.selectionStart, input.selectionEnd];
    const scroll = input.scrollTop;
    const dialog = element('dialog', 'creator-fullscreen');
    dialog.setAttribute('aria-label', label);
    const title = element('h2', '', label);
    const editor = element('textarea', 'text_pole creator-expanded-input');
    editor.value = input.value;
    editor.setAttribute('aria-label', label);
    const count = element('output', 'creator-muted');
    const update = () => { count.textContent = `${editor.value.length.toLocaleString()} characters`; };
    editor.addEventListener('input', () => {
        input.value = editor.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        update();
    });
    const toolbar = element('div', 'creator-actions');
    for (const macro of ['{{char}}', '{{user}}', '{{poss}}', '{{charposs}}']) {
        const insert = button(macro, () => {
            editor.setRangeText(macro, editor.selectionStart, editor.selectionEnd, 'end');
            editor.dispatchEvent(new Event('input'));
            editor.focus();
        });
        insert.title = macro.includes('poss') ? 'Requires MacroEnhanced and experimental macros. Configure pronouns in Macros & pronouns.' : 'Insert a literal macro.';
        toolbar.append(insert);
    }
    const tokens = button('Count tokens', async () => {
        const value = editor.value;
        tokens.disabled = true;
        try {
            const { getTokenCountAsync } = await import('../tokenizers.js');
            const total = await getTokenCountAsync(value);
            if (dialog.isConnected && editor.value === value) count.textContent = `${value.length.toLocaleString()} characters · approximately ${total.toLocaleString()} tokens`;
        } catch {
            if (dialog.isConnected) count.textContent = 'Token count unavailable. Your text is unchanged.';
        } finally { tokens.disabled = false; }
    });
    toolbar.append(tokens);
    const close = () => dialog.close();
    const header = element('header', 'creator-actions');
    header.append(title, button('Done', close, true));
    dialog.append(header, editor, toolbar, count);
    // Keeping the modal inside the drawer also respects its outside-click policy.
    input.closest('#sb_character_creator_panel').append(dialog);
    dialog.addEventListener('close', () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const caret = [editor.selectionStart, editor.selectionEnd];
        dialog.remove();
        if (input.isConnected) {
            input.focus({ preventScroll: true });
            input.setSelectionRange(...caret);
            input.scrollTop = scroll;
        }
    }, { once: true });
    update();
    dialog.showModal();
    editor.focus();
    editor.setSelectionRange(...selection);
}

/** Every text input except Display name gets the same fullscreen affordance. */
export function textField(label, value, change, { name = false, rows = 5, hint = '' } = {}) {
    const wrapper = element('div', 'creator-field');
    const heading = element('div', 'creator-field-heading');
    const input = element(name ? 'input' : 'textarea', 'text_pole');
    input.id = `creator-field-${crypto.randomUUID()}`;
    input.value = value ?? '';
    input.dataset.creatorText = name ? 'name' : 'expandable';
    if (name) input.type = 'text';
    else input.rows = rows;
    const title = element('label', '', label);
    title.htmlFor = input.id;
    heading.append(title);
    if (!name) {
        const expand = button('Fullscreen', () => expandField(input, label));
        expand.setAttribute('aria-label', `Expand ${label}`);
        heading.append(expand);
        input.addEventListener('dblclick', () => expandField(input, label));
    }
    input.addEventListener('input', () => change(input.value));
    wrapper.append(heading, input);
    if (hint) wrapper.append(element('p', 'creator-muted', hint));
    return wrapper;
}
