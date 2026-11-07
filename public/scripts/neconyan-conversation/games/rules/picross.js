/**
 * Picross (nonogram) rules for Conversation mode games.
 *
 * Pure logic only: no imports, no DOM, no clock and no Math.random(). A caller supplies the
 * `random` function, so a puzzle can be reproduced from a seed in tests.
 *
 * A puzzle is generated rather than authored, and the win rule is 'every row and column clue
 * is satisfied', not 'the grid matches the generated answer'. Some random clue sets have more
 * than one consistent painting, and this rule means all of them win.
 *
 * State shape:
 * {
 *   id: 'picross',
 *   version: 1,
 *   rows: number,
 *   cols: number,
 *   answer: number[],        // flat rows*cols, 1 = filled, 0 = empty
 *   cells: number[],         // flat rows*cols, 0 = untouched, 1 = painted, 2 = marked
 *   rowClues: number[][],
 *   colClues: number[][],
 *   over: boolean,
 *   solved: boolean,
 *   moves: number,
 * }
 *
 * A move is { row, col, value } where value is 'paint', 'mark' or 'clear'.
 */

const SIZES = {
    easy: { rows: 5, cols: 5, label: '5 by 5' },
    normal: { rows: 10, cols: 10, label: '10 by 10' },
    hard: { rows: 15, cols: 15, label: '15 by 15' },
};

const UNTOUCHED = 0;
const PAINTED = 1;
const MARKED = 2;

/**
 * Used only when a caller forgets to pass `random`. It keeps the module free of Math.random
 * and the clock, at the cost of repeating the same puzzle order within one page session.
 */
let fallbackCounter = 0x9E3779B9;
function fallbackRandom() {
    fallbackCounter = (fallbackCounter + 0x6D2B79F5) >>> 0;
    let mixed = fallbackCounter;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

function indexAt(state, row, col) {
    return row * state.cols + col;
}

function cluesForLine(line) {
    const clues = [];
    let run = 0;
    for (const value of line) {
        if (value) {
            run++;
            continue;
        }
        if (run) {
            clues.push(run);
            run = 0;
        }
    }
    if (run) {
        clues.push(run);
    }
    return clues;
}

function buildClues(answer, rows, cols) {
    const rowClues = [];
    const colClues = [];
    for (let row = 0; row < rows; row++) {
        rowClues.push(cluesForLine(answer.slice(row * cols, row * cols + cols)));
    }
    for (let col = 0; col < cols; col++) {
        const line = [];
        for (let row = 0; row < rows; row++) {
            line.push(answer[row * cols + col]);
        }
        colClues.push(cluesForLine(line));
    }
    return { rowClues, colClues };
}

function matchesClues(line, clues) {
    const actual = cluesForLine(line.map(value => (value === PAINTED ? 1 : 0)));
    if (actual.length !== clues.length) {
        return false;
    }
    return actual.every((value, offset) => value === clues[offset]);
}

function isSolved(state) {
    for (let row = 0; row < state.rows; row++) {
        const line = state.cells.slice(row * state.cols, row * state.cols + state.cols);
        if (!matchesClues(line, state.rowClues[row])) {
            return false;
        }
    }
    for (let col = 0; col < state.cols; col++) {
        const line = [];
        for (let row = 0; row < state.rows; row++) {
            line.push(state.cells[row * state.cols + col]);
        }
        if (!matchesClues(line, state.colClues[col])) {
            return false;
        }
    }
    return true;
}

/**
 * A finished cell needs no further tap: filled where the answer is filled, and left unpainted
 * everywhere else. Marks count as finished because they are a note, not an answer.
 */
function isCellFinished(state, row, col) {
    const index = row * state.cols + col;
    const value = state.cells[index];
    return state.answer[index] ? value === PAINTED : value !== PAINTED;
}

function cloneState(state) {
    return {
        id: state.id,
        version: state.version,
        rows: state.rows,
        cols: state.cols,
        answer: state.answer.slice(),
        cells: state.cells.slice(),
        rowClues: state.rowClues.map(clue => clue.slice()),
        colClues: state.colClues.map(clue => clue.slice()),
        over: Boolean(state.over),
        solved: Boolean(state.solved),
        moves: state.moves,
    };
}

function createState({ options = {}, random } = {}) {
    const size = SIZES[String(options?.size || 'normal')] ?? SIZES.normal;
    const { rows, cols } = size;
    const total = rows * cols;
    const draw = typeof random === 'function' ? random : fallbackRandom;

    // Regenerate a few times so a puzzle is never almost blank or almost solid.
    let answer = [];
    for (let attempt = 0; attempt < 24; attempt++) {
        answer = Array.from({ length: total }, () => (draw() < 0.5 ? 1 : 0));
        const filled = answer.reduce((sum, value) => sum + value, 0);
        const ratio = filled / total;
        if (ratio >= 0.32 && ratio <= 0.68) {
            break;
        }
    }
    const { rowClues, colClues } = buildClues(answer, rows, cols);

    return {
        id: 'picross',
        version: 1,
        rows,
        cols,
        answer,
        cells: Array.from({ length: total }, () => UNTOUCHED),
        rowClues,
        colClues,
        over: false,
        solved: false,
        moves: 0,
    };
}

function legalMoves(state) {
    if (!state || state.over) {
        return [];
    }
    const moves = [];
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            if (!isCellFinished(state, row, col)) {
                moves.push({ row, col, value: 'paint' });
            }
        }
    }
    return moves;
}

