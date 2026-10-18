/**
 * Setup: the settings people change once. Pronouns and the two syntax switches.
 */
import { announce, announceError, button, el } from '../dom.js';
import { getSettings, saveSettings } from '../settings.js';
import { syncCompatMode } from '../compat-macros.js';
import { syncImportFixes } from '../import-fixes.js';
import { renderPronounSettings } from '../pronoun-ui.js';

export function createSetupPanel({ openTopic } = {}) {
    const element = el('div', 'me-setup');
    element.appendChild(el('p', 'me-page-note', 'Saved settings for pronouns and syntax.'));

    const pronounsSection = el('section', 'me-section');
    pronounsSection.appendChild(el('h3', 'me-section-title', 'Pronouns'));
    const pronounsHost = el('div', 'me-pronoun-settings');
    pronounsSection.appendChild(pronounsHost);
    element.appendChild(pronounsSection);
    const pronouns = renderPronounSettings(pronounsHost);

    const switchesSection = el('section', 'me-section');
    switchesSection.appendChild(el('h3', 'me-section-title', 'How macros are read'));
    const cards = el('div', 'nn-settings-cards');
    const grid = el('div', 'nn-vt');
    const group = el('div', 'nn-vt-group');
    const groupHead = el('div', 'nn-vt-group-head');
    const groupCopy = el('div', 'nn-vt-group-copy');
    groupCopy.appendChild(el('h4', 'nn-vt-group-title', 'Engine reading'));
    groupCopy.appendChild(el('p', 'nn-vt-group-hint', 'Two switches that change what the engine understands. Both are off by default.'));
    groupHead.appendChild(groupCopy);
    group.appendChild(groupHead);

    function switchRow({ title, description, get, set, sync, helpTitle, topic }) {
        const row = el('label', 'nn-vt-row');
        const text = el('span', 'nn-vt-text');
        const nameLine = el('span', 'nn-vt-name-line');
        nameLine.appendChild(el('span', 'nn-vt-name', title));
        text.appendChild(nameLine);
        text.appendChild(el('span', 'nn-vt-desc', description));
        row.appendChild(text);

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!get();
        input.addEventListener('change', () => {
            set(input.checked);
            const active = sync(input.checked);
            if (input.checked && !active) {
                input.checked = false;
                set(false);
                announceError(`${title} could not be turned on: the host pre-processor hook is unavailable.`);
                return;
            }
            saveSettings();
            announce(`${title} is now ${input.checked ? 'on' : 'off'}.`);
        });
        row.appendChild(input);

        const wrap = el('div', 'me-switch-block');
        wrap.appendChild(row);
        const help = el('div', 'me-switch-help');
        help.appendChild(button('me-text-link', 'About this setting', () => openTopic?.(topic)));
        help.querySelector('button')?.setAttribute('aria-label', `Help: ${helpTitle}`);
        wrap.appendChild(help);
        group.appendChild(wrap);
        return { input, get };
    }

    const compatRow = switchRow({
        title: 'Work out comparisons in {{if}}',
        description: 'Lets a condition such as {{if::{{.hp}} > 0}} compare values instead of only checking that the text is not empty.',
        get: () => getSettings().compatExpressions,
        set: value => {
            getSettings().compatExpressions = value;
        },
        sync: syncCompatMode,
        helpTitle: 'Conditions written the ordinary way',
        topic: 'conditions',
    });

    const importRow = switchRow({
        title: 'Repair macros written for other apps',
        description: 'Reads {{@name}}, {{!setvar name value}} and a lone space argument as the cards intended. Text this engine already understands is left alone.',
        get: () => getSettings().fixImportedSyntax,
        set: value => {
            getSettings().fixImportedSyntax = value;
        },
        sync: syncImportFixes,
        helpTitle: 'Macros written for other apps',
        topic: 'imported-syntax',
    });

    grid.appendChild(group);
    cards.appendChild(grid);
    switchesSection.appendChild(cards);
    element.appendChild(switchesSection);

    return {
        element,
        refresh(kind) {
            pronouns.refresh();
            if (kind === 'settings' || kind === 'all') {
                for (const row of [compatRow, importRow]) {
                    if (document.activeElement !== row.input) {
                        row.input.checked = !!row.get();
                    }
                }
            }
        },
    };
}
