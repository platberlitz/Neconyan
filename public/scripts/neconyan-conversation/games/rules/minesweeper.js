/**
 * Minesweeper rules for Conversation mode games.
 *
 * Pure logic only: no imports, no DOM, no clock and no Math.random(). A caller supplies the
 * `random` function.
 *
 * Mines are laid on the first reveal, never before, so an opening tap is always safe and the
 * first click also clears its eight neighbours of mines.
 *
 * State shape:
 * {
 *   id: 'minesweeper',
 *   version: 1,
 *   seed: number,          // from the caller's random function, drives mine placement
 *   rows: number,
 *   cols: number,
 *   mines: number,
 *   grid: number[],        // flat rows*cols, -1 = mine, 0..8 = touching mines
 *   placed: boolean,       // false until the first reveal lays the mines
 *   revealed: boolean[],   // flat rows*cols
 *   flagged: boolean[],    // flat rows*cols
 *   over: boolean,
 *   won: boolean,
 *   exploded: number|null, // index of the mine that ended the game
 *   moves: number,
 * }
 *
 * A move is { row, col, value } where value is 'reveal', 'flag' or 'chord'.
 *
 * Mine placement reads the stored seed rather than a clock or Math.random, so the same saved
 * state always lays the same field. Variety comes from the seed the caller generated.
 */

const BOARDS = {
    easy: { rows: 8, cols: 8, mines: 10, label: 'Small (8 by 8, 10 mines)' },
    normal: { rows: 10, cols: 10, mines: 16, label: 'Medium (10 by 10, 16 mines)' },
    hard: { rows: 14, cols: 14, mines: 32, label: 'Large (14 by 14, 32 mines)' },
};

const MINE = -1;
const NEIGHBOUR_OFFSETS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** A small deterministic generator, so mine placement needs no clock and no Math.random. */
function seededRandom(seed) {
    let value = (Number(seed) >>> 0) || 1;
    return () => {
        value = (value + 0x6D2B79F5) >>> 0;
        let mixed = value;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

/** Used only when a caller forgets to pass `random` to createState. */
let fallbackCounter = 0x9E3779B9;
function fallbackRandom() {
    fallbackCounter = (fallbackCounter + 0x6D2B79F5) >>> 0;
    let mixed = fallbackCounter;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

function inBounds(state, row, col) {
    return row >= 0 && row < state.rows && col >= 0 && col < state.cols;
}

function indexAt(state, row, col) {
    return row * state.cols + col;
}

function neighboursOf(state, row, col) {
    const found = [];
    for (const [dr, dc] of NEIGHBOUR_OFFSETS) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (inBounds(state, nextRow, nextCol)) {
            found.push(indexAt(state, nextRow, nextCol));
        }
    }
    return found;
}

function cloneState(state) {
    return {
        id: state.id,
        version: state.version,
        seed: state.seed,
        rows: state.rows,
        cols: state.cols,
        mines: state.mines,
        grid: state.grid.slice(),
        placed: Boolean(state.placed),
        revealed: state.revealed.slice(),
        flagged: state.flagged.slice(),
        over: Boolean(state.over),
        won: Boolean(state.won),
        exploded: Number.isInteger(state.exploded) ? state.exploded : null,
        moves: state.moves,
    };
}

function createState({ options = {}, random } = {}) {
    const board = BOARDS[String(options?.size || 'normal')] ?? BOARDS.normal;
    const total = board.rows * board.cols;
    const draw = typeof random === 'function' ? random : fallbackRandom;
    return {
        id: 'minesweeper',
        version: 1,
        seed: Math.floor(draw() * 2147483647) || 1,
        rows: board.rows,
        cols: board.cols,
        mines: Math.min(board.mines, total - 9),
        grid: Array.from({ length: total }, () => 0),
        placed: false,
        revealed: Array.from({ length: total }, () => false),
        flagged: Array.from({ length: total }, () => false),
        over: false,
        won: false,
        exploded: null,
        moves: 0,
    };
}

/** Lay the mines everywhere except the opening cell and its neighbours, then number the grid. */
function placeMines(state, safeIndex, random) {
    const total = state.rows * state.cols;
    const safeRow = Math.floor(safeIndex / state.cols);
    const safeCol = safeIndex % state.cols;
    const banned = new Set([safeIndex, ...neighboursOf(state, safeRow, safeCol)]);
    const candidates = [];
    for (let index = 0; index < total; index++) {
        if (!banned.has(index)) {
            candidates.push(index);
        }
    }

    // Fisher-Yates on the candidate list, driven by the caller's random function.
    const draw = typeof random === 'function' ? random : seededRandom(state.seed + safeIndex);
    for (let cursor = candidates.length - 1; cursor > 0; cursor--) {
        const pick = Math.min(cursor, Math.floor(draw() * (cursor + 1)));
        const swap = candidates[pick];
        candidates[pick] = candidates[cursor];
        candidates[cursor] = swap;
    }

    const grid = Array.from({ length: total }, () => 0);
    const laid = candidates.slice(0, state.mines);
    for (const index of laid) {
        grid[index] = MINE;
    }
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const index = indexAt(state, row, col);
            if (grid[index] === MINE) {
                continue;
            }
            grid[index] = neighboursOf(state, row, col).filter(other => grid[other] === MINE).length;
        }
    }
    return grid;
}

