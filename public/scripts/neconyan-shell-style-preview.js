/** Small, isolated shell-style samples for the Shell Style picker; never apply shell classes to the live document. */

export function createShellStylePreview(themeId) {
    const preview = document.createElement('span');
    preview.className = 'sb-shell-style-preview';
    preview.dataset.sbShellPreview = themeId;
    preview.setAttribute('aria-hidden', 'true');

    const bar = document.createElement('span');
    bar.className = 'sb-shell-preview-bar';
    const dots = document.createElement('span');
    dots.className = 'sb-shell-preview-dots';
    for (let index = 0; index < 3; index++) {
        const dot = document.createElement('span');
        dot.className = 'sb-shell-preview-dot';
        dots.append(dot);
    }
    const title = document.createElement('span');
    title.className = 'sb-shell-preview-title';
    bar.append(dots, title);

    const body = document.createElement('span');
    body.className = 'sb-shell-preview-body';
    for (let index = 0; index < 2; index++) {
        const row = document.createElement('span');
        row.className = 'sb-shell-preview-message';
        const avatar = document.createElement('span');
        avatar.className = 'sb-shell-preview-avatar';
        const content = document.createElement('span');
        content.className = 'sb-shell-preview-content';
        for (const modifier of [' is-heading', '', ' is-short']) {
            const line = document.createElement('span');
            line.className = `sb-shell-preview-line${modifier}`;
            content.append(line);
        }
        row.append(avatar, content);
        body.append(row);
    }
    const dock = document.createElement('span');
    dock.className = 'sb-shell-preview-dock';
    body.append(dock);

    preview.append(bar, body);
    return preview;
}
