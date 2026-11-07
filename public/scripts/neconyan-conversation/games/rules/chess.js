/**
 * Chess rules for Conversation mode games.
 *
 * Pure logic only: no imports, no DOM, no clock and no Math.random(). A caller supplies the
 * `random` function where one is needed, and the search is deterministic.
 *
 * Squares are stored in a flat 64 entry array, index 0 = a8 through index 63 = h1, so a board
 * prints in reading order. A piece is a two character code such as 'wP' or 'bK', and an empty
 * square is ''.
 *
 * State shape:
 * {
 *   id: 'chess',
 *   version: 1,
 *   board: string[],
 *   toMove: 'w' | 'b',
 *   you: 'w' | 'b',          // which side the reader plays
 *   castling: { wK, wQ, bK, bQ },
 *   enPassant: number|null,  // index of the square a capturing pawn would land on
 *   halfmove: number,        // plies since the last pawn move or capture
 *   fullmove: number,
 *   history: [{ from, to, piece, captured, promotion, san }],
 *   over: boolean,
 *   result: 'you' | 'pal' | 'draw' | null,
 *   reason: string,
 * }
 *
 * A move is { from, to, promotion? }. Castling is expressed as the king moving two files, and
 * the rook follows.
 */

const FILES = 'abcdefgh';
const EMPTY = '';
const PIECE_VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DELTAS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DELTAS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// Difficulty settings. Depths count plies; the node budget keeps a slow phone responsive.
const SEARCH = {
    easy: { depth: 1, budget: 400, randomness: 1 },
    normal: { depth: 2, budget: 12000, randomness: 0 },
    hard: { depth: 3, budget: 90000, randomness: 0 },
};

