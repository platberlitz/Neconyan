/**
 * Connect Four rules for Conversation mode games.
 *
 * Pure logic only: no imports, no DOM, no clock and no Math.random(). Everything a caller
 * needs is passed in, and every state is plain JSON so it can be saved and sent to a model.
 *
 * State shape:
 * {
 *   id: 'connect-four',
 *   version: 1,
 *   rows: 6,                      // always 6
 *   cols: 7,                      // always 7
 *   board: string[42],            // row-major, index 0 is the top-left cell, '' | 'r' | 'y'
 *   heights: number[7],           // discs already resting in each column
 *   toPlay: 'r' | 'y',            // 'r' is the human seat, 'y' is the other seat
 *   history: number[],            // dropped columns, zero-based, oldest first
 *   winLine: number[] | null,     // the four winning board indices, row-major
 *   over: boolean,
 *   nonce: number,                // varies a fresh game so two openings look different
 * }
 *
 * A move is { column: 0..6 }. Column numbers shown to a player are 1-based.
 */

const ROWS = 6;
const COLS = 7;
const CELLS = ROWS * COLS;

/** The human seat. */
const HUMAN = 'r';
/** The other seat, driven by the character model, the built-in search or a second player. */
const PAL = 'y';

/** Board symbols used in the text a model reads. */
const SEAT_SYMBOLS = { [HUMAN]: 'O', [PAL]: 'X' };

const WORD_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};

/** Node budgets per difficulty. A budget keeps the search deterministic, unlike a clock. */
const SEARCH_NODES = { normal: 20000, hard: 260000 };
const SEARCH_DEPTH = { normal: 4, hard: 6 };

/** Every four-in-a-row window on the board, precomputed once for the evaluation. */
const WINDOWS = buildWindows();

/**
 * Used only when a caller forgets to pass `random`. It keeps the module free of Math.random
 * and the clock, at the cost of picking the same tie-break order twice in a row.
 */
let fallbackCounter = 0x9E3779B9;
function fallbackRandom() {
    fallbackCounter = (fallbackCounter + 0x6D2B79F5) >>> 0;
    let mixed = fallbackCounter;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

function buildWindows() {
    const windows = [];
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            for (const [dr, dc] of directions) {
                const cells = [];
                for (let step = 0; step < 4; step++) {
                    const targetRow = row + dr * step;
                    const targetCol = col + dc * step;
                    if (targetRow < 0 || targetRow >= ROWS || targetCol < 0 || targetCol >= COLS) {
                        cells.length = 0;
                        break;
                    }
                    cells.push(targetRow * COLS + targetCol);
                }
                if (cells.length === 4) {
                    windows.push(cells);
                }
            }
        }
    }
    return windows;
}

function otherSeat(seat) {
    return seat === HUMAN ? PAL : HUMAN;
}

function seatFromTurn(turn) {
    return turn === 'you' ? HUMAN : PAL;
}

function turnFromSeat(seat) {
    return seat === HUMAN ? 'you' : 'pal';
}

function cloneState(state) {
    return {
        id: state.id,
        version: state.version,
        rows: state.rows,
        cols: state.cols,
        board: state.board.slice(),
        heights: state.heights.slice(),
        toPlay: state.toPlay,
        history: state.history.slice(),
        winLine: state.winLine ? state.winLine.slice() : null,
        over: Boolean(state.over),
    };
}

function indexAt(row, col) {
    return row * COLS + col;
}

function dropRow(heights, col) {
    return ROWS - 1 - heights[col];
}

function isPlayable(heights, col) {
    return col >= 0 && col < COLS && heights[col] < ROWS;
}

function isFull(heights) {
    return heights.every(count => count >= ROWS);
}

function playableColumns(heights) {
    const columns = [];
    for (let col = 0; col < COLS; col++) {
        if (isPlayable(heights, col)) {
            columns.push(col);
        }
    }
    return columns;
}

