import { getRequestHeaders, refreshCsrfToken } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';

/** Uses the ordinary settings card styles, including phone touch targets. */
export function mountRoleplayRecovery(container) {
    const owner = getCurrentUserHandle();
    const card = document.createElement('section');
    card.id = 'sb-roleplay-recovery'; card.className = 'sb-admin-card';
    const title = document.createElement('strong'); title.textContent = 'Repair transferred data';
    const description = document.createElement('p');
    description.textContent = 'If chats stopped opening after copying folders, check them here. Repair backs up your chats, character cards, groups and tracking records, then accepts the files currently on disk. Old tabs and unfinished replies cannot save over them. Reload afterwards.';
    const prevention = document.createElement('p');
    prevention.textContent = 'For future transfers, use Import Folder or Import Backup ZIP instead of copying files into a running installation.';
    const actions = document.createElement('div'); actions.className = 'sb-import-action-row';
    const button = text => {
        const element = document.createElement('button'); element.type = 'button'; element.className = 'menu_button'; element.textContent = text;
        element.style.minHeight = '44px';
        return element;
    };
    // The shared menu-button display rule overrides the browser's hidden attribute.
    const visible = (element, value) => { element.hidden = !value; element.style.display = value ? '' : 'none'; };
    const check = button('Check transferred data');
    const repair = button('Back up and repair'); visible(repair, false);
    const reload = button('Reload repaired account'); visible(reload, false);
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.style.whiteSpace = 'pre-line'; status.style.overflowWrap = 'anywhere';
    actions.append(check, repair, reload); card.append(title, description, prevention, actions, status); container.append(card);
    let report;
    const assertOwner = () => { if (owner !== getCurrentUserHandle()) throw new Error('The account changed. Reload before repairing.'); };
    const request = async (route, body = {}) => {
        const response = await fetchWithCsrfRetry('/api/roleplay/recovery/' + route, () => {
            assertOwner();
            return { method: 'POST', headers: { ...getRequestHeaders(), 'X-Neconyan-Account': owner }, body: JSON.stringify(body) };
        }, { refreshCsrfToken });
        const result = await response.json();
        assertOwner();
        if (!response.ok) throw new Error(result.error || 'The check could not be completed.');
        return result;
    };
    const busy = value => { check.disabled = value; repair.disabled = value; };
    check.addEventListener('click', async () => {
        busy(true); visible(repair, false); visible(reload, false); report = null;
        status.textContent = 'Checking saved files...';
        try {
            report = await request('check');
            const { counts } = report;
            status.textContent = [`${counts.chats} chats, ${counts.characters} character cards and ${counts.groups} groups checked.`,
                ...(report.pending ? ['An unfinished operation will be archived. Repair keeps the files currently on disk.'] : []),
                ...report.issues.map(item => `${item.file}: ${item.reason}`),
                ...report.warnings.map(item => `${item.file}: ${item.reason}`),
                ...(report.issues.length ? ['Resolve the files listed above, then check again. Nothing has been changed.'] : []),
                ...(report.lastRepair ? [`Last repair: ${report.lastRepair.repairedAt}\nBackup: ${report.lastRepair.backup}`] : [])].join('\n');
            visible(repair, report.canRepair);
            visible(reload, !!report.lastRepair);
        } catch (error) { status.textContent = error.message; } finally { busy(false); }
    });
    repair.addEventListener('click', async () => {
        if (!report?.canRepair) return;
        busy(true); status.textContent = 'Backing up files and repairing tracking records. This continues if you close the page.';
        try {
            const result = await request('repair', { token: report.token });
            visible(repair, false); visible(reload, true);
            status.textContent = `Repair complete. Reload before opening or saving chats.\nBackup: ${result.backup}`;
        } catch (error) {
            visible(repair, false);
            status.textContent = `${error.message}\nCheck transferred data again to see whether the repair completed.`;
        } finally { busy(false); }
    });
    reload.addEventListener('click', () => { assertOwner(); location.reload(); });
}