/** Piece-square tables, read from white's point of view with index 0 = a8. */
const PAWN_TABLE = [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT_TABLE = [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
];
const KING_TABLE = [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
];

function fileOf(index) {
    return index % 8;
}

function rankOf(index) {
    return 7 - Math.floor(index / 8);
}

function indexOf(file, rank) {
    return (7 - rank) * 8 + file;
}

function onBoard(file, rank) {
    return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function squareName(index) {
    if (!Number.isInteger(index) || index < 0 || index > 63) {
        return '';
    }
    return `${FILES[fileOf(index)]}${rankOf(index) + 1}`;
}

function squareIndex(name) {
    const text = String(name || '').trim().toLowerCase();
    const match = text.match(/^([a-h])([1-8])$/);
    if (!match) {
        return -1;
    }
    return indexOf(FILES.indexOf(match[1]), Number(match[2]) - 1);
}

function sideOf(piece) {
    return piece ? piece[0] : null;
}

function typeOf(piece) {
    return piece ? piece[1] : null;
}

function otherSide(side) {
    return side === 'w' ? 'b' : 'w';
}

function startingBoard() {
    const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    const board = Array.from({ length: 64 }, () => EMPTY);
    for (let file = 0; file < 8; file++) {
        board[indexOf(file, 7)] = `b${back[file]}`;
        board[indexOf(file, 6)] = 'bP';
        board[indexOf(file, 1)] = 'wP';
        board[indexOf(file, 0)] = `w${back[file]}`;
    }
    return board;
}

function createState({ options = {}, random = null } = {}) {
    const you = String(options?.first || 'you') === 'pal' ? 'b' : 'w';
    const draw = typeof random === 'function' ? random : null;
    return {
        id: 'chess',
        version: 1,
        board: startingBoard(),
        toMove: 'w',
        you,
        castling: { wK: true, wQ: true, bK: true, bQ: true },
        enPassant: null,
        halfmove: 0,
        fullmove: 1,
        // Reserved so two games can differ even though chess always starts the same way.
        nonce: draw ? Math.floor(draw() * 1000000) : 0,
        history: [],
        over: false,
        result: null,
        reason: '',
    };
}

/** The state a search works on: no history, so cloning stays cheap. */
function searchState(state) {
    return {
        board: state.board,
        toMove: state.toMove,
        castling: state.castling,
        enPassant: state.enPassant,
        halfmove: state.halfmove,
    };
}

function cloneSearch(state) {
    return {
        board: state.board.slice(),
        toMove: state.toMove,
        castling: { ...state.castling },
        enPassant: state.enPassant,
        halfmove: state.halfmove,
    };
}

function kingSquare(board, side) {
    const target = `${side}K`;
    for (let index = 0; index < 64; index++) {
        if (board[index] === target) {
            return index;
        }
    }
    return -1;
}

/** True when `bySide` attacks `index`. */
function isSquareAttacked(board, index, bySide) {
    if (index < 0 || index > 63) {
        return false;
    }
    const file = fileOf(index);
    const rank = rankOf(index);

    // Pawns attack one rank towards the defender.
    const pawnRank = bySide === 'w' ? rank - 1 : rank + 1;
    for (const pawnFile of [file - 1, file + 1]) {
        if (onBoard(pawnFile, pawnRank) && board[indexOf(pawnFile, pawnRank)] === `${bySide}P`) {
            return true;
        }
    }

    for (const [df, dr] of KNIGHT_DELTAS) {
        const nf = file + df;
        const nr = rank + dr;
        if (onBoard(nf, nr) && board[indexOf(nf, nr)] === `${bySide}N`) {
            return true;
        }
    }

    for (const [df, dr] of KING_DELTAS) {
        const nf = file + df;
        const nr = rank + dr;
        if (onBoard(nf, nr) && board[indexOf(nf, nr)] === `${bySide}K`) {
            return true;
        }
    }

    for (const [df, dr] of ROOK_DELTAS) {
        let nf = file + df;
        let nr = rank + dr;
        while (onBoard(nf, nr)) {
            const piece = board[indexOf(nf, nr)];
            if (piece) {
                if (sideOf(piece) === bySide && (typeOf(piece) === 'R' || typeOf(piece) === 'Q')) {
                    return true;
                }
                break;
            }
            nf += df;
            nr += dr;
        }
    }

    for (const [df, dr] of BISHOP_DELTAS) {
        let nf = file + df;
        let nr = rank + dr;
        while (onBoard(nf, nr)) {
            const piece = board[indexOf(nf, nr)];
            if (piece) {
                if (sideOf(piece) === bySide && (typeOf(piece) === 'B' || typeOf(piece) === 'Q')) {
                    return true;
                }
                break;
            }
            nf += df;
            nr += dr;
        }
    }

    return false;
}

function inCheck(state, side) {
    const square = kingSquare(state.board, side);
    return square >= 0 && isSquareAttacked(state.board, square, otherSide(side));
}

/** Every move the pieces could make, ignoring whether the king is left in check. */
function pseudoMoves(state, side) {
    const { board } = state;
    const moves = [];
    const push = (from, to, promotion = null) => {
        moves.push(promotion ? { from, to, promotion } : { from, to });
    };
    const empty = index => board[index] === EMPTY;
    const enemy = index => board[index] !== EMPTY && sideOf(board[index]) !== side;

    for (let from = 0; from < 64; from++) {
        const piece = board[from];
        if (!piece || sideOf(piece) !== side) {
            continue;
        }
        const type = typeOf(piece);
        const file = fileOf(from);
        const rank = rankOf(from);

        if (type === 'P') {
            const forward = side === 'w' ? 1 : -1;
            const startRank = side === 'w' ? 1 : 6;
            const promoteRank = side === 'w' ? 7 : 0;
            const oneRank = rank + forward;
            if (onBoard(file, oneRank)) {
                const one = indexOf(file, oneRank);
                if (empty(one)) {
                    if (oneRank === promoteRank) {
                        for (const promotion of ['q', 'r', 'b', 'n']) {
                            push(from, one, promotion);
                        }
                    } else {
                        push(from, one);
                        const twoRank = rank + forward * 2;
                        if (rank === startRank && onBoard(file, twoRank)) {
                            const two = indexOf(file, twoRank);
                            if (empty(two)) {
                                push(from, two);
                            }
                        }
                    }
                }
            }
            for (const captureFile of [file - 1, file + 1]) {
                if (!onBoard(captureFile, oneRank)) {
                    continue;
                }
                const target = indexOf(captureFile, oneRank);
                if (enemy(target)) {
                    if (oneRank === promoteRank) {
                        for (const promotion of ['q', 'r', 'b', 'n']) {
                            push(from, target, promotion);
                        }
                    } else {
                        push(from, target);
                    }
                } else if (empty(target) && target === state.enPassant) {
                    push(from, target);
                }
            }
            continue;
        }

        if (type === 'N' || type === 'K') {
            const deltas = type === 'N' ? KNIGHT_DELTAS : KING_DELTAS;
            for (const [df, dr] of deltas) {
                const nf = file + df;
                const nr = rank + dr;
                if (!onBoard(nf, nr)) {
                    continue;
                }
                const target = indexOf(nf, nr);
                if (empty(target) || enemy(target)) {
                    push(from, target);
                }
            }
            if (type === 'K') {
                for (const move of castlingMoves(state, side, from)) {
                    moves.push(move);
                }
            }
            continue;
        }

        const deltas = type === 'R' ? ROOK_DELTAS : type === 'B' ? BISHOP_DELTAS : [...ROOK_DELTAS, ...BISHOP_DELTAS];
        for (const [df, dr] of deltas) {
            let nf = file + df;
            let nr = rank + dr;
            while (onBoard(nf, nr)) {
                const target = indexOf(nf, nr);
                if (empty(target)) {
                    push(from, target);
                } else {
                    if (enemy(target)) {
                        push(from, target);
                    }
                    break;
                }
                nf += df;
                nr += dr;
            }
        }
    }

    return moves;
}

function castlingMoves(state, side, from) {
    const rank = side === 'w' ? 0 : 7;
    if (from !== indexOf(4, rank)) {
        return [];
    }
    if (inCheck(state, side)) {
        return [];
    }
    const enemy = otherSide(side);
    const moves = [];
    const kingSideRight = side === 'w' ? state.castling.wK : state.castling.bK;
    const queenSideRight = side === 'w' ? state.castling.wQ : state.castling.bQ;

    if (kingSideRight
        && state.board[indexOf(5, rank)] === EMPTY
        && state.board[indexOf(6, rank)] === EMPTY
        && state.board[indexOf(7, rank)] === `${side}R`
        && !isSquareAttacked(state.board, indexOf(5, rank), enemy)
        && !isSquareAttacked(state.board, indexOf(6, rank), enemy)) {
        moves.push({ from, to: indexOf(6, rank), castling: 'K' });
    }
    if (queenSideRight
        && state.board[indexOf(1, rank)] === EMPTY
        && state.board[indexOf(2, rank)] === EMPTY
        && state.board[indexOf(3, rank)] === EMPTY
        && state.board[indexOf(0, rank)] === `${side}R`
        && !isSquareAttacked(state.board, indexOf(3, rank), enemy)
        && !isSquareAttacked(state.board, indexOf(2, rank), enemy)) {
        moves.push({ from, to: indexOf(2, rank), castling: 'Q' });
    }
    return moves;
}

/**
 * Play a move onto a mutable search state. Returns the information needed to undo it.
 */
function makeSearchMove(state, move) {
    const { board } = state;
    const piece = board[move.from];
    const side = sideOf(piece);
    const captured = board[move.to];
    const undo = {
        piece,
        captured,
        castling: { ...state.castling },
        enPassant: state.enPassant,
        halfmove: state.halfmove,
        enPassantCapture: -1,
        rookFrom: -1,
        rookTo: -1,
        rook: EMPTY,
    };

    board[move.from] = EMPTY;
    board[move.to] = move.promotion ? `${side}${move.promotion.toUpperCase()}` : piece;

    // En passant removes a pawn sitting beside the destination, not on it.
    if (typeOf(piece) === 'P' && move.to === state.enPassant && captured === EMPTY) {
        const takenRank = side === 'w' ? rankOf(move.to) - 1 : rankOf(move.to) + 1;
        undo.enPassantCapture = indexOf(fileOf(move.to), takenRank);
        undo.captured = board[undo.enPassantCapture];
        board[undo.enPassantCapture] = EMPTY;
    }

    if (typeOf(piece) === 'K' && Math.abs(fileOf(move.from) - fileOf(move.to)) === 2) {
        const rank = rankOf(move.from);
        const kingSide = fileOf(move.to) === 6;
        undo.rookFrom = indexOf(kingSide ? 7 : 0, rank);
        undo.rookTo = indexOf(kingSide ? 5 : 3, rank);
        undo.rook = board[undo.rookFrom];
        board[undo.rookTo] = undo.rook;
        board[undo.rookFrom] = EMPTY;
    }

    state.enPassant = null;
    if (typeOf(piece) === 'P' && Math.abs(rankOf(move.from) - rankOf(move.to)) === 2) {
        state.enPassant = indexOf(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2);
    }

    // Castling rights fall away when a king or a corner rook moves, or a corner rook is taken.
    if (typeOf(piece) === 'K') {
        if (side === 'w') {
            state.castling.wK = false;
            state.castling.wQ = false;
        } else {
            state.castling.bK = false;
            state.castling.bQ = false;
        }
    }
    const corner = { 63: 'wK', 56: 'wQ', 7: 'bK', 0: 'bQ' };
    for (const square of [move.from, move.to]) {
        const right = corner[square];
        if (right) {
            state.castling[right] = false;
        }
    }

    state.halfmove = (typeOf(piece) === 'P' || captured !== EMPTY) ? 0 : state.halfmove + 1;
    state.toMove = otherSide(side);
    return undo;
}

function unmakeSearchMove(state, move, undo) {
    const { board } = state;
    board[move.from] = undo.piece;
    board[move.to] = undo.captured;
    if (undo.enPassantCapture >= 0) {
        board[undo.enPassantCapture] = `${sideOf(undo.piece)}P`;
        board[move.to] = EMPTY;
    }
    if (undo.rookFrom >= 0) {
        board[undo.rookFrom] = undo.rook;
        board[undo.rookTo] = EMPTY;
    }
    state.castling = undo.castling;
    state.enPassant = undo.enPassant;
    state.halfmove = undo.halfmove;
    state.toMove = sideOf(undo.piece);
}

/** Fully legal moves for the side to move, or for `side` when it is asked for. */
function legalMoves(state, side = state.toMove) {
    if (!state || !Array.isArray(state.board) || state.board.length !== 64) {
        return [];
    }
    if (state.over && side === state.toMove) {
        return [];
    }
    const worker = cloneSearch(searchState(state));
    worker.toMove = side;
    const moves = [];
    for (const move of pseudoMoves(worker, side)) {
        const undo = makeSearchMove(worker, move);
        if (!inCheck(worker, side)) {
            moves.push(move.promotion ? { from: move.from, to: move.to, promotion: move.promotion } : { from: move.from, to: move.to });
        }
        unmakeSearchMove(worker, move, undo);
    }
    return moves;
}

function turn(state) {
    if (!state || state.over) {
        return null;
    }
    return state.toMove === state.you ? 'you' : 'pal';
}

function insufficientMaterial(board) {
    const pieces = board.filter(piece => piece !== EMPTY).map(typeOf);
    const kings = pieces.filter(type => type === 'K').length;
    const minors = pieces.filter(type => type === 'N' || type === 'B').length;
    if (kings !== 2) {
        return false;
    }
    return pieces.length - kings === 0 || (pieces.length - kings === minors && minors <= 1);
}

/**
 * Set the end-of-game fields on a state whose `toMove` side has just been left to play.
 */
function settleEnd(state, legal) {
    if (legal.length) {
        return state;
    }
    state.over = true;
    if (inCheck(state, state.toMove)) {
        const winnerSide = otherSide(state.toMove);
        state.result = winnerSide === state.you ? 'you' : 'pal';
        state.reason = 'checkmate';
    } else {
        state.result = 'draw';
        state.reason = 'stalemate';
    }
    return state;
}

function applyMove(state, move) {
    if (!state || state.over) {
        return state;
    }
    if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to)) {
        return state;
    }
    if (move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63 || move.from === move.to) {
        return state;
    }
    const legal = legalMoves(state);
    const wanted = legal.find(candidate => candidate.from === move.from
        && candidate.to === move.to
        && (!move.promotion || candidate.promotion === String(move.promotion)[0].toLowerCase()));
    if (!wanted) {
        return state;
    }

    const next = {
        ...state,
        board: state.board.slice(),
        castling: { ...state.castling },
        history: state.history.slice(),
    };
    const worker = cloneSearch(searchState(next));
    const piece = next.board[wanted.from];
    const san = moveToSan(worker, wanted, legal);
    makeSearchMove(worker, wanted);

    next.board = worker.board;
    next.castling = worker.castling;
    next.enPassant = worker.enPassant;
    next.halfmove = worker.halfmove;
    next.toMove = worker.toMove;
    next.fullmove = state.toMove === 'b' ? state.fullmove + 1 : state.fullmove;

    // A move that mates ends the game by mate, so check that before the fifty move rule.
    const replies = legalMoves(next);
    const settled = replies.length ? (settleHalfmoveEnd(next) ?? next) : settleEnd(next, replies);
    next.history = [...state.history, {
        from: wanted.from,
        to: wanted.to,
        piece,
        captured: (state.board[wanted.to]
            || (typeOf(piece) === 'P' && wanted.to === state.enPassant
                ? `${otherSide(sideOf(piece))}P`
                : null)),
        promotion: wanted.promotion || null,
        san: san + sanSuffix(settled),
    }];
    return settled;
}

