/**
 * The Minesweeper field. Tapping a covered cell uncovers it, tapping a number
 * with the right flags around it opens its neighbours, and the Flag tool (or a
 * right click) plants a flag.
 */
import { h, clear } from '../../../notebooks/dom.js';
import { t } from '../../../i18n.js';

const MINE = -1;

export function createMinesweeperView({ onMove } = {}) {
    const element = h('div', { class: 'neco-games-mines' });
    const toolbar = h('div', { class: 'neco-games-mines-tools', role: 'group', 'aria-label': 'What a tap does' });
    const revealTool = h('button', {
        type: 'button',
        class: 'neco-games-mines-tool',
        'aria-pressed': 'true',
        onclick: () => selectTool('reveal'),
    }, h('i', { class: 'fa-solid fa-hand-pointer', 'aria-hidden': 'true' }), h('span', { text: t`Uncover` }));
    const flagTool = h('button', {
        type: 'button',
        class: 'neco-games-mines-tool',
        'aria-pressed': 'false',
        onclick: () => selectTool('flag'),
    }, h('i', { class: 'fa-solid fa-flag', 'aria-hidden': 'true' }), h('span', { text: t`Flag` }));
    toolbar.append(revealTool, flagTool);
    const grid = h('div', { class: 'neco-games-mines-grid', role: 'group', 'aria-label': 'Minesweeper field' });
    element.append(toolbar, grid);

    let state = null;
    let interactive = false;
    let tool = 'reveal';
    let cursor = 0;

    function selectTool(next) {
        tool = next === 'flag' ? 'flag' : 'reveal';
        revealTool.setAttribute('aria-pressed', String(tool === 'reveal'));
        flagTool.setAttribute('aria-pressed', String(tool === 'flag'));
    }

    function tap(index) {
        if (!state || state.over || !interactive) {
            return;
        }
        const row = Math.floor(index / state.cols);
        const col = index % state.cols;
        if (state.revealed[index]) {
            onMove?.({ row, col, value: 'chord' });
            return;
        }
        onMove?.({ row, col, value: tool === 'flag' ? 'flag' : 'reveal' });
    }

    function flagTap(index) {
        if (!state || state.over || !interactive) {
            return;
        }
        onMove?.({ row: Math.floor(index / state.cols), col: index % state.cols, value: 'flag' });
    }

    function cellLabel(index) {
        const row = Math.floor(index / state.cols) + 1;
        const col = (index % state.cols) + 1;
        if (state.flagged[index] && !state.revealed[index]) {
            return `Row ${row}, column ${col}, flagged`;
        }
        if (!state.revealed[index]) {
            return `Row ${row}, column ${col}, hidden`;
        }
        const value = state.grid[index];
        if (value === MINE) {
            return `Row ${row}, column ${col}, mine`;
        }
        return `Row ${row}, column ${col}, ${value ? `${value} nearby` : 'empty'}`;
    }

    function paint({ focusCell = null } = {}) {
        const focused = document.activeElement instanceof HTMLElement && grid.contains(document.activeElement)
            ? Number(document.activeElement.dataset.cell)
            : -1;
        clear(grid);
        if (!state) {
            return;
        }
        element.dataset.cols = String(state.cols);
        element.dataset.rows = String(state.rows);

        for (let index = 0; index < state.revealed.length; index++) {
            const revealed = Boolean(state.revealed[index]);
            const flagged = Boolean(state.flagged[index]) && !revealed;
            const mine = state.grid[index] === MINE;
            const showMine = mine && (revealed || state.over);
            const classes = ['neco-games-mines-cell'];
            if (revealed) {
                classes.push('is-revealed');
            }
            if (flagged) {
                classes.push('is-flagged');
            }
            if (showMine) {
                classes.push('is-mine');
            }
            if (state.over && index === state.exploded) {
                classes.push('is-exploded');
            }
            if (state.over && flagged && !mine) {
                classes.push('is-wrong');
            }
            const number = revealed && !mine ? state.grid[index] : 0;
            grid.append(h('button', {
                type: 'button',
                class: classes.join(' '),
                dataset: {
                    cell: String(index),
                    count: number ? String(number) : '',
                },
                tabindex: index === cursor ? '0' : '-1',
                'aria-label': cellLabel(index),
                onclick: () => {
                    cursor = index;
                    tap(index);
                },
                oncontextmenu: (event) => {
                    event.preventDefault();
                    cursor = index;
                    flagTap(index);
                },
            }, h('span', { class: 'neco-games-mines-face', 'aria-hidden': 'true', text: showMine ? '✳' : (flagged ? '⚑' : (number ? String(number) : '')) })));
        }

        const wanted = focusCell === null ? focused : focusCell;
        if (Number.isInteger(wanted) && wanted >= 0) {
            grid.querySelector(`[data-cell="${wanted}"]`)?.focus({ preventScroll: true });
        }
    }

    grid.addEventListener('keydown', (event) => {
        if (!interactive || !state) {
            return;
        }
        const position = Number(event.target?.dataset?.cell ?? cursor);
        const rowStart = position - (position % state.cols);
        let next = null;
        switch (event.key) {
            case 'ArrowLeft':
                next = position % state.cols > 0 ? position - 1 : null;
                break;
            case 'ArrowRight':
                next = position % state.cols < state.cols - 1 ? position + 1 : null;
                break;
            case 'ArrowUp':
                next = position >= state.cols ? position - state.cols : null;
                break;
            case 'ArrowDown':
                next = position < state.rows * state.cols - state.cols ? position + state.cols : null;
                break;
            case 'Home':
                next = rowStart;
                break;
            case 'End':
                next = rowStart + state.cols - 1;
                break;
            default:
                return;
        }
        if (next === null || next === position) {
            return;
        }
        event.preventDefault();
        cursor = next;
        paint({ focusCell: next });
    });

    function setState(next, { interactive: nextInteractive = false } = {}) {
        if (next !== state && next) {
            cursor = 0;
        }
        state = next;
        interactive = Boolean(nextInteractive);
        paint();
    }

    return {
        element,
        setState,
        selectTool,
        destroy() {
            clear(element);
        },
    };
}
