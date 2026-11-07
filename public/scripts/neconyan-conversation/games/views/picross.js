/**
 * The Picross board: clue runs down the side and across the top, then a square
 * grid. Tapping fills; the Mark tool (or a right click) crosses a square out.
 * Tapping a filled or crossed square again clears it.
 */
import { h, clear } from '../../../notebooks/dom.js';
import { t } from '../../../i18n.js';

const PAINTED = 1;
const MARKED = 2;

function clueValues(clue) {
    return Array.isArray(clue) && clue.length ? clue : [0];
}

/** Column clues stack one number per line, row clues sit on one line. */
function clueNode(clue, direction) {
    const values = clueValues(clue);
    const className = `neco-games-picross-clue is-${direction}`;
    return h('span', { class: className }, values.map(value => h('span', { text: String(value) })));
}

export function createPicrossView({ onMove } = {}) {
    const element = h('div', { class: 'neco-games-picross' });
    const toolbar = h('div', { class: 'neco-games-picross-tools', role: 'group', 'aria-label': 'What a tap does' });
    const puzzle = h('div', { class: 'neco-games-picross-puzzle' });
    const corner = h('div', { class: 'neco-games-picross-corner', 'aria-hidden': 'true' });
    const colClues = h('div', { class: 'neco-games-picross-col-clues', 'aria-hidden': 'true' });
    const rowClues = h('div', { class: 'neco-games-picross-row-clues', 'aria-hidden': 'true' });
    const grid = h('div', { class: 'neco-games-picross-grid', role: 'group', 'aria-label': 'Picross puzzle' });
    puzzle.append(corner, colClues, rowClues, grid);

    const paintTool = h('button', {
        type: 'button',
        class: 'neco-games-picross-tool',
        'aria-pressed': 'true',
        onclick: () => selectTool('paint'),
    }, h('i', { class: 'fa-solid fa-paintbrush', 'aria-hidden': 'true' }), h('span', { text: t`Paint` }));
    const markTool = h('button', {
        type: 'button',
        class: 'neco-games-picross-tool',
        'aria-pressed': 'false',
        onclick: () => selectTool('mark'),
    }, h('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }), h('span', { text: t`Mark` }));
    toolbar.append(paintTool, markTool);
    element.append(toolbar, puzzle);

    let state = null;
    let interactive = false;
    let tool = 'paint';
    let cursor = 0;

    function selectTool(next) {
        tool = next === 'mark' ? 'mark' : 'paint';
        paintTool.setAttribute('aria-pressed', String(tool === 'paint'));
        markTool.setAttribute('aria-pressed', String(tool === 'mark'));
    }

    function valueFor(index) {
        const cell = state.cells[index];
        if (tool === 'mark') {
            return cell === MARKED ? 'clear' : 'mark';
        }
        return cell === PAINTED ? 'clear' : 'paint';
    }

    function tap(index) {
        if (!state || state.over || !interactive) {
            return;
        }
        const row = Math.floor(index / state.cols);
        const col = index % state.cols;
        onMove?.({ row, col, value: valueFor(index) });
    }

    function markToggle(index) {
        if (!state || state.over || !interactive) {
            return;
        }
        const row = Math.floor(index / state.cols);
        const col = index % state.cols;
        onMove?.({ row, col, value: state.cells[index] === MARKED ? 'clear' : 'mark' });
    }

    function paint({ focusCell = null } = {}) {
        const focused = document.activeElement instanceof HTMLElement && grid.contains(document.activeElement)
            ? Number(document.activeElement.dataset.cell)
            : -1;
        clear(colClues);
        clear(rowClues);
        clear(grid);
        if (!state) {
            return;
        }
        element.dataset.cols = String(state.cols);
        element.dataset.rows = String(state.rows);

        for (let col = 0; col < state.cols; col++) {
            colClues.append(clueNode(state.colClues[col], 'column'));
        }
        for (let row = 0; row < state.rows; row++) {
            rowClues.append(clueNode(state.rowClues[row], 'row'));
        }

        for (let index = 0; index < state.rows * state.cols; index++) {
            const row = Math.floor(index / state.cols);
            const col = index % state.cols;
            const value = state.cells[index];
            const classes = ['neco-games-picross-cell'];
            if (value === PAINTED) {
                classes.push('is-painted');
            } else if (value === MARKED) {
                classes.push('is-marked');
            }
            if ((col + 1) % 5 === 0) {
                classes.push('is-fifth-col');
            }
            if ((row + 1) % 5 === 0) {
                classes.push('is-fifth-row');
            }
            const label = value === PAINTED ? 'painted' : (value === MARKED ? 'crossed out' : 'empty');
            const cell = h('button', {
                type: 'button',
                class: classes.join(' '),
                dataset: { cell: String(index), value: String(value) },
                tabindex: index === cursor ? '0' : '-1',
                'aria-label': `Row ${row + 1}, column ${col + 1}, ${label}`,
                onclick: () => {
                    cursor = index;
                    tap(index);
                },
                oncontextmenu: (event) => {
                    event.preventDefault();
                    cursor = index;
                    markToggle(index);
                },
            }, value === MARKED ? h('span', { class: 'neco-games-picross-mark', 'aria-hidden': 'true', text: '×' }) : null);
            grid.append(cell);
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