function safeTotal(state) {
    return state.rows * state.cols - state.mines;
}

function hasWon(state) {
    return state.revealed.filter(Boolean).length >= safeTotal(state);
}

function finishWin(state) {
    state.won = true;
    state.over = true;
    // Flag every remaining mine so the finished board reads clearly.
    for (let index = 0; index < state.grid.length; index++) {
        if (state.grid[index] === MINE) {
            state.flagged[index] = true;
        }
    }
}

function finishLoss(state, index) {
    state.over = true;
    state.won = false;
    state.exploded = index;
    for (let cursor = 0; cursor < state.grid.length; cursor++) {
        if (state.grid[cursor] === MINE) {
            state.revealed[cursor] = true;
        }
    }
}

/** Flood fill from a numbered or blank cell, stopping at numbers. */
function revealFrom(state, startIndex) {
    const queue = [startIndex];
    while (queue.length) {
        const index = queue.shift();
        if (state.revealed[index] || state.flagged[index]) {
            continue;
        }
        state.revealed[index] = true;
        if (state.grid[index] === 0) {
            const row = Math.floor(index / state.cols);
            const col = index % state.cols;
            for (const other of neighboursOf(state, row, col)) {
                if (!state.revealed[other]) {
                    queue.push(other);
                }
            }
        }
    }
}

function applyMove(state, move, { random } = {}) {
    if (!state || state.over) {
        return state;
    }
    const row = Number(move?.row);
    const col = Number(move?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || !inBounds(state, row, col)) {
        return state;
    }
    const wanted = String(move?.value || 'reveal');
    if (wanted !== 'reveal' && wanted !== 'flag' && wanted !== 'chord') {
        return state;
    }

    const index = indexAt(state, row, col);
    if (wanted === 'flag') {
        if (state.revealed[index]) {
            return state;
        }
        const next = cloneState(state);
        next.flagged[index] = !next.flagged[index];
        next.moves++;
        return next;
    }

    if (wanted === 'chord') {
        if (!state.revealed[index] || state.grid[index] <= 0) {
            return state;
        }
        const around = neighboursOf(state, row, col);
        const flags = around.filter(other => state.flagged[other]).length;
        if (flags !== state.grid[index]) {
            return state;
        }
        const next = cloneState(state);
        for (const other of around) {
            if (next.revealed[other] || next.flagged[other]) {
                continue;
            }
            if (next.grid[other] === MINE) {
                finishLoss(next, other);
                next.moves++;
                return next;
            }
            revealFrom(next, other);
        }
        next.moves++;
        if (hasWon(next)) {
            finishWin(next);
        }
        return next;
    }

    if (state.revealed[index] || state.flagged[index]) {
        return state;
    }

    const next = cloneState(state);
    if (!next.placed) {
        next.grid = placeMines(next, index, random);
        next.placed = true;
    }
    next.moves++;
    if (next.grid[index] === MINE) {
        finishLoss(next, index);
        return next;
    }
    revealFrom(next, index);
    if (hasWon(next)) {
        finishWin(next);
    }
    return next;
}

