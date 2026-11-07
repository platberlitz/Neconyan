import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, CHESS_INTERNALS } from '../public/scripts/neconyan-conversation/games/rules/chess.js';

const { squareIndex, indexOf } = CHESS_INTERNALS;

function play(state, from, to, promotion = null) {
    const move = { from: squareIndex(from), to: squareIndex(to) };
    if (promotion) {
        move.promotion = promotion;
    }
    const next = RULES.applyMove(state, move);
    assert.notEqual(next, state, `${from}${to} should be legal`);
    return next;
}

function boardWith(pieces) {
    const board = Array(64).fill('');
    for (const [square, piece] of Object.entries(pieces)) {
        board[squareIndex(square)] = piece;
    }
    return board;
}

function load(position) {
    return RULES.hydrate({
        id: 'chess',
        version: 1,
        board: boardWith(position.board),
        toMove: position.toMove || 'w',
        you: position.you || 'w',
        castling: position.castling || { wK: false, wQ: false, bK: false, bQ: false },
        enPassant: position.enPassant === undefined ? null : position.enPassant,
        halfmove: position.halfmove || 0,
        fullmove: position.fullmove || 40,
        history: [],
        over: false,
        result: null,
        reason: '',
    });
}

test('a new game starts with the usual twenty moves and white to play', () => {
    const game = RULES.createState({ options: { first: 'you' }, random: () => 0.5 });
    assert.equal(game.toMove, 'w');
    assert.equal(game.you, 'w');
    assert.equal(RULES.turn(game), 'you');
    assert.equal(RULES.legalMoves(game).length, 20);
    assert.deepEqual(Object.keys(game.castling).sort(), ['bK', 'bQ', 'wK', 'wQ']);
    assert.equal(game.board[indexOf(4, 0)], 'wK');
    assert.equal(game.board[indexOf(4, 7)], 'bK');

    const theirs = RULES.createState({ options: { first: 'pal' }, random: () => 0.5 });
    assert.equal(theirs.you, 'b', 'the human takes black when the pal opens');
    assert.equal(RULES.turn(theirs), 'pal');
});

test('fool\'s mate is recorded in notation and ends the game', () => {
    let game = RULES.createState({ random: () => 0.5 });
    game = play(game, 'f2', 'f3');
    game = play(game, 'e7', 'e5');
    game = play(game, 'g2', 'g4');
    game = play(game, 'd8', 'h4');
    assert.equal(game.history.at(-1).san, 'Qh4#');
    assert.equal(game.over, true);
    assert.equal(game.result, 'pal');
    assert.equal(game.reason, 'checkmate');
    assert.equal(RULES.turn(game), null);
    assert.deepEqual(RULES.legalMoves(game), []);
    const status = RULES.status(game);
    assert.equal(status.label, 'Your pal wins');
    assert.equal(status.detail, 'Checkmate.');
    assert.match(RULES.promptBoard(game), /The game is finished/);
});

test('a checking move carries a plus and the status says so', () => {
    let game = RULES.createState({ random: () => 0.5 });
    game = play(game, 'e2', 'e4');
    game = play(game, 'f7', 'f6');
    game = play(game, 'd1', 'h5');
    game = play(game, 'g7', 'g6');
    game = play(game, 'h5', 'g6');
    assert.equal(game.history.at(-1).san, 'Qxg6+');
    assert.equal(game.over, false);
    assert.equal(RULES.status(game).label, 'Check');
    assert.match(RULES.status(game).detail, /the king is in check/);
});

test('castling moves both pieces, records O-O and clears the rights', () => {
    let game = RULES.createState({ random: () => 0.5 });
    game = play(game, 'e2', 'e4');
    game = play(game, 'e7', 'e5');
    game = play(game, 'g1', 'f3');
    game = play(game, 'b8', 'c6');
    game = play(game, 'f1', 'c4');
    game = play(game, 'f8', 'c5');
    const before = game;
    assert.equal(RULES.describeMove(before, { from: squareIndex('e1'), to: squareIndex('g1') }), 'Castled kingside');
    assert.deepEqual(RULES.parseMoveReply(before, 'O-O'), { from: squareIndex('e1'), to: squareIndex('g1'), promotion: null });
    assert.deepEqual(RULES.parseMoveReply(before, '0-0'), { from: squareIndex('e1'), to: squareIndex('g1'), promotion: null });
    game = play(game, 'e1', 'g1');
    assert.equal(game.history.at(-1).san, 'O-O');
    assert.equal(game.board[squareIndex('g1')], 'wK');
    assert.equal(game.board[squareIndex('f1')], 'wR');
    assert.equal(game.board[squareIndex('h1')], '');
    assert.equal(game.castling.wK, false);
    assert.equal(game.castling.wQ, false);
    assert.equal(RULES.parseMoveReply(game, 'O-O'), null, 'you only castle once');
});

