/** Small, isolated layout samples; never apply chat classes to the live document. */
export function createChatStylePicker(host, { options, onSelect, translate = text => text }) {
    const layouts = [
        ['flat', translate('Simple rows with avatars')],
        ['bubbles', translate('Rounded message cards')],
        ['document', translate('Continuous text, no avatars')],
        ['echo', translate('A faded portrait inside each card')],
        ['whisper', translate('A portrait wash at the right edge')],
        ['hush', translate('Full portrait backgrounds')],
        ['ripple', translate('Tall portraits beside the text')],
        ['tide', translate('Tinted cards with a raised header')],
        ['messenger', translate('Alternating chat bubbles')],
        ['notebook', translate('Ruled pages with a margin stripe')],
        ['screenplay', translate('Centred names and script text')],
        ['compact', translate('Small avatars and tighter spacing')],
        ['storybook', translate('Serif text and opening drop caps')],
    ];
    const element = (className, text, tag = 'span') => {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const current = element('nn-chat-style-current', undefined, 'div');
    current.append(element('', translate('Selected style')));
    const currentName = element('', '', 'strong');
    current.append(currentName);
    const grid = element('nn-chat-style-grid', undefined, 'div');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', translate('Chat Style:'));
    const entries = Array.from(options, option => {
        const value = String(option.value);
        const [layout, description] = layouts[value] ?? layouts[0];
        const name = translate(option.textContent.trim());
        const button = element('nn-chat-style-card', undefined, 'button');
        button.type = 'button';
        button.tabIndex = -1;
        button.dataset.chatStyle = value;
        const preview = element(`nn-chat-style-preview nn-chat-preview-${layout}`);
        preview.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 2; index++) {
            const row = element('nn-chat-preview-row');
            const avatar = element('nn-chat-preview-avatar');
            const content = element('nn-chat-preview-content');
            const heading = element('nn-chat-preview-heading');
            const text = element('nn-chat-preview-text');
            text.append(element('nn-chat-preview-line'), element('nn-chat-preview-line'), element('nn-chat-preview-line'));
            content.append(heading, text);
            row.append(avatar, content);
            preview.append(row);
        }
        const title = element('nn-chat-style-title');
        const check = element('nn-chat-style-check', '✓');
        check.setAttribute('aria-hidden', 'true');
        title.append(element('nn-chat-style-name', name), check);
        button.append(preview, title, element('nn-chat-style-description', description));
        button.addEventListener('focus', () => setTabStop(button));
        button.addEventListener('click', () => onSelect(value));
        return { value, name, button };
    });
    function setTabStop(button) {
        for (const entry of entries) entry.button.tabIndex = entry.button === button ? 0 : -1;
    }
    grid.append(...entries.map(entry => entry.button));
    grid.addEventListener('keydown', event => {
        const index = entries.findIndex(entry => entry.button === event.target);
        if (index < 0) return;
        const style = getComputedStyle(grid);
        const columns = style.gridTemplateColumns.split(' ').length;
        const direction = style.direction === 'rtl' ? -1 : 1;
        const offsets = { ArrowRight: direction, ArrowLeft: -direction, ArrowDown: columns, ArrowUp: -columns };
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
            : event.key in offsets ? Math.max(0, Math.min(entries.length - 1, index + offsets[event.key])) : -1;
        if (next < 0) return;
        event.preventDefault();
        entries[next].button.focus();
    });
    host.replaceChildren(current, grid);
    return {
        update(selected) {
            const active = entries.find(entry => entry.value === String(selected));
            currentName.textContent = active?.name ?? '';
            for (const entry of entries) entry.button.setAttribute('aria-pressed', String(entry === active));
            const focused = entries.find(entry => entry.button === document.activeElement);
            setTabStop((focused ?? active ?? entries[0])?.button);
        },
    };
}