function legalMoves(state) {
    if (!state || state.over) {
        return [];
    }
    const moves = [];
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const index = indexAt(state, row, col);
            if (!state.revealed[index]) {
                moves.push({ row, col, value: 'reveal' });
                continue;
            }
            if (state.grid[index] > 0) {
                const around = neighboursOf(state, row, col);
                if (around.filter(other => state.flagged[other]).length === state.grid[index]
                    && around.some(other => !state.revealed[other] && !state.flagged[other])) {
                    moves.push({ row, col, value: 'chord' });
                }
            }
        }
    }
    return moves;
}

function turn(state) {
    return state && !state.over ? 'you' : null;
}

function progress(state) {
    if (!state) {
        return { revealed: 0, safe: 0, flags: 0, mines: 0, won: false };
    }
    return {
        revealed: state.revealed.filter(Boolean).length,
        safe: safeTotal(state),
        flags: state.flagged.filter(Boolean).length,
        mines: state.mines,
        won: Boolean(state.won),
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
            detail: `${done.revealed} of ${done.safe} safe cells uncovered, ${done.mines - done.flags} mines left to find.`,
        };
    }
    if (state.won) {
        return { over: true, winner: 'you', label: 'Field cleared', detail: `Every safe cell uncovered in ${state.moves} moves.` };
    }
    return { over: true, winner: null, label: 'Mine hit', detail: 'A mine went up and the field is lost.' };
}

function describeMove(state, move) {
    const row = Number(move?.row);
    const col = Number(move?.col);
    if (!state || !Number.isInteger(row) || !Number.isInteger(col)) {
        return '';
    }
    const wanted = String(move?.value || 'reveal');
    const where = `row ${row + 1}, column ${col + 1}`;
    if (wanted === 'flag') {
        return `Flagged ${where}`;
    }
    if (wanted === 'chord') {
        return `Opened around ${where}`;
    }
    return `Uncovered ${where}`;
}

/**
 * The visible field. Mine positions are only shown once the game is over.
 */
function promptBoard(state) {
    if (!state) {
        return '';
    }
    const lines = [
        `Minesweeper, ${state.rows} rows by ${state.cols} columns with ${state.mines} mines.`,
        'A number says how many of the eight cells around it hold a mine. Rows are numbered from',
        'the top and columns from the left.',
        '',
        `    ${Array.from({ length: state.cols }, (unused, col) => String(col + 1).padStart(2, ' ')).join('')}`,
    ];
    for (let row = 0; row < state.rows; row++) {
        const cells = [];
        for (let col = 0; col < state.cols; col++) {
            const index = indexAt(state, row, col);
            if (!state.revealed[index]) {
                cells.push(state.flagged[index] ? ' F' : ' .');
                continue;
            }
            const value = state.grid[index];
            cells.push(value === MINE ? ' *' : (value ? ` ${value}` : '  '));
        }
        lines.push(`${String(row + 1).padStart(3, ' ')} ${cells.join('')}`);
    }
    lines.push('');
    const done = progress(state);
    lines.push(state.over
        ? (state.won ? 'The field is cleared.' : 'A mine was hit and the field is lost.')
        : `Progress: ${done.revealed} of ${done.safe} safe cells uncovered.`);
    return lines.join('\n');
}

/**
 * Accepts 'row 3 column 5', 'r3c5', '3,5', '3 5' and a flag instruction anywhere in the text.
 */
function parseMoveReply(state, text) {
    if (!state || state.over) {
        return null;
    }
    const source = String(text || '').toLowerCase();
    if (!source.trim()) {
        return null;
    }
    const value = /flag|mark|mine\b/.test(source) ? 'flag' : 'reveal';
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
        if (inBounds(state, row, col)) {
            return { row, col, value };
        }
    }
    return null;
}

/**
 * A safe cell worth uncovering, preferring one that touches already uncovered ground so the
 * hint stays in the region the player is working on.
 */
function hintCell(state) {
    if (!state || !state.grid.length) {
        return null;
    }
    const isSafeCandidate = index => !state.revealed[index] && !state.flagged[index] && state.grid[index] !== MINE;
    for (let index = 0; index < state.grid.length; index++) {
        if (!isSafeCandidate(index)) {
            continue;
        }
        const row = Math.floor(index / state.cols);
        const col = index % state.cols;
        if (neighboursOf(state, row, col).some(other => state.revealed[other])) {
            return { row, col, value: 'reveal' };
        }
    }
    for (let index = 0; index < state.grid.length; index++) {
        if (isSafeCandidate(index)) {
            return { row: Math.floor(index / state.cols), col: index % state.cols, value: 'reveal' };
        }
    }
    return null;
}