/**
 * The four winning indices through a freshly placed disc, or null. Checking only the placed
 * cell keeps the search cheap: earlier discs were already checked when they landed.
 */
function winLineThrough(board, row, col) {
    const seat = board[indexAt(row, col)];
    if (!seat) {
        return null;
    }
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
        const cells = [[row, col]];
        for (const step of [1, -1]) {
            let cursorRow = row + dr * step;
            let cursorCol = col + dc * step;
            while (cursorRow >= 0 && cursorRow < ROWS && cursorCol >= 0 && cursorCol < COLS
                && board[indexAt(cursorRow, cursorCol)] === seat) {
                cells.push([cursorRow, cursorCol]);
                cursorRow += dr * step;
                cursorCol += dc * step;
            }
        }
        if (cells.length >= 4) {
            cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            return cells.slice(0, 4).map(([cellRow, cellCol]) => indexAt(cellRow, cellCol));
        }
    }
    return null;
}

/** A full-board scan for a winning line, used when validating a saved state. */
function findAnyWin(board) {
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            if (!board[indexAt(row, col)]) {
                continue;
            }
            const line = winLineThrough(board, row, col);
            if (line) {
                return line;
            }
        }
    }
    return null;
}

function seatOfLine(board, line) {
    if (!Array.isArray(line) || line.length !== 4) {
        return null;
    }
    const seat = board[line[0]];
    return seat && line.every(index => board[index] === seat) ? seat : null;
}

/** Window evaluation from one seat's point of view. */
function evaluateBoard(board, seat) {
    const rival = otherSeat(seat);
    let score = 0;
    for (const window of WINDOWS) {
        let own = 0;
        let theirs = 0;
        for (const index of window) {
            const value = board[index];
            if (value === seat) {
                own++;
            } else if (value === rival) {
                theirs++;
            }
        }
        if (own && theirs) {
            continue;
        }
        if (own) {
            score += own * own * own;
        } else if (theirs) {
            score -= theirs * theirs * theirs;
        }
    }
    // The centre column is worth more than its windows alone suggest.
    for (let row = 0; row < ROWS; row++) {
        const value = board[indexAt(row, 3)];
        if (value === seat) {
            score += 4;
        } else if (value === rival) {
            score -= 4;
        }
    }
    return score;
}

/** Centre-first ordering, which is both the strongest heuristic and the best for pruning. */
const COLUMN_ORDER = [3, 2, 4, 1, 5, 0, 6];

function orderedPlayable(heights) {
    return COLUMN_ORDER.filter(col => isPlayable(heights, col));
}

const WIN_SCORE = 100000;

function negamax(board, heights, seat, depth, alpha, beta, ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.budget) {
        ctx.exhausted = true;
        return 0;
    }
    if (depth <= 0) {
        return evaluateBoard(board, seat);
    }
    let best = -Infinity;
    for (const col of orderedPlayable(heights)) {
        const row = dropRow(heights, col);
        const index = indexAt(row, col);
        board[index] = seat;
        heights[col]++;
        let score;
        if (winLineThrough(board, row, col)) {
            // Winning sooner is better than winning later.
            score = WIN_SCORE + depth;
        } else if (isFull(heights)) {
            score = 0;
        } else {
            score = -negamax(board, heights, otherSeat(seat), depth - 1, -beta, -alpha, ctx);
        }
        board[index] = '';
        heights[col]--;
        if (ctx.exhausted) {
            return 0;
        }
        if (score > best) {
            best = score;
        }
        if (best > alpha) {
            alpha = best;
        }
        if (alpha >= beta) {
            break;
        }
    }
    return best === -Infinity ? evaluateBoard(board, seat) : best;
}

/** The column that wins at once for a seat, or -1. */
function findImmediateWin(board, heights, seat) {
    for (const col of COLUMN_ORDER) {
        if (!isPlayable(heights, col)) {
            continue;
        }
        const row = dropRow(heights, col);
        const index = indexAt(row, col);
        board[index] = seat;
        const wins = Boolean(winLineThrough(board, row, col));
        board[index] = '';
        if (wins) {
            return col;
        }
    }
    return -1;
}

