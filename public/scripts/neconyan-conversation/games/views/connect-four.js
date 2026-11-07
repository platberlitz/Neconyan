/**
 * The Connect Four board. Each column is one button so a tap anywhere in the
 * column drops a disc, which keeps the target big on a phone.
 */
import { h, clear } from '../../../notebooks/dom.js';

/** The human always holds the red seat; the first-move option only changes who drops first. */
const HUMAN_SEAT = 'r';
const SEAT_GLYPHS = { r: 'O', y: 'X' };

export function createConnectFourView({ onMove } = {}) {
    const element = h('div', { class: 'neco-games-cf' });
    const numbers = h('div', { class: 'neco-games-cf-numbers', 'aria-hidden': 'true' });
    const board = h('div', { class: 'neco-games-cf-board', role: 'group', 'aria-label': 'Connect Four board' });
    element.append(numbers, board);

    let state = null;
    let interactive = false;

    function paint() {
        clear(numbers);
        clear(board);
        if (!state) {
            return;
        }
        const rows = Number(state.rows) || 6;
        const cols = Number(state.cols) || 7;
        const heights = Array.isArray(state.heights) ? state.heights : Array.from({ length: cols }, () => 0);
        const winLine = new Set(Array.isArray(state.winLine) ? state.winLine : []);
        const lastColumn = Array.isArray(state.history) && state.history.length ? Number(state.history[state.history.length - 1]) : -1;
        const lastIndex = lastColumn >= 0 && heights[lastColumn] > 0
            ? (rows - 1 - (heights[lastColumn] - 1)) * cols + lastColumn
            : -1;

        for (let col = 0; col < cols; col++) {
            numbers.append(h('span', { class: 'neco-games-cf-number', text: String(col + 1) }));
        }

        for (let col = 0; col < cols; col++) {
            const dropRow = rows - 1 - heights[col];
            const playable = dropRow >= 0 && !state.over;
            const enabled = playable && interactive;
            const column = h('button', {
                type: 'button',
                class: 'neco-games-cf-column',
                dataset: { column: String(col) },
                'aria-label': playable ? `Drop in column ${col + 1}` : `Column ${col + 1}, full`,
                disabled: !enabled,
                onclick: () => {
                    if (enabled) {
                        onMove?.({ column: col });
                    }
                },
            });
            for (let row = 0; row < rows; row++) {
                const index = row * cols + col;
                const seat = state.board[index] || '';
                const classes = ['neco-games-cf-cell'];
                if (winLine.has(index)) {
                    classes.push('is-win');
                }
                if (index === lastIndex) {
                    classes.push('is-last');
                }
                column.append(h('span', {
                    class: classes.join(' '),
                    dataset: {
                        seat,
                        row: String(row),
                        target: row === dropRow && interactive ? 'true' : '',
                    },
                    'aria-hidden': 'true',
                }, seat ? h('span', { class: 'neco-games-cf-disc', text: SEAT_GLYPHS[seat] || '' }) : null));
            }
            board.append(column);
        }
    }

    function setState(next, { interactive: nextInteractive = false } = {}) {
        state = next;
        interactive = Boolean(nextInteractive);
        paint();
    }

    return {
        element,
        setState,
        destroy() {
            clear(element);
        },
        /** Exposed so a caller can tell the seats apart without importing the rules module. */
        seatFor: seat => (seat === HUMAN_SEAT ? 'you' : 'pal'),
    };
}