/** Ends the game on the fifty move rule or when neither side has the pieces to mate. */
function settleHalfmoveEnd(state) {
    if (state.halfmove >= 100) {
        state.over = true;
        state.result = 'draw';
        state.reason = 'fifty move rule';
        return state;
    }
    if (insufficientMaterial(state.board)) {
        state.over = true;
        state.result = 'draw';
        state.reason = 'not enough pieces left to mate';
        return state;
    }
    return null;
}

/**
 * The reason a finished position ended, worked out from the position itself, so a stored
 * game with a missing or stale reason still says 'checkmate' when the king is mated.
 */
function derivedEndReason(shape, legal) {
    if (!legal.length) {
        return inCheck(shape, shape.toMove) ? 'checkmate' : 'stalemate';
    }
    if (shape.halfmove >= 100) {
        return 'fifty move rule';
    }
    if (insufficientMaterial(shape.board)) {
        return 'not enough pieces left to mate';
    }
    return '';
}

function sanSuffix(state) {
    if (state.over && state.reason === 'checkmate') {
        return '#';
    }
    return inCheck(state, state.toMove) ? '+' : '';
}

/** Short algebraic notation, enough to announce a move in the timeline. */
function moveToSan(state, move, legal) {
    const piece = state.board[move.from];
    const type = typeOf(piece);
    const side = sideOf(piece);
    const capture = state.board[move.to] !== EMPTY
        || (type === 'P' && move.to === state.enPassant);
    const destination = squareName(move.to);

    if (type === 'K' && Math.abs(fileOf(move.from) - fileOf(move.to)) === 2) {
        return fileOf(move.to) === 6 ? 'O-O' : 'O-O-O';
    }
    if (type === 'P') {
        const promoted = move.promotion ? `=${move.promotion.toUpperCase()}` : '';
        return capture ? `${FILES[fileOf(move.from)]}x${destination}${promoted}` : `${destination}${promoted}`;
    }

    const same = (legal || []).filter(other => other.from !== move.from
        && other.to === move.to
        && typeOf(state.board[other.from]) === type
        && sideOf(state.board[other.from]) === side);
    let disambiguation = '';
    if (same.length) {
        const sameFile = same.some(other => fileOf(other.from) === fileOf(move.from));
        const sameRank = same.some(other => rankOf(other.from) === rankOf(move.from));
        if (!sameFile) {
            disambiguation = FILES[fileOf(move.from)];
        } else if (!sameRank) {
            disambiguation = String(rankOf(move.from) + 1);
        } else {
            disambiguation = squareName(move.from);
        }
    }
    return `${type.toUpperCase()}${disambiguation}${capture ? 'x' : ''}${destination}`;
}