test('en passant removes the pawn that walked past', () => {
    let game = RULES.createState({ random: () => 0.5 });
    game = play(game, 'e2', 'e4');
    game = play(game, 'a7', 'a6');
    game = play(game, 'e4', 'e5');
    game = play(game, 'd7', 'd5');
    assert.equal(game.enPassant, squareIndex('d6'));
    const move = RULES.parseMoveReply(game, 'exd6');
    assert.deepEqual(move, { from: squareIndex('e5'), to: squareIndex('d6'), promotion: null });
    game = RULES.applyMove(game, move);
    assert.equal(game.board[squareIndex('d5')], '');
    assert.equal(game.board[squareIndex('d6')], 'wP');
    assert.equal(game.history.at(-1).captured, 'bP');
    assert.equal(game.history.at(-1).san, 'exd6');
    assert.equal(game.enPassant, null);
});

test('a pawn reaching the last rank offers four promotions', () => {
    const game = load({ board: { g7: 'wP', a1: 'wK', a8: 'bK' }, toMove: 'w' });
    assert.notEqual(game, null);
    const promotions = RULES.legalMoves(game).filter(move => move.from === squareIndex('g7') && move.to === squareIndex('g8'));
    assert.equal(promotions.length, 4);
    assert.deepEqual(promotions.map(move => move.promotion).sort(), ['b', 'n', 'q', 'r']);
    assert.deepEqual(RULES.parseMoveReply(game, 'g8=Q'), { from: squareIndex('g7'), to: squareIndex('g8'), promotion: 'q' });
    assert.deepEqual(RULES.parseMoveReply(game, 'g7g8n'), { from: squareIndex('g7'), to: squareIndex('g8'), promotion: 'n' });
    const promoted = RULES.applyMove(game, { from: squareIndex('g7'), to: squareIndex('g8'), promotion: 'q' });
    assert.equal(promoted.board[squareIndex('g8')], 'wQ');
    assert.match(promoted.history.at(-1).san, /^g8=Q/);
});

test('a stalemated king ends the game as a draw, and a mated one does not', () => {
    const stalemate = load({ board: { a8: 'bK', b6: 'wK', d7: 'wN' }, toMove: 'b', you: 'w' });
    assert.notEqual(stalemate, null);
    assert.equal(stalemate.over, true);
    assert.equal(stalemate.result, 'draw');
    assert.equal(stalemate.reason, 'stalemate');
    assert.equal(RULES.status(stalemate).label, 'Draw');
    assert.match(RULES.status(stalemate).detail, /no legal move/);

    const mate = load({ board: { a8: 'bK', b6: 'wK', b7: 'wQ' }, toMove: 'b', you: 'w' });
    assert.notEqual(mate, null);
    assert.equal(mate.over, true);
    assert.equal(mate.result, 'you');
    assert.equal(mate.reason, 'checkmate');
    assert.equal(RULES.status(mate).detail, 'Checkmate.');
});

test('fifty quiet moves and bare kings both end the game as draws', () => {
    const nearlyFifty = load({ board: { a1: 'wK', h8: 'bK', d4: 'wR' }, toMove: 'w', halfmove: 99, fullmove: 80 });
    assert.notEqual(nearlyFifty, null);
    const finished = RULES.applyMove(nearlyFifty, { from: squareIndex('d4'), to: squareIndex('d5') });
    assert.equal(finished.over, true);
    assert.equal(finished.result, 'draw');
    assert.equal(finished.reason, 'fifty move rule');
    assert.match(RULES.status(finished).detail, /without a capture or a pawn move/);

    const bare = load({ board: { a1: 'wK', h8: 'bK' }, toMove: 'w' });
    assert.notEqual(bare, null);
    assert.equal(bare.over, true);
    assert.equal(bare.result, 'draw');
    assert.equal(bare.reason, 'not enough pieces left to mate');
});

test('replies read coordinates, prose and notation', () => {
    const game = RULES.createState({ random: () => 0.5 });
    assert.deepEqual(RULES.parseMoveReply(game, 'e2e4'), { from: squareIndex('e2'), to: squareIndex('e4'), promotion: null });
    assert.deepEqual(RULES.parseMoveReply(game, 'e2-e4'), { from: squareIndex('e2'), to: squareIndex('e4'), promotion: null });
    assert.deepEqual(RULES.parseMoveReply(game, 'I will play e2 to e4.'), { from: squareIndex('e2'), to: squareIndex('e4'), promotion: null });
    assert.deepEqual(RULES.parseMoveReply(game, 'Nf3'), { from: squareIndex('g1'), to: squareIndex('f3'), promotion: null });
    assert.equal(RULES.parseMoveReply(game, 'I resign, well played'), null);
    assert.equal(RULES.parseMoveReply(game, ''), null);
    assert.equal(RULES.parseMoveReply(null, 'e2e4'), null);
    let finished = game;
    for (const move of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
        finished = play(finished, move[0], move[1]);
    }
    assert.equal(RULES.parseMoveReply(finished, 'e2e4'), null);
});

