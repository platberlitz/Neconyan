import { element, emptyState, errorMessage, field, formatTokens, replace, statusRegion, button } from '../dom.js';
import { isLedgerRecordingEnabled, setLedgerRecordingEnabled } from '../ledger.js';
import { getSettings, isSettingsReadOnly, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

const SHOWN_ENTRIES = 50;
const SUMMARY_SECTIONS = 6;

const KIND_LABEL = Object.freeze({
    normal: 'Reply',
    continue: 'Continue',
    impersonate: 'Impersonation',
    swipe: 'Swipe',
    regenerate: 'Regenerate',
    quiet: 'Background request',
});

function formatWhen(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? String(value ?? '')
        : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Mean total and the sections that cost the most, across recorded prompts. */
export function summarizeLedger(entries, { topSections = SUMMARY_SECTIONS } = {}) {
    const totals = entries.map(entry => entry.total).filter(total => total > 0);
    const meanTotal = totals.length
        ? Math.round(totals.reduce((sum, total) => sum + total, 0) / totals.length)
        : 0;
    const perSection = new Map();
    for (const entry of entries) {
        for (const section of entry.sections) {
            const slot = perSection.get(section.id) ?? { id: section.id, label: section.label, tokens: 0, appearances: 0 };
            slot.tokens += section.tokens;
            slot.appearances += 1;
            slot.label = slot.label || section.label;
            perSection.set(section.id, slot);
        }
    }
    const sections = [...perSection.values()]
        .map(slot => ({ ...slot, mean: Math.round(slot.tokens / Math.max(1, slot.appearances)) }))
        .sort((left, right) => right.mean - left.mean)
        .slice(0, Math.max(0, topSections));
    return { count: entries.length, meanTotal, sections };
}

export function createLedgerTab({ ledger }) {
    let root = null;
    let status = null;
    let enableInput = null;
    let retentionInput = null;
    let summaryHost = null;
    let listHost = null;
    let reloadEpoch = 0;

    function renderSummary(entries) {
        if (!entries.length) {
            replace(summaryHost);
            return;
        }
        const summary = summarizeLedger(entries);
        const rows = element('div', { className: 'sbpl-ledger-summary-rows' });
        const row = (label, value) => {
            const node = element('div', { className: 'sbpl-readout-row' });
            node.append(
                element('span', { className: 'sbpl-readout-label', text: label }),
                element('span', { className: 'sbpl-readout-value', text: value }),
            );
            return node;
        };
        rows.append(
            row('Recorded prompts', String(summary.count)),
            row('Average prompt size', `${formatTokens(summary.meanTotal)} tokens`),
            ...summary.sections.map(section => row(section.label || section.id, `${formatTokens(section.mean)} tokens avg`)),
        );
        replace(
            summaryHost,
            element('p', { className: 'sbpl-field-label', text: 'Across everything recorded' }),
            rows,
        );
    }

    function renderList(entries) {
        if (!entries.length) {
            replace(listHost, emptyState(
                'Nothing recorded yet.',
                'Turn recording on, then send a message in any chat. Each reply shows up here with the token cost of every prompt section.',
            ));
            return;
        }
        const items = entries.slice(0, SHOWN_ENTRIES).map((entry) => {
            const details = element('details', { className: 'sbpl-ledger-entry' });
            const summary = element('summary');
            summary.append(
                element('span', { className: 'sbpl-ledger-when', text: formatWhen(entry.at) }),
                element('span', { className: 'sbpl-ledger-name', text: entry.characterName || entry.api }),
                element('span', { className: 'sbpl-ledger-kind', text: KIND_LABEL[entry.kind] ?? entry.kind }),
                element('span', {
                    className: 'sbpl-ledger-total',
                    text: `${formatTokens(entry.total)} tokens${entry.estimated ? ' (estimated)' : ''}`,
                }),
            );
            details.append(summary);
            const list = element('ul', { className: 'sbpl-ledger-sections' });
            [...entry.sections]
                .sort((left, right) => right.tokens - left.tokens)
                .forEach(section => list.append(element('li', {
                    text: `${section.label || section.id}: ${formatTokens(section.tokens)} tokens`,
                })));
            if (entry.wiEntryCount) {
                list.append(element('li', {
                    className: 'sbpl-ledger-wi',
                    text: `${entry.wiEntryCount} lorebook ${entry.wiEntryCount === 1 ? 'entry' : 'entries'} activated`,
                }));
            }
            if (!entry.sections.length) {
                list.append(element('li', { text: 'No section breakdown was available for this prompt.' }));
            }
            details.append(list);
            return details;
        });
        const nodes = [...items];
        if (entries.length > SHOWN_ENTRIES) {
            nodes.push(element('p', {
                className: 'sbpl-field-hint',
                text: `The newest ${SHOWN_ENTRIES} of ${entries.length} recorded prompts are shown. Older ones still count toward the averages above.`,
            }));
        }
        replace(listHost, ...nodes);
    }

    async function reload() {
        const epoch = ++reloadEpoch;
        let entries;
        try {
            entries = await storage.listLedger();
        } catch (error) {
            if (epoch === reloadEpoch && status) {
                status.textContent = `Recorded prompts could not be loaded: ${errorMessage(error)}`;
            }
            return;
        }
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        renderSummary(entries);
        renderList(entries);
    }

    function syncControls() {
        if (enableInput) {
            enableInput.checked = isLedgerRecordingEnabled();
        }
        if (retentionInput && document.activeElement !== retentionInput) {
            retentionInput.value = String(getSettings().ledgerRetention);
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-ledger-tab' });
        const readOnly = isSettingsReadOnly();
        const settings = getSettings();
        status = statusRegion('');

        enableInput = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        enableInput.checked = isLedgerRecordingEnabled();
        enableInput.addEventListener('change', () => {
            setLedgerRecordingEnabled(enableInput.checked);
            ledger.setEnabled(enableInput.checked);
            status.textContent = enableInput.checked
                ? 'Recording is on, on this device. Each reply you send will be added here.'
                : 'Recording is off on this device. Nothing new will be added.';
        });
        const enableChoice = element('label', { className: 'sbpl-field sbpl-field-inline' });
        enableChoice.append(enableInput, element('span', {
            className: 'sbpl-field-label',
            text: 'Record where the tokens of real replies go',
        }), element('span', {
            className: 'sbpl-field-hint',
            text: 'A per-device switch: it never syncs to your other devices.',
        }));

        retentionInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '10', max: '2000', step: '1' },
        });
        retentionInput.value = String(settings.ledgerRetention);
        retentionInput.disabled = readOnly;
        retentionInput.addEventListener('change', () => {
            const next = updateSettings({ ledgerRetention: Number(retentionInput.value) });
            retentionInput.value = String(next.ledgerRetention);
            status.textContent = `Keeping the newest ${next.ledgerRetention} recorded prompts.`;
            void storage.pruneLedger(next.ledgerRetention).then(() => reload()).catch(() => {});
        });

        const clear = button('Delete everything recorded', async () => {
            const confirmed = globalThis.confirm?.('Delete every recorded prompt? The recording switch is not changed.');
            if (!confirmed) {
                return;
            }
            try {
                await storage.clearLedger();
                status.textContent = 'Deleted everything recorded.';
                await reload();
            } catch (error) {
                status.textContent = `The recorded prompts could not be deleted: ${errorMessage(error)}`;
            }
        });

        summaryHost = element('div', { className: 'sbpl-ledger-summary' });
        listHost = element('div', { className: 'sbpl-ledger-list' });

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Only section names and token counts are stored: never the prompt text itself. Dry runs and Prompting Lab’s own captures are not recorded.',
            }),
            enableChoice,
            field('Recorded prompts kept', retentionInput, {
                hint: 'Older recordings are removed to save space.',
            }),
            summaryHost,
            listHost,
            clear,
            status,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload();
            }
            return root;
        },
        refresh() {
            if (!root) {
                return;
            }
            syncControls();
            ledger.sync();
            void reload();
        },
        dispose() {
            reloadEpoch++;
            root?.remove();
            root = null;
        },
    };
}