/**
 * Pick a column for a seat with a search. Returns -1 when nothing is playable.
 * @param {string[]} board A working copy the search may mutate
 * @param {number[]} heights A working copy the search may mutate
 * @param {string} seat
 * @param {{ depth: number, budget: number, random: () => number }} config
 */
function searchColumn(board, heights, seat, { depth, budget, random }) {
    const columns = orderedPlayable(heights);
    if (!columns.length) {
        return -1;
    }
    if (columns.length === 1) {
        return columns[0];
    }

    let bestColumns = columns;
    let bestScore = -Infinity;
    // Iterative deepening: each completed pass improves the answer, and a pass that runs out
    // of budget leaves the previous result standing.
    for (let pass = 2; pass <= depth; pass += 2) {
        const ctx = { nodes: 0, budget, exhausted: false };
        const scored = [];
        let passBest = -Infinity;
        for (const col of columns) {
            const row = dropRow(heights, col);
            const index = indexAt(row, col);
            board[index] = seat;
            heights[col]++;
            let score;
            if (winLineThrough(board, row, col)) {
                score = WIN_SCORE + pass;
            } else if (isFull(heights)) {
                score = 0;
            } else {
                score = -negamax(board, heights, otherSeat(seat), pass - 1, -Infinity, Infinity, ctx);
            }
            board[index] = '';
            heights[col]--;
            if (ctx.exhausted) {
                break;
            }
            scored.push({ col, score });
            if (score > passBest) {
                passBest = score;
            }
        }
        if (ctx.exhausted || !scored.length) {
            break;
        }
        bestScore = passBest;
        bestColumns = scored.filter(entry => entry.score === passBest).map(entry => entry.col);
    }

    if (bestScore >= WIN_SCORE) {
        return bestColumns[0];
    }

    // Never hand the opponent an instant win when a safe column exists.
    const safe = bestColumns.filter(col => {
        const row = dropRow(heights, col);
        const index = indexAt(row, col);
        board[index] = seat;
        heights[col]++;
        const givesAway = findImmediateWin(board, heights, otherSeat(seat)) >= 0;
        board[index] = '';
        heights[col]--;
        return !givesAway;
    });
    const pool = safe.length ? safe : bestColumns;
    if (pool.length === 1) {
        return pool[0];
    }
    return pool[Math.floor(random() * pool.length) % pool.length];
}

function createState({ options = {}, random = null } = {}) {
    const first = String(options?.first || 'you') === 'pal' ? PAL : HUMAN;
    return {
        id: 'connect-four',
        // Kept so a caller can vary a fresh game; the starting board is always the same.
        nonce: typeof random === 'function' ? Math.floor(random() * 1000000) : 0,
        version: 1,
        rows: ROWS,
        cols: COLS,
        board: Array.from({ length: CELLS }, () => ''),
        heights: Array.from({ length: COLS }, () => 0),
        toPlay: first,
        history: [],
        winLine: null,
        over: false,
    };
}

function legalMoves(state) {
    if (!state || state.over) {
        return [];
    }
    return playableColumns(state.heights).map(column => ({ column }));
}

function applyMove(state, move) {
    const column = Number(move?.column);
    if (!state || state.over || !Number.isInteger(column) || !isPlayable(state.heights, column)) {
        return state;
    }

    const next = cloneState(state);
    const row = dropRow(next.heights, column);
    const index = indexAt(row, column);
    next.board[index] = next.toPlay;
    next.heights[column]++;
    next.history.push(column);

    const line = winLineThrough(next.board, row, column);
    if (line) {
        next.winLine = line;
        next.over = true;
    } else if (isFull(next.heights)) {
        next.over = true;
    } else {
        next.toPlay = otherSeat(next.toPlay);
    }
    return next;
}

function turn(state) {
    if (!state || state.over) {
        return null;
    }
    return turnFromSeat(state.toPlay);
}