test('the model and the hint only ever offer legal moves', () => {
    const game = RULES.createState({ random: () => 0.5 });
    for (const difficulty of ['easy', 'normal', 'hard']) {
        const move = RULES.pickCpuMove(game, { difficulty, random: () => 0.5 });
        assert.equal(Number.isInteger(move.from), true);
        assert.ok(RULES.legalMoves(game).some(candidate => candidate.from === move.from && candidate.to === move.to),
            `${difficulty} picked a legal move`);
    }
    const finished = load({ board: { a8: 'bK', b6: 'wK', b7: 'wQ' }, toMove: 'b', you: 'w' });
    assert.equal(RULES.pickCpuMove(finished, {}), null, 'a finished game has no move to pick');
    assert.equal(RULES.pickCpuMove(null, {}), null);
    const hint = RULES.hintCell(game);
    assert.ok(RULES.legalMoves(game).some(move => move.from === hint.from && move.to === hint.to));
});

test('the board prompt shows both seats and asks for one move', () => {
    const game = RULES.createState({ options: { first: 'pal' }, random: () => 0.5 });
    const prompt = RULES.promptBoard(game);
    assert.match(prompt, /Chess\./);
    assert.match(prompt, /\+-----------------\+/);
    assert.match(prompt, /a b c d e f g h/);
    assert.match(prompt, /You are to move\./);
    assert.match(prompt, /Answer with one move/);
    assert.equal(RULES.promptBoard(null), '');
});

test('a saved game survives a JSON round trip and rejects impossible positions', () => {
    let game = RULES.createState({ random: () => 0.5 });
    game = play(game, 'f2', 'f3');
    game = play(game, 'e7', 'e5');
    game = play(game, 'g2', 'g4');
    game = play(game, 'd8', 'h4');
    const restored = RULES.hydrate(JSON.parse(JSON.stringify(game)));
    assert.notEqual(restored, null);
    assert.equal(restored.over, true);
    assert.equal(restored.history.length, 4);
    assert.equal(RULES.status(restored).label, 'Your pal wins');

    const raw = JSON.parse(JSON.stringify(game));
    assert.equal(RULES.hydrate(null), null);
    assert.equal(RULES.hydrate({ ...raw, id: 'connect-four' }), null);
    assert.equal(RULES.hydrate({ ...raw, board: Array(10).fill('') }), null);
    assert.equal(RULES.hydrate({ ...raw, board: Array(64).fill('wX') }), null);
    assert.equal(RULES.hydrate({ ...raw, board: Array(64).fill('') }), null, 'no kings');
    assert.equal(RULES.hydrate({ ...raw, board: boardWith({ a1: 'wK', h1: 'wK', h8: 'bK' }) }), null, 'two white kings');
    assert.equal(RULES.hydrate({ ...raw, board: boardWith({ a1: 'wK', h8: 'bK', e8: 'wP' }) }), null, 'a pawn on the last rank');
    assert.equal(RULES.hydrate({ ...raw, board: boardWith({ e1: 'wK', h8: 'bK' }), castling: { wK: true, wQ: false, bK: false, bQ: false } }), null, 'castling without a rook');
    assert.equal(RULES.hydrate({ ...raw, halfmove: 900 }), null);
    assert.equal(RULES.hydrate({ ...raw, enPassant: 99 }), null);
});

test('move generation matches the published counts for the opening position', () => {
    const game = RULES.createState({ random: () => 0.5 });
    const count = (state, depth) => {
        const moves = RULES.legalMoves(state);
        if (depth === 1) {
            return moves.length;
        }
        let total = 0;
        for (const move of moves) {
            total += count(RULES.applyMove(state, move), depth - 1);
        }
        return total;
    };
    assert.equal(count(game, 1), 20);
    assert.equal(count(game, 2), 400);
    assert.equal(count(game, 3), 8902);
});

test('the rules card describes the game and its options', () => {
    assert.equal(RULES.id, 'chess');
    assert.equal(RULES.name, 'Chess');
    assert.equal(RULES.kind, 'versus');
    assert.equal(RULES.icon.startsWith('fa-'), true);
    assert.equal(RULES.difficulties.length, 3);
    assert.equal(RULES.options[0].id, 'first');
    assert.equal(RULES.options[0].default, 'you');
    const state = RULES.createState({ random: () => 0.5 });
    assert.equal(RULES.describeMove(state, { from: squareIndex('e2'), to: squareIndex('e4') }), 'Pawn e2 to e4');
    assert.equal(RULES.describeMove(null, { from: squareIndex('e2'), to: squareIndex('e4') }), '');
});
