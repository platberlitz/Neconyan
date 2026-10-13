/** Retained reports are readable without application startup, Debugger or a server. */
const redact = text => globalThis.NeconyanCrashDiagnostics?.redact?.(text, 60000) ?? text.slice(0, 60000);
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function action(text, handler, primary = false) {
    const node = element('button', text, `menu_button${primary ? ' menu_button_primary' : ''}`);
    node.type = 'button'; node.dataset.i18n = text; node.addEventListener('click', handler); return node;
}
export function showRetainedReportPopup(content) {
    const previousFocus = document.activeElement;
    const template = document.getElementById('popup_template');
    const dialog = template?.content?.querySelector('dialog.popup')?.cloneNode(true) ?? element('dialog', '', 'popup');
    dialog.classList.add('neconyan-crash-popup');
    dialog.setAttribute('aria-label', 'Saved crash reports');
    for (const node of dialog.querySelectorAll('.popup-crop-wrap, .popup-input, .popup-inputs, .popup-button-close')) node.remove();
    const host = dialog.querySelector('.popup-content') ?? dialog;
    host.replaceChildren(content);
    const controls = dialog.querySelector('.popup-controls') ?? element('div', '', 'popup-controls');
    controls.replaceChildren(action('Close', () => dialog.close()));
    if (!controls.isConnected && !dialog.contains(controls)) dialog.append(controls);
    dialog.addEventListener('close', () => { dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}
async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* A local HTTP page may not have clipboard permission. */ }
    const textarea = element('textarea'); textarea.value = text; document.body.append(textarea); textarea.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Selectable text remains in the reader. */ }
    textarea.remove(); return copied;
}
function download(text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = 'Neconyan-crash-report.txt';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openCrashReportReader({ browserReports = globalThis.NeconyanCrashDiagnostics?.getReports?.() ?? { reports: [] }, selectedReportId,
    popup = showRetainedReportPopup, loadServerReports, nativeReader = globalThis.NeconyanExport?.showCrashReports?.bind(globalThis.NeconyanExport) } = {}) {
    const content = element('div', '', 'neconyan-crash-report sbdbg-report');
    content.append(element('h3', 'Saved crash reports'), element('p', 'Reports stay on this device or your server. Error messages and system traces may contain private text. Review before sharing.'));
    if (browserReports.storageError) content.append(element('p', browserReports.storageError));
    const reports = (browserReports.reports ?? []).slice(-5).reverse();
    const select = element('select', '', 'text_pole'); select.setAttribute('aria-label', 'Select a crash report');
    const summary = element('p'); summary.setAttribute('role', 'status');
    const textarea = element('textarea', '', 'text_pole sbdbg-report-text');
    textarea.readOnly = true; textarea.setAttribute('aria-label', 'Saved crash reports');
    textarea.wrap = 'soft'; textarea.rows = 12;
    const actions = element('div', '', 'sbdbg-actions');
    let selected = null;
    const render = () => {
        selected = reports[Number(select.value)] ?? null;
        textarea.value = selected ? redact(JSON.stringify(selected, null, 2)) : 'No saved browser crash reports.';
        summary.textContent = selected ? redact(selected.summary || selected.error?.message || 'Saved crash report') : 'No saved browser crash reports.';
    };
    const populate = () => {
        select.replaceChildren();
        reports.forEach((report, index) => {
            const option = element('option', `${report.runtime === 'server' ? 'Server' : 'Browser'}: ${report.at || 'Time unavailable'} - ${report.kind || 'Error'}`);
            option.value = String(index); select.append(option);
            if (report.id === selectedReportId) select.value = String(index);
        });
        render();
    };
    select.addEventListener('change', render);
    const copyButton = action('Copy report', async () => { copyButton.textContent = await copy(textarea.value) ? 'Copied' : 'Copy failed. Select the text below'; }, true);
    actions.append(copyButton, action('Download report', () => download(textarea.value)));
    if (nativeReader) actions.append(action('Android crash reports', () => { try { nativeReader(); } catch { /* Keep the browser reader available. */ } }));
    content.append(select, summary, actions, textarea);
    const serverStatus = element('p', 'Server reports have not been loaded'); serverStatus.setAttribute('role', 'status'); content.append(serverStatus);
    const load = async () => {
        if (!loadServerReports) return;
        serverStatus.textContent = 'Loading server reports';
        try {
            const result = await loadServerReports();
            if (result?.unavailable) serverStatus.textContent = result.unavailable;
            else {
                reports.push(...(result?.reports ?? []).slice(0, 10));
                serverStatus.textContent = `${result?.reports?.length || 0} saved server reports`;
                populate();
            }
        } catch { serverStatus.textContent = 'The server could not be reached. Saved browser reports are still available.'; }
    };
    if (loadServerReports) actions.append(action('Load server reports', () => void load()));
    populate();
    popup(content);
    if (loadServerReports) void load();
    return content;
}