function applyMove(state, move) {
    const row = Number(move?.row);
    const col = Number(move?.col);
    if (!state || state.over) {
        return state;
    }
    if (!Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || row >= state.rows || col < 0 || col >= state.cols) {
        return state;
    }

    const wanted = String(move?.value || 'paint');
    if (wanted !== 'paint' && wanted !== 'mark' && wanted !== 'clear') {
        return state;
    }

    const index = row * state.cols + col;
    const target = wanted === 'paint' ? PAINTED : (wanted === 'mark' ? MARKED : UNTOUCHED);
    if (state.cells[index] === target) {
        return state;
    }

    const next = cloneState(state);
    next.cells[index] = target;
    next.moves++;
    if (isSolved(next)) {
        next.solved = true;
        next.over = true;
    }
    return next;
}

function turn(state) {
    return state && !state.over ? 'you' : null;
}

function progress(state) {
    if (!state) {
        return { painted: 0, total: 0, rowsDone: 0, colsDone: 0, solved: false };
    }
    const painted = state.cells.filter(value => value === PAINTED).length;
    let rowsDone = 0;
    let colsDone = 0;
    for (let row = 0; row < state.rows; row++) {
        const line = state.cells.slice(row * state.cols, row * state.cols + state.cols);
        if (matchesClues(line, state.rowClues[row])) {
            rowsDone++;
        }
    }
    for (let col = 0; col < state.cols; col++) {
        const line = [];
        for (let row = 0; row < state.rows; row++) {
            line.push(state.cells[row * state.cols + col]);
        }
        if (matchesClues(line, state.colClues[col])) {
            colsDone++;
        }
    }
    return {
        painted,
        total: state.rows * state.cols,
        rowsDone,
        rowsTotal: state.rows,
        colsDone,
        colsTotal: state.cols,
        solved: Boolean(state.solved),
    };
}

function status(state) {
    if (!state) {
        return { over: false, winner: null, label: '', detail: '' };
    }
    if (!state.over) {
        const done = progress(state);
        return {
            over: false,
            winner: null,
            label: '',
            detail: `${done.rowsDone} of ${done.rowsTotal} rows and ${done.colsDone} of ${done.colsTotal} columns read correctly.`,
        };
    }
    return {
        over: true,
        winner: 'you',
        label: 'Puzzle solved',
        detail: `Every clue reads correctly after ${state.moves} taps.`,
    };
}

function describeMove(state, move) {
    const row = Number(move?.row);
    const col = Number(move?.col);
    if (!state || !Number.isInteger(row) || !Number.isInteger(col)) {
        return '';
    }
    const wanted = String(move?.value || 'paint');
    const label = wanted === 'mark' ? 'Marked' : (wanted === 'clear' ? 'Cleared' : 'Painted');
    return `${label} row ${row + 1}, column ${col + 1}`;
}

/**
 * The visible board for a reader. The generated answer is never printed, only the clues and
 * what the player has done so far.
 */
function promptBoard(state) {
    if (!state) {
        return '';
    }
    const lines = [
        `Picross, ${state.rows} rows by ${state.cols} columns.`,
        'Each number is a run of filled cells in that row or column, in order, with at least one',
        'blank cell between runs. Rows are numbered from the top and columns from the left.',
        '',
        'Column clues:',
        ...state.colClues.map((clue, col) => `  column ${col + 1}: ${clue.length ? clue.join(' ') : '-'}`),
        '',
        'Row clues and the grid so far (# filled, . blank, ? marked):',
        ...Array.from({ length: state.rows }, (unused, row) => {
            const clue = state.rowClues[row];
            const cells = [];
            for (let col = 0; col < state.cols; col++) {
                const value = state.cells[row * state.cols + col];
                cells.push(value === PAINTED ? '#' : (value === MARKED ? '?' : '.'));
            }
            return `  row ${String(row + 1).padStart(2, ' ')} [${clue.length ? clue.join(' ') : '-'}] ${cells.join('')}`;
        }),
        '',
    ];
    const done = progress(state);
    lines.push(state.over
        ? 'The puzzle is finished: every clue reads correctly.'
        : `Progress: ${done.rowsDone} of ${done.rowsTotal} rows and ${done.colsDone} of ${done.colsTotal} columns read correctly.`);
    return lines.join('\n');
}

/**
 * Accepts 'row 3 column 7', 'r3c7', '3,7', '3 7' and a paint or mark instruction anywhere in
 * the text. Returns null when nothing usable is found.
 */
