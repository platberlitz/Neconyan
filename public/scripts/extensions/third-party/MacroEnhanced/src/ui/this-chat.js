/**
 * This chat: what macros remember here. Saved values, chat variables, pronoun
 * overrides, counters and the Cache Audit card.
 */
import { announce, button, el } from '../dom.js';
import { peekChatState, touchChatState } from '../chat-state.js';
import { SUBJECTS, clearOverride } from '../pronoun-macros.js';
import { applySandboxEnvironment, createSandbox } from '../workbench/sandbox.js';
import { withReadOnlyVariables } from '../../../../../variable-read-only.js';
import { renderAuditorTab } from '../auditor/auditor-ui.js';

const VALUE_KINDS = Object.freeze([
    ['freeze', 'frozen'],
    ['sticky', 'sticky'],
    ['daily', 'daily'],
    ['roll', 'rolls'],
]);

function hasChat(ctx = SillyTavern.getContext()) {
    return !!ctx.chatMetadata && ctx.chatId !== undefined && ctx.chatId !== null;
}

function chooseChat() {
    const shell = globalThis.NeconyanShell;
    if (shell?.openCharacters) {
        shell.openCharacters();
        return;
    }
    if (shell?.openTab) {
        shell.openTab('characters');
        return;
    }
    document.getElementById('rm_button_characters')?.click();
}

function sectionHeading(text) {
    const heading = el('h3', 'me-section-title', text);
    heading.tabIndex = -1;
    return heading;
}

function focusHeading(heading) {
    heading.focus({ preventScroll: true });
}