function status(state) {
    if (!state) {
        return { over: false, winner: null, label: '', detail: '' };
    }
    if (!state.over) {
        return {
            over: false,
            winner: null,
            label: '',
            detail: state.toPlay === HUMAN ? 'Your turn to drop.' : 'Waiting on the other side.',
        };
    }
    const seat = seatOfLine(state.board, state.winLine);
    if (!seat) {
        return { over: true, winner: null, label: 'Board full', detail: 'A draw, nobody lined up four.' };
    }
    const winner = turnFromSeat(seat);
    return {
        over: true,
        winner,
        label: 'Four in a row',
        detail: winner === 'you' ? 'You lined up four.' : 'They lined up four.',
    };
}

function describeMove(state, move) {
    const column = Number(move?.column);
    if (!Number.isInteger(column)) {
        return '';
    }
    return `Column ${column + 1}`;
}

function promptBoard(state) {
    if (!state) {
        return '';
    }
    const seat = state.toPlay;
    const symbol = SEAT_SYMBOLS[seat] || '?';
    const rivalSymbol = SEAT_SYMBOLS[otherSeat(seat)] || '?';
    const lines = [
        'Connect Four on a grid of 7 columns and 6 rows.',
        `${rivalSymbol} is the human player, ${symbol} is your seat.`,
        'A disc falls to the lowest free cell of the column you name.',
        'Columns are numbered 1 to 7 from the left. Four in a row wins, sideways, upright or diagonal.',
        '',
    ];
    lines.push(`  ${[1, 2, 3, 4, 5, 6, 7].join(' ')}`);
    for (let row = 0; row < ROWS; row++) {
        const cells = [];
        for (let col = 0; col < COLS; col++) {
            const value = state.board[indexAt(row, col)];
            cells.push(value ? SEAT_SYMBOLS[value] : '.');
        }
        lines.push(`  ${cells.join(' ')}`);
    }
    lines.push('');
    if (state.over) {
        lines.push(`The game is over. ${status(state).label || 'Finished'}: ${status(state).detail}`);
        return lines.join('\n');
    }
    lines.push(`Your seat is ${symbol} and it is your turn.`);
    lines.push(`Legal columns: ${playableColumns(state.heights).map(column => column + 1).join(' ')}`);
    lines.push('Answer with one column number, such as 4.');
    return lines.join('\n');
}

function parseMoveReply(state, text) {
    const moves = legalMoves(state);
    if (!moves.length) {
        return null;
    }
    const source = String(text || '');
    if (!source.trim()) {
        return null;
    }
    const legal = new Set(moves.map(move => move.column));
    const candidates = [];
    for (const match of source.matchAll(/\b([0-7])\b/g)) {
        candidates.push(Number(match[1]));
    }
    for (const match of source.toLowerCase().matchAll(/\b(zero|one|two|three|four|five|six|seven)\b/g)) {
        candidates.push(WORD_NUMBERS[match[1]]);
    }
    for (const value of candidates) {
        // The board is shown 1-based, so read it that way first.
        if (legal.has(value - 1)) {
            return { column: value - 1 };
        }
        // A model that counts from zero gets one more chance with the same digit, which is also
        // how a bare '0' is read as the leftmost column.
        if (legal.has(value)) {
            return { column: value };
        }
    }
    return null;
}

function pickCpuMove(state, { difficulty = 'normal', random = null } = {}) {
    if (!state || state.over || state.toPlay !== PAL) {
        return null;
    }
    const draw = typeof random === 'function' ? random : fallbackRandom;
    const columns = playableColumns(state.heights);
    if (!columns.length) {
        return null;
    }
    if (columns.length === 1) {
        return { column: columns[0] };
    }

    const board = state.board.slice();
    const heights = state.heights.slice();

    const win = findImmediateWin(board, heights, PAL);
    if (win >= 0) {
        return { column: win };
    }

    if (difficulty === 'easy') {
        return { column: columns[Math.floor(draw() * columns.length) % columns.length] };
    }

    const threat = findImmediateWin(board, heights, HUMAN);
    if (threat >= 0) {
        return { column: threat };
    }

    const budget = SEARCH_NODES[difficulty] ?? SEARCH_NODES.normal;
    const depth = SEARCH_DEPTH[difficulty] ?? SEARCH_DEPTH.normal;
    const column = searchColumn(board, heights, PAL, { depth, budget, random: draw });
    if (column < 0) {
        return { column: columns[Math.floor(draw() * columns.length) % columns.length] };
    }
    return { column };
}