function evaluate(board) {
    let score = 0;
    for (let index = 0; index < 64; index++) {
        const piece = board[index];
        if (!piece) {
            continue;
        }
        const side = sideOf(piece);
        const type = typeOf(piece);
        // Tables are written for white, so black reads them flipped upside down. Xor with 56
        // mirrors the rank while keeping the file.
        const tableIndex = side === 'w' ? index : (index ^ 56);
        let value = PIECE_VALUES[type] || 0;
        if (type === 'P') {
            value += PAWN_TABLE[tableIndex];
        } else if (type === 'N') {
            value += KNIGHT_TABLE[tableIndex];
        } else if (type === 'K') {
            value += KING_TABLE[tableIndex];
        }
        score += side === 'w' ? value : -value;
    }
    return score;
}

function orderedMoves(state, moves) {
    // Captures first, biggest victim and smallest attacker, so a shallow search sees them early.
    return moves.slice().sort((a, b) => moveScore(state, b) - moveScore(state, a));
}

function moveScore(state, move) {
    const victim = state.board[move.to];
    const attacker = state.board[move.from];
    let score = 0;
    if (victim) {
        score += 10 * (PIECE_VALUES[typeOf(victim)] || 0) - (PIECE_VALUES[typeOf(attacker)] || 0);
    }
    if (move.promotion) {
        score += PIECE_VALUES[move.promotion.toUpperCase()] || 0;
    }
    return score;
}