/** Solo puzzle: no seat plays against the reader. */
function pickCpuMove() {
    return null;
}

function hydrate(raw) {
    if (!raw || typeof raw !== 'object' || raw.id !== 'minesweeper') {
        return null;
    }
    const rows = Number(raw.rows);
    const cols = Number(raw.cols);
    const mines = Number(raw.mines);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 5 || rows > 30 || cols < 5 || cols > 30) {
        return null;
    }
    const total = rows * cols;
    if (!Number.isInteger(mines) || mines < 1 || mines > total - 9) {
        return null;
    }
    if (!Number.isInteger(raw.seed) || raw.seed < 1) {
        return null;
    }
    if (!Array.isArray(raw.grid) || raw.grid.length !== total) {
        return null;
    }
    if (!Array.isArray(raw.revealed) || raw.revealed.length !== total) {
        return null;
    }
    if (!Array.isArray(raw.flagged) || raw.flagged.length !== total) {
        return null;
    }
    if (raw.revealed.some(value => typeof value !== 'boolean') || raw.flagged.some(value => typeof value !== 'boolean')) {
        return null;
    }
    if (raw.grid.some(value => !Number.isInteger(value) || value < MINE || value > 8)) {
        return null;
    }
    if (!Number.isInteger(raw.moves) || raw.moves < 0) {
        return null;
    }

    const mineCount = raw.grid.filter(value => value === MINE).length;
    const placed = Boolean(raw.placed);
    if (!placed) {
        // Nothing has been laid yet, so the field must be blank and untouched.
        if (mineCount !== 0 || raw.grid.some(value => value !== 0)) {
            return null;
        }
        if (raw.revealed.some(Boolean) || raw.flagged.some(Boolean)) {
            return null;
        }
    } else if (mineCount !== mines) {
        return null;
    }
    const shape = { rows, cols };
    if (placed) {
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const index = row * cols + col;
                if (raw.grid[index] === MINE) {
                    continue;
                }
                const counted = neighboursOf(shape, row, col).filter(other => raw.grid[other] === MINE).length;
                if (counted !== raw.grid[index]) {
                    return null;
                }
            }
        }
    }
    // A revealed mine means the save is inconsistent unless that mine ended the game.
    for (let index = 0; index < total; index++) {
        if (raw.revealed[index] && raw.grid[index] === MINE && index !== raw.exploded) {
            return null;
        }
        if (raw.revealed[index] && raw.flagged[index]) {
            return null;
        }
    }
    if (raw.exploded !== null && raw.exploded !== undefined) {
        if (!Number.isInteger(raw.exploded) || raw.exploded < 0 || raw.exploded >= total) {
            return null;
        }
        if (raw.grid[raw.exploded] !== MINE) {
            return null;
        }
    }

    const revealedCount = raw.revealed.filter(Boolean).length;
    const won = revealedCount >= total - mines;
    const over = Boolean(raw.over) || won;

    return {
        id: 'minesweeper',
        version: Number.isInteger(raw.version) ? raw.version : 1,
        seed: raw.seed,
        rows,
        cols,
        mines,
        grid: raw.grid.slice(),
        placed,
        revealed: raw.revealed.slice(),
        flagged: raw.flagged.slice(),
        over: Boolean(over),
        won: Boolean(won),
        exploded: Number.isInteger(raw.exploded) ? raw.exploded : null,
        moves: raw.moves,
    };
}

export const RULES = {
    id: 'minesweeper',
    name: 'Minesweeper',
    icon: 'fa-bomb',
    blurb: 'Count the numbers, keep your paws intact.',
    kind: 'solo',
    difficulties: [],
    options: [
        {
            id: 'size',
            label: 'Field size',
            values: [
                { id: 'easy', label: 'Small (8 by 8)' },
                { id: 'normal', label: 'Medium (10 by 10)' },
                { id: 'hard', label: 'Large (14 by 14)' },
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

export const MINESWEEPER_INTERNALS = {
    BOARDS,
    MINE,
    NEIGHBOUR_OFFSETS,
    seededRandom,
    fallbackRandom,
    inBounds,
    indexAt,
    neighboursOf,
    placeMines,
    revealFrom,
    hasWon,
    safeTotal,
};