function hydrate(raw) {
    if (!raw || typeof raw !== 'object' || raw.id !== 'connect-four') {
        return null;
    }
    const board = raw.board;
    const heights = raw.heights;
    if (!Array.isArray(board) || board.length !== CELLS) {
        return null;
    }
    if (!Array.isArray(heights) || heights.length !== COLS) {
        return null;
    }
    if (board.some(value => value !== '' && value !== HUMAN && value !== PAL)) {
        return null;
    }
    if (heights.some(count => !Number.isInteger(count) || count < 0 || count > ROWS)) {
        return null;
    }
    if (raw.toPlay !== HUMAN && raw.toPlay !== PAL) {
        return null;
    }
    if (!Array.isArray(raw.history) || raw.history.some(column => !Number.isInteger(column) || column < 0 || column >= COLS)) {
        return null;
    }

    // Every disc must rest on the floor or on another disc.
    for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; row++) {
            const filled = Boolean(board[indexAt(row, col)]);
            const belowFloor = row === ROWS - 1;
            if (filled && !belowFloor && !board[indexAt(row + 1, col)]) {
                return null;
            }
        }
        const counted = board.slice(col, CELLS).filter((value, offset) => offset % COLS === 0 && Boolean(value)).length;
        if (counted !== heights[col]) {
            return null;
        }
    }

    const discs = board.filter(Boolean).length;
    if (discs !== raw.history.length) {
        return null;
    }

    const winLine = Array.isArray(raw.winLine) ? raw.winLine : null;
    if (winLine) {
        if (winLine.length !== 4 || winLine.some(index => !Number.isInteger(index) || index < 0 || index >= CELLS)) {
            return null;
        }
        if (!seatOfLine(board, winLine)) {
            return null;
        }
    }
    const actualWin = findAnyWin(board);
    if (Boolean(actualWin) !== Boolean(winLine)) {
        return null;
    }

    const full = isFull(heights);
    if (Boolean(raw.over) !== Boolean(winLine || full)) {
        return null;
    }

    return {
        id: 'connect-four',
        version: Number.isInteger(raw.version) ? raw.version : 1,
        rows: ROWS,
        cols: COLS,
        board: board.slice(),
        heights: heights.slice(),
        toPlay: raw.toPlay,
        nonce: Number.isInteger(raw.nonce) ? raw.nonce : 0,
        history: raw.history.slice(),
        winLine: winLine ? winLine.slice() : (actualWin ? actualWin.slice() : null),
        over: Boolean(raw.over),
    };
}

export const RULES = {
    id: 'connect-four',
    name: 'Connect Four',
    icon: 'fa-circle-dot',
    blurb: 'Drop discs, line up four, gloat about it.',
    kind: 'versus',
    difficulties: [
        { id: 'easy', label: 'Easy' },
        { id: 'normal', label: 'Normal' },
        { id: 'hard', label: 'Hard' },
    ],
    options: [
        {
            id: 'first',
            label: 'Who drops first',
            values: [{ id: 'you', label: 'You' }, { id: 'pal', label: 'Your pal' }],
            default: 'you',
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
};

export const CONNECT_FOUR_INTERNALS = {
    ROWS,
    COLS,
    HUMAN,
    PAL,
    winLineThrough,
    findImmediateWin,
    evaluateBoard,
    indexAt,
    dropRow,
    isPlayable,
    playableColumns,
    seatFromTurn,
};