function negamax(state, depth, alpha, beta, ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.budget) {
        ctx.exhausted = true;
    }
    if (ctx.exhausted) {
        return 0;
    }

    const moves = legalMoves(state);
    if (!moves.length) {
        if (inCheck(state, state.toMove)) {
            // Being mated is worse the sooner it happens, so depth is added rather than ignored.
            return -(100000 + depth);
        }
        return 0;
    }
    if (depth <= 0) {
        const score = evaluate(state.board);
        return state.toMove === 'w' ? score : -score;
    }

    let best = -Infinity;
    for (const move of orderedMoves(state, moves)) {
        const worker = cloneSearch(state);
        const undo = makeSearchMove(worker, move);
        const score = -negamax(worker, depth - 1, -beta, -alpha, ctx);
        unmakeSearchMove(worker, move, undo);
        if (ctx.exhausted) {
            return best === -Infinity ? 0 : best;
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
    return best;
}

function pickCpuMove(state, { difficulty = 'normal', random = null } = {}) {
    if (!state || state.over) {
        return null;
    }
    const side = state.toMove;
    const moves = legalMoves(state);
    if (!moves.length) {
        return null;
    }
    const settings = SEARCH[String(difficulty)] ?? SEARCH.normal;
    const draw = typeof random === 'function' ? random : null;

    if (settings.randomness && draw) {
        // Easy play is a coin toss between a good move and a merely legal one.
        const worker = cloneSearch(searchState(state));
        const scored = moves.map(move => {
            const probe = cloneSearch(worker);
            const undo = makeSearchMove(probe, move);
            const value = evaluate(probe.board);
            unmakeSearchMove(probe, move, undo);
            return { move, value: side === 'w' ? value : -value };
        });
        const best = Math.max(...scored.map(entry => entry.value));
        const pool = scored.filter(entry => entry.value >= best - 90);
        const chosen = pool.length > 1 && draw() < 0.6
            ? moves[Math.floor(draw() * moves.length) % moves.length]
            : pool[Math.floor(draw() * pool.length) % pool.length].move;
        return { from: chosen.from, to: chosen.to, promotion: chosen.promotion || null };
    }

    const ctx = { nodes: 0, budget: settings.budget, exhausted: false };
    let best = null;
    let bestScore = -Infinity;
    // Shallow passes first, so a truncated search still keeps the previous pass's best move.
    for (let depth = 1; depth <= settings.depth; depth++) {
        let passBest = null;
        let passScore = -Infinity;
        let alpha = -Infinity;
        for (const move of orderedMoves(searchState(state), moves)) {
            const worker = cloneSearch(searchState(state));
            const undo = makeSearchMove(worker, move);
            const score = -negamax(worker, depth - 1, -Infinity, -alpha, ctx);
            unmakeSearchMove(worker, move, undo);
            if (ctx.exhausted) {
                break;
            }
            if (score > passScore) {
                passScore = score;
                passBest = move;
            }
            if (score > alpha) {
                alpha = score;
            }
        }
        if (ctx.exhausted || !passBest) {
            break;
        }
        best = passBest;
        bestScore = passScore;
    }

    if (!best) {
        best = moves[0];
    }
    return { from: best.from, to: best.to, promotion: best.promotion || null, score: bestScore };
}

function status(state) {
    if (!state) {
        return { over: false, winner: null, label: '', detail: '' };
    }
    if (!state.over) {
        const checking = inCheck(state, state.toMove);
        const seat = state.toMove === state.you ? 'Your' : 'Your pal\'s';
        return {
            over: false,
            winner: null,
            label: checking ? 'Check' : '',
            detail: `${seat} move, ${state.fullmove}${checking ? ', and the king is in check' : ''}.`,
        };
    }
    if (state.result === 'draw') {
        return { over: true, winner: null, label: 'Draw', detail: describeReason(state.reason) };
    }
    const winner = state.result === 'you' ? 'You win' : 'Your pal wins';
    return { over: true, winner: state.result, label: winner, detail: describeReason(state.reason) };
}

function describeReason(reason) {
    switch (String(reason)) {
        case 'checkmate': return 'Checkmate.';
        case 'stalemate': return 'Stalemate: the side to move has no legal move and is not in check.';
        case 'fifty move rule': return 'Fifty moves passed without a capture or a pawn move.';
        default: return String(reason || '');
    }
}

function describeMove(state, move) {
    if (!state || !move) {
        return '';
    }
    const piece = state.board[move?.from] || '';
    const names = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
    const namesLong = { P: 'Pawn', N: 'Knight', B: 'Bishop', R: 'Rook', Q: 'Queen', K: 'King' };
    const type = typeOf(piece);
    if (type === 'K' && Math.abs(fileOf(move.from) - fileOf(move.to)) === 2) {
        return fileOf(move.to) === 6 ? 'Castled kingside' : 'Castled queenside';
    }
    const captured = state.board[move.to] !== EMPTY;
    return `${namesLong[type] || 'Piece'} ${squareName(move.from)} to ${squareName(move.to)}`
        + (captured ? `, taking the ${names[typeOf(state.board[move.to])] || 'piece'}` : '')
        + (move.promotion ? `, promoted to a ${names[String(move.promotion).toUpperCase()] || 'queen'}` : '');
}

function promptBoard(state) {
    if (!state) {
        return '';
    }
    const glyphs = {
        wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
        bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
    };
    const lines = [
        'Chess. Uppercase pieces are the human player and lowercase pieces are your seat.',
        'Files run a to h from the left and ranks run 8 at the top down to 1.',
        '',
        '  +-----------------+',
    ];
    for (let rank = 7; rank >= 0; rank--) {
        const cells = [];
        for (let file = 0; file < 8; file++) {
            const piece = state.board[indexOf(file, rank)];
            cells.push(piece ? glyphs[piece] : '.');
        }
        lines.push(`${rank + 1} | ${cells.join(' ')} |`);
    }
    lines.push('  +-----------------+');
    lines.push('    a b c d e f g h');
    lines.push('');
    if (state.over) {
        lines.push(`The game is finished: ${status(state).label}. ${status(state).detail}`);
        return lines.join('\n');
    }
    const seat = state.toMove === state.you ? 'The human player is to move.' : 'You are to move.';
    lines.push(seat + (inCheck(state, state.toMove) ? ' The king is in check.' : ''));
    if (state.toMove !== state.you) {
        const moves = legalMoves(state).map(move => squareName(move.from) + squareName(move.to)
            + (move.promotion ? `=${move.promotion}` : ''));
        lines.push(`Legal moves: ${moves.join(', ')}`);
        lines.push('Answer with one move in the form e2e4, or in notation such as Nf3 or O-O.');
    }
    return lines.join('\n');
}

/**
 * Reads a move out of a reply. Coordinate forms come first because they are unambiguous:
 * 'e2e4', 'e2-e4', 'e2 to e4'. Notation is matched against the legal move list, so 'Nf3',
 * 'exd5', 'e8=Q', 'O-O' and '0-0' all work when exactly one legal move matches.
 */
function parseMoveReply(state, text) {
    if (!state || state.over) {
        return null;
    }
    const source = String(text || '').trim();
    if (!source) {
        return null;
    }
    const moves = legalMoves(state);
    if (!moves.length) {
        return null;
    }

    // 'e2e4' has no separator, so the split form is tried first and the tight form second.
    const coordinate = source.match(/\b([a-h][1-8])\s*(?:-|to|:|\s|>)\s*([a-h][1-8])\b/i)
        || source.match(/\b([a-h][1-8])([a-h][1-8])([qrbn])?\b/i);
    if (coordinate) {
        const from = squareIndex(coordinate[1]);
        const to = squareIndex(coordinate[2]);
        const found = moves.filter(move => move.from === from && move.to === to);
        if (found.length === 1) {
            return { from, to, promotion: found[0].promotion || null };
        }
        if (found.length > 1) {
            const asked = coordinate[3] || source.match(/=\s*([qrbn])\b/i)?.[1];
            const wanted = String(asked || 'q').toLowerCase();
            const pick = found.find(move => (move.promotion || 'q') === wanted) || found[0];
            return { from, to, promotion: pick.promotion || null };
        }
    }

    // Notation. Compare against the notation each legal move would produce.
    const worker = cloneSearch(searchState(state));
    const normalise = value => String(value || '')
        .replace(/[#!?+]/g, '')
        .replace(/0-0/g, 'O-O')
        .replace(/o-o-o/g, 'O-O-O')
        .replace(/x/g, '')
        .replace(/=/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    const wanted = normalise(source.match(/\b(O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)\b/i)?.[1] || '');
    if (!wanted) {
        return null;
    }
    const matches = moves.filter(move => normalise(moveToSan(worker, move, moves)) === wanted);
    if (matches.length === 1) {
        return { from: matches[0].from, to: matches[0].to, promotion: matches[0].promotion || null };
    }
    // Several promotions can share a stem, so narrow on the asked piece and default to a queen.
    const promotion = source.toLowerCase().match(/=\s*([qrbn])\b/)?.[1] || 'q';
    const narrowed = matches.filter(move => (move.promotion || null) === (matches[0].promotion ? promotion : null));
    if (narrowed.length >= 1) {
        return { from: narrowed[0].from, to: narrowed[0].to, promotion: narrowed[0].promotion || null };
    }
    return null;
}

function hintCell(state) {
    const move = pickCpuMove(state, { difficulty: 'normal' });
    return move ? { from: move.from, to: move.to, promotion: move.promotion || null } : null;
}

function hydrate(raw) {
    if (!raw || typeof raw !== 'object' || raw.id !== 'chess') {
        return null;
    }
    if (!Array.isArray(raw.board) || raw.board.length !== 64) {
        return null;
    }
    const pattern = /^([wb])([PNBRQK])$/;
    for (const piece of raw.board) {
        if (piece !== EMPTY && !(typeof piece === 'string' && pattern.test(piece))) {
            return null;
        }
    }
    if (raw.toMove !== 'w' && raw.toMove !== 'b') {
        return null;
    }
    if (raw.you !== 'w' && raw.you !== 'b') {
        return null;
    }
    if (!Number.isInteger(raw.halfmove) || raw.halfmove < 0 || raw.halfmove > 200) {
        return null;
    }
    if (!Number.isInteger(raw.fullmove) || raw.fullmove < 1 || raw.fullmove > 600) {
        return null;
    }
    if (raw.enPassant !== null && raw.enPassant !== undefined
        && (!Number.isInteger(raw.enPassant) || raw.enPassant < 0 || raw.enPassant > 63)) {
        return null;
    }
    const castling = raw.castling;
    if (!castling || typeof castling !== 'object') {
        return null;
    }
    for (const key of ['wK', 'wQ', 'bK', 'bQ']) {
        if (typeof castling[key] !== 'boolean') {
            return null;
        }
    }
    if (!Array.isArray(raw.history) || raw.history.length > 400) {
        return null;
    }
    for (const entry of raw.history) {
        if (!entry || typeof entry !== 'object'
            || !Number.isInteger(entry.from) || entry.from < 0 || entry.from > 63
            || !Number.isInteger(entry.to) || entry.to < 0 || entry.to > 63) {
            return null;
        }
    }

    // Exactly one king each, and the side that is not to move must not be able to take a king.
    const kings = { w: 0, b: 0 };
    for (const piece of raw.board) {
        if (typeOf(piece) === 'K') {
            kings[sideOf(piece)]++;
        }
    }
    if (kings.w !== 1 || kings.b !== 1) {
        return null;
    }
    // Pawns never sit on the first or last rank.
    for (let file = 0; file < 8; file++) {
        if (typeOf(raw.board[indexOf(file, 0)]) === 'P' || typeOf(raw.board[indexOf(file, 7)]) === 'P') {
            return null;
        }
    }

    const shape = searchState({
        board: raw.board,
        toMove: raw.toMove,
        castling,
        enPassant: Number.isInteger(raw.enPassant) ? raw.enPassant : null,
        halfmove: raw.halfmove,
    });
    // The side that just moved cannot have left its own king in check.
    if (inCheck(shape, otherSide(raw.toMove))) {
        return null;
    }
    // A castling right needs the king and that rook still on their starting squares.
    const rankOfSide = side => (side === 'w' ? 0 : 7);
    for (const side of ['w', 'b']) {
        const rank = rankOfSide(side);
        const kingHome = raw.board[indexOf(4, rank)] === `${side}K`;
        if ((castling[`${side}K`] && (!kingHome || raw.board[indexOf(7, rank)] !== `${side}R`))
            || (castling[`${side}Q`] && (!kingHome || raw.board[indexOf(0, rank)] !== `${side}R`))) {
            return null;
        }
    }
    // En passant only makes sense directly after a double pawn push by the side that just moved.
    if (Number.isInteger(raw.enPassant)) {
        const mover = otherSide(raw.toMove);
        const rank = rankOf(raw.enPassant);
        // The pawn that just doubled sits one rank beyond the square it passed through.
        const pawnRank = mover === 'w' ? rank + 1 : rank - 1;
        const file = fileOf(raw.enPassant);
        if (rank !== 2 && rank !== 5) {
            return null;
        }
        if (raw.board[raw.enPassant] !== EMPTY
            || !onBoard(file, pawnRank)
            || raw.board[indexOf(file, pawnRank)] !== `${mover}P`) {
            return null;
        }
    }

    const legal = legalMoves(shape);
    const over = Boolean(raw.over) || !legal.length || raw.halfmove >= 100 || insufficientMaterial(raw.board);

    return {
        id: 'chess',
        version: Number.isInteger(raw.version) ? raw.version : 1,
        board: raw.board.slice(),
        toMove: raw.toMove,
        you: raw.you,
        castling: { wK: castling.wK, wQ: castling.wQ, bK: castling.bK, bQ: castling.bQ },
        enPassant: Number.isInteger(raw.enPassant) ? raw.enPassant : null,
        halfmove: raw.halfmove,
        fullmove: raw.fullmove,
        nonce: Number.isInteger(raw.nonce) ? raw.nonce : 0,
        history: raw.history.map(entry => ({
            from: entry.from,
            to: entry.to,
            piece: typeof entry.piece === 'string' ? entry.piece : null,
            captured: typeof entry.captured === 'string' ? entry.captured : null,
            promotion: typeof entry.promotion === 'string' ? entry.promotion : null,
            san: typeof entry.san === 'string' ? entry.san : '',
        })),
        over,
        result: over ? normaliseResult(raw, legal) : null,
        reason: over ? (derivedEndReason(shape, legal) || String(raw.reason || '')) : '',
    };
}

function normaliseResult(raw, legal) {
    if (raw.result === 'draw') {
        return 'draw';
    }
    if (raw.result === 'you' || raw.result === 'pal') {
        return raw.result;
    }
    if (!legal.length) {
        return inCheck(searchState(raw), raw.toMove)
            ? (otherSide(raw.toMove) === raw.you ? 'you' : 'pal')
            : 'draw';
    }
    return 'draw';
}

export const RULES = {
    id: 'chess',
    name: 'Chess',
    icon: 'fa-chess',
    blurb: 'Sixty-four squares, nine lives, one very smug queen.',
    kind: 'versus',
    difficulties: [
        { id: 'easy', label: 'Easy', detail: 'Loose play, plenty of gifts left on the board.' },
        { id: 'normal', label: 'Normal', detail: 'Looks two plies ahead and takes free pieces.' },
        { id: 'hard', label: 'Hard', detail: 'Looks three plies ahead with captures first.' },
    ],
    options: [
        {
            id: 'first',
            label: 'Who moves first',
            values: [
                { id: 'you', label: 'You play white' },
                { id: 'pal', label: 'Your pal plays white' },
            ],
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
    hintCell,
};

export const CHESS_INTERNALS = {
    FILES,
    SEARCH,
    PIECE_VALUES,
    fileOf,
    rankOf,
    indexOf,
    squareName,
    squareIndex,
    sideOf,
    typeOf,
    otherSide,
    startingBoard,
    searchState,
    cloneSearch,
    kingSquare,
    isSquareAttacked,
    inCheck,
    pseudoMoves,
    castlingMoves,
    makeSearchMove,
    unmakeSearchMove,
    insufficientMaterial,
    moveToSan,
    evaluate,
    orderedMoves,
    negamax,
    describeReason,
};