export function createThisChatPanel({ openTopic } = {}) {
    const element = el('div', 'me-chat');
    element.appendChild(el('p', 'me-page-note', 'What macros remember in this chat.'));

    const empty = el('div', 'me-empty-state');
    empty.appendChild(el('p', 'me-empty-title', 'No chat is open.'));
    empty.appendChild(el('p', 'me-section-note', 'Open a chat to see what macros remember in it.'));
    empty.appendChild(button('menu_button menu_button_primary', 'Choose a chat', chooseChat));
    element.appendChild(empty);

    const shell = el('div', 'me-chat-shell');

    const valuesHeading = sectionHeading('Saved values');
    const valuesSection = el('section', 'me-section');
    valuesSection.appendChild(valuesHeading);
    const valuesHost = el('div', 'me-value-rows');
    valuesSection.appendChild(valuesHost);
    shell.appendChild(valuesSection);

    const varsHeading = sectionHeading('Chat variables');
    const varsSection = el('section', 'me-section');
    varsSection.appendChild(varsHeading);
    const varsHost = el('div', 'me-value-rows');
    varsSection.appendChild(varsHost);
    shell.appendChild(varsSection);

    const pronounsHeading = sectionHeading('Pronouns in this chat');
    const pronounsSection = el('section', 'me-section');
    pronounsSection.appendChild(pronounsHeading);
    const pronounsHost = el('div', 'me-value-rows');
    pronounsSection.appendChild(pronounsHost);
    shell.appendChild(pronounsSection);

    const countersSection = el('section', 'me-section');
    countersSection.appendChild(sectionHeading('Counted so far'));
    const countersHost = el('p', 'me-section-note');
    countersSection.appendChild(countersHost);
    shell.appendChild(countersSection);

    const auditSection = el('section', 'me-section me-audit');
    auditSection.appendChild(sectionHeading('Cache audit'));
    auditSection.appendChild(el('p', 'me-section-note',
        'Finds macros that change between generations and silently break the prompt-caching discount. Presets, the character card, the persona and lorebooks sit above the cache breakpoints.'));
    const auditHost = el('div', 'me-audit-body');
    auditSection.appendChild(auditHost);
    shell.appendChild(auditSection);

    element.appendChild(shell);

    function currentState() {
        return peekChatState();
    }

    function confirm(text, detail) {
        const ctx = SillyTavern.getContext();
        const confirmFn = ctx.Popup?.show?.confirm;
        if (confirmFn) {
            return Promise.resolve(confirmFn(text, detail)).then(Boolean);
        }
        return Promise.resolve(globalThis.confirm(detail));
    }

    function forgetValue(prop, key) {
        const state = currentState();
        if (!state?.[prop] || !Object.hasOwn(state[prop], key)) {
            return;
        }
        delete state[prop][key];
        touchChatState('values');
        announce(`Forgot ${key}. It will re-evaluate next time.`);
        renderChat();
        focusHeading(valuesHeading);
    }

    async function forgetAll() {
        const state = currentState();
        if (!state) {
            return;
        }
        const total = VALUE_KINDS.reduce((count, [, prop]) => count + Object.keys(state[prop] ?? {}).length, 0);
        if (!total) {
            return;
        }
        if (!(await confirm('Forget saved values', `Forget all ${total} saved values in this chat?`))) {
            return;
        }
        for (const [, prop] of VALUE_KINDS) {
            state[prop] = {};
        }
        touchChatState('values');
        announce(`Forgot ${total} saved values.`);
        renderChat();
        focusHeading(valuesHeading);
    }

    function renderValues() {
        valuesHost.replaceChildren();
        const state = currentState();
        const entries = [];
        for (const [label, prop] of VALUE_KINDS) {
            for (const [key, entry] of Object.entries(state?.[prop] ?? {})) {
                entries.push({ label, prop, key, value: String(entry?.value ?? '') });
            }
        }
        if (!entries.length) {
            valuesHost.appendChild(el('p', 'me-section-note',
                'Nothing stored in this chat yet. {{freeze}}, {{sticky}}, {{daily}} and {{rollonce}} save their values here the first time they run.'));
            return;
        }
        for (const entry of entries) {
            const row = el('div', 'me-value-row');
            row.appendChild(el('span', 'me-pill me-pill-quiet', entry.label));
            row.appendChild(el('code', 'me-value-name', entry.key));
            row.appendChild(el('span', 'me-value-text', entry.value));
            row.appendChild(button('menu_button', 'Forget', () => forgetValue(entry.prop, entry.key)));
            valuesHost.appendChild(row);
        }
        valuesHost.appendChild(button('menu_button', 'Forget all', () => {
            void forgetAll();
        }));
    }

    function renderVars() {
        varsHost.replaceChildren();
        const state = currentState();
        const entries = Object.entries(state?.chatVars ?? {}).sort(([a], [b]) => a.localeCompare(b));
        if (!entries.length) {
            varsHost.appendChild(el('p', 'me-section-note',
                'No chat variables yet. {{setchatvar}} adds one, and {{foreachChatVar}} can loop over them.'));
            return;
        }
        for (const [key, value] of entries) {
            const row = el('div', 'me-value-row');
            row.appendChild(el('code', 'me-value-name', key));
            row.appendChild(el('span', 'me-value-text', String(value)));
            row.appendChild(button('menu_button', 'Delete', () => {
                const live = currentState();
                if (!live?.chatVars || !Object.hasOwn(live.chatVars, key)) {
                    return;
                }
                delete live.chatVars[key];
                touchChatState('values');
                announce(`Deleted chat variable ${key}.`);
                renderChat();
                focusHeading(varsHeading);
            }));
            varsHost.appendChild(row);
        }
    }

    function renderPronouns() {
        pronounsHost.replaceChildren();
        const state = currentState();
        const overrides = Object.values(SUBJECTS).filter(subject => String(state?.pronouns?.[subject.key] ?? '').trim());
        if (!overrides.length) {
            pronounsHost.appendChild(el('p', 'me-section-note', 'No pronoun overrides in this chat. The saved settings apply.'));
            return;
        }
        for (const subject of overrides) {
            const row = el('div', 'me-value-row');
            row.appendChild(el('span', 'me-pill me-pill-quiet', subject.key === 'user' ? 'Your persona' : 'This character'));
            row.appendChild(el('code', 'me-value-name', String(state.pronouns[subject.key])));
            row.appendChild(button('menu_button', 'Use the saved setting', () => {
                clearOverride(subject, { source: 'this-chat' });
                announce(`Cleared the pronoun override for ${subject.key === 'user' ? 'your persona' : 'this character'}.`);
                renderChat();
                focusHeading(pronounsHeading);
            }));
            pronounsHost.appendChild(row);
        }
    }

    function renderCounters() {
        const counters = currentState()?.counters ?? {};
        const user = counters.userMessages ?? 0;
        const replies = counters.charMessages ?? 0;
        const swipes = counters.swipes ?? 0;
        const generations = counters.generations ?? 0;
        countersHost.textContent = `${user} of your messages, ${replies} replies, ${swipes} swipes, ${generations} generations.`;
        countersHost.appendChild(el('span', 'me-counter-note', ' Counted from real chat events, never from a preview.'));
    }

    function makeSandboxEvaluate() {
        const sandbox = createSandbox({
            getLocalStore: () => SillyTavern.getContext().chatMetadata?.variables ?? {},
            getGlobalStore: () => SillyTavern.getContext().extensionSettings?.variables?.global ?? {},
            getChatState: () => currentState(),
        });
        return text => withReadOnlyVariables(() => {
            const ctx = SillyTavern.getContext();
            return sandbox.run((source, dynamicMacros) => {
                const env = ctx.macros.envBuilder.buildFromRawEnv({
                    content: source,
                    replaceCharacterCard: true,
                    dynamicMacros,
                    postProcessFn: x => x,
                });
                applySandboxEnvironment(env, sandbox);
                return ctx.macros.engine.evaluate(source, env);
            }, text);
        });
    }

    function renderChat() {
        const open = hasChat();
        empty.hidden = open;
        shell.hidden = !open;
        if (!open) {
            return;
        }
        renderValues();
        renderVars();
        renderPronouns();
        renderCounters();
    }

    renderAuditorTab(auditHost, {
        makeSandboxEvaluate,
        onHelp: () => openTopic?.('prompt-caching'),
    });

    if (!hasChat()) {
        shell.hidden = true;
    }
    renderChat();

    return {
        element,
        refresh() {
            renderChat();
        },
        handleChatChanged() {
            renderChat();
            // The audit's saved report belongs to the old chat; clear it by
            // rebuilding the card's result area.
            auditHost.replaceChildren();
            renderAuditorTab(auditHost, {
                makeSandboxEvaluate,
                onHelp: () => openTopic?.('prompt-caching'),
            });
        },
    };
}
