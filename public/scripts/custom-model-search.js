import { t } from './i18n.js';

/** Browse the native model catalogue without editing the model used for replies. */
export function initCustomModelSearch(select) {
    const root = document.getElementById('custom-model-search');
    const input = root?.querySelector('input');
    const clear = root?.querySelector('button');
    const results = root?.querySelector('[data-model-results]');
    const status = root?.querySelector('[role="status"]');
    if (!input || !clear || !results || !status || root.dataset.initialised) return;
    root.dataset.initialised = 'true';
    root.hidden = false;
    select.hidden = true;

    function choose(value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
        input.focus({ preventScroll: true });
    }

    function render() {
        const focusedValue = results.contains(document.activeElement) ? document.activeElement.dataset.modelId : null;
        const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const seen = new Set();
        const options = [...select.options].filter(option => {
            if (!option.value || option.disabled || seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
        const matches = options.filter(option => {
            const text = `${option.value} ${option.textContent}`.toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });
        clear.disabled = !input.value;
        status.textContent = !options.length
            ? t`Connect to load models, or enter a model ID above.`
            : !matches.length
                ? t`No models match. Try another name or model ID.`
                : matches.length > 50
                    ? t`${matches.length} models found. Showing the first 50; search to narrow the list.`
                    : t`${matches.length} of ${options.length} models`;
        const fragment = document.createDocumentFragment();
        for (const option of matches.slice(0, 50)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nn-custom-model-result';
            button.dataset.modelId = option.value;
            button.setAttribute('aria-pressed', String(select.value === option.value));
            const name = document.createElement('span');
            name.textContent = option.textContent.trim() || option.value;
            button.append(name);
            if (name.textContent !== option.value) {
                const id = document.createElement('small');
                id.textContent = option.value;
                button.append(id);
            }
            if (option.dataset.favorite === 'true') {
                const favourite = document.createElement('small');
                favourite.textContent = t`Favourite`;
                button.append(favourite);
            }
            fragment.append(button);
        }
        results.replaceChildren(fragment);
        if (focusedValue) results.querySelector(`[data-model-id="${CSS.escape(focusedValue)}"]`)?.focus({ preventScroll: true });
    }

    input.addEventListener('input', () => {
        render();
        results.scrollTop = 0;
    });
    clear.addEventListener('click', () => {
        input.value = '';
        render();
        results.scrollTop = 0;
        input.focus();
    });
    results.addEventListener('click', event => {
        const button = event.target.closest('[data-model-id]');
        if (button) choose(button.dataset.modelId);
    });
    root.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            input.value = '';
            render();
            input.focus();
        } else if (event.target === input && event.key === 'Enter') {
            event.preventDefault();
            if (input.value.trim()) results.firstElementChild?.click();
        } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            const buttons = [...results.children];
            const current = buttons.indexOf(event.target);
            if (event.target !== input && current < 0) return;
            event.preventDefault();
            const next = current + (event.key === 'ArrowDown' ? 1 : -1);
            if (next < 0) input.focus();
            else buttons[Math.min(next, buttons.length - 1)]?.focus();
        }
    });
    select.addEventListener('change', render);
    new MutationObserver(render).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label', 'data-favorite', 'value'] });
    render();
}