function parseMoveReply(state, text) {
    if (!state || state.over) {
        return null;
    }
    const source = String(text || '').toLowerCase();
    if (!source.trim()) {
        return null;
    }
    const value = /mark|flag|\bx\b/.test(source) ? 'mark' : 'paint';

    const patterns = [
        /r(?:ow)?\s*(\d+)\s*[,;\s]*c(?:ol(?:umn)?)?\s*(\d+)/,
        /\b(\d+)\s*,\s*(\d+)\b/,
        /\b(\d+)\s+(?:and\s+)?(\d+)\b/,
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (!match) {
            continue;
        }
        const row = Number(match[1]) - 1;
        const col = Number(match[2]) - 1;
        if (row >= 0 && row < state.rows && col >= 0 && col < state.cols) {
            return { row, col, value };
        }
    }
    return null;
}

/**
 * A single nudge towards the generated answer: a cell that should be filled and is not, or a
 * cell painted where the answer is blank. Returns null when the grid already matches.
 */
function hintCell(state) {
    if (!state) {
        return null;
    }
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const index = row * state.cols + col;
            if (state.answer[index] && state.cells[index] !== PAINTED) {
                return { row, col, value: 'paint' };
            }
        }
    }
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const index = row * state.cols + col;
            if (!state.answer[index] && state.cells[index] === PAINTED) {
                return { row, col, value: 'clear' };
            }
        }
    }
    return null;
}

/** Solo puzzle: no seat plays against the reader. */
function pickCpuMove() {
    return null;
}

function hydrate(raw) {
    if (!raw || typeof raw !== 'object' || raw.id !== 'picross') {
        return null;
    }
    const rows = Number(raw.rows);
    const cols = Number(raw.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 3 || rows > 25 || cols < 3 || cols > 25) {
        return null;
    }
    const total = rows * cols;
    if (!Array.isArray(raw.answer) || raw.answer.length !== total) {
        return null;
    }
    if (!Array.isArray(raw.cells) || raw.cells.length !== total) {
        return null;
    }
    if (raw.answer.some(value => value !== 0 && value !== 1)) {
        return null;
    }
    if (raw.cells.some(value => value !== UNTOUCHED && value !== PAINTED && value !== MARKED)) {
        return null;
    }
    if (!Array.isArray(raw.rowClues) || raw.rowClues.length !== rows
        || !Array.isArray(raw.colClues) || raw.colClues.length !== cols) {
        return null;
    }
    const clueShapeValid = list => list.every(clue => Array.isArray(clue)
        && clue.length <= Math.ceil((list === raw.rowClues ? cols : rows) / 2)
        && clue.every(value => Number.isInteger(value) && value > 0));
    if (!clueShapeValid(raw.rowClues) || !clueShapeValid(raw.colClues)) {
        return null;
    }
    // Clues must describe the stored answer, otherwise the save has been edited or mixed up.
    const { rowClues, colClues } = buildClues(raw.answer, rows, cols);
    const sameClues = (a, b) => a.length === b.length && a.every((clue, offset) => {
        const other = b[offset];
        return clue.length === other.length && clue.every((value, position) => value === other[position]);
    });
    if (!sameClues(rowClues, raw.rowClues) || !sameClues(colClues, raw.colClues)) {
        return null;
    }
    if (!Number.isInteger(raw.moves) || raw.moves < 0) {
        return null;
    }

    const cells = raw.cells.slice();
    const answer = raw.answer.slice();
    const rebuilt = {
        id: 'picross',
        version: Number.isInteger(raw.version) ? raw.version : 1,
        rows,
        cols,
        answer,
        cells,
        rowClues: rowClues.map(clue => clue.slice()),
        colClues: colClues.map(clue => clue.slice()),
        over: false,
        solved: false,
        moves: raw.moves,
    };
    const solved = isSolved(rebuilt);
    rebuilt.solved = solved;
    rebuilt.over = solved;
    return rebuilt;
}

export const RULES = {
    id: 'picross',
    name: 'Picross',
    icon: 'fa-table-cells',
    blurb: 'Paint by numbers, one clue at a time.',
    kind: 'solo',
    difficulties: [],
    options: [
        {
            id: 'size',
            label: 'Puzzle size',
            values: [
                { id: 'easy', label: 'Small (5 by 5)' },
                { id: 'normal', label: 'Medium (10 by 10)' },
                { id: 'hard', label: 'Large (15 by 15)' },
            ],
            default: 'normal',
            compact: 'easy',
        },
    ],
    createState,
    legalMoves,
    applyMove,
    turn,
    status,
    describeMove,
    pickCpuMove,
    promptBoard,
    parseMoveReply,
    hydrate,
    progress,
    hintCell,
};

export const PICROSS_INTERNALS = {
    SIZES,
    UNTOUCHED,
    PAINTED,
    MARKED,
    fallbackRandom,
    cluesForLine,
    buildClues,
    isSolved,
    matchesClues,
    indexAt,
};
