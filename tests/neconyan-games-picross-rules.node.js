import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, PICROSS_INTERNALS } from '../public/scripts/neconyan-conversation/games/rules/picross.js';

/** A tiny deterministic generator, so the same puzzle comes out of the same seed. */
function seeded(seed) {
    let value = seed >>> 0;
    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function paint(state, row, col) {
    return RULES.applyMove(state, { row, col, value: 'paint' });
}

function solve(state) {
    let next = state;
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            if (state.answer[row * state.cols + col]) {
                next = paint(next, row, col);
            }
        }
    }
    return next;
}

test('Picross offers three puzzle sizes and never starts solved', () => {
    const small = RULES.createState({ options: { size: 'easy' }, random: seeded(1) });
    assert.deepEqual([small.rows, small.cols], [5, 5]);
    const medium = RULES.createState({ options: {}, random: seeded(1) });
    assert.deepEqual([medium.rows, medium.cols], [10, 10]);
    const large = RULES.createState({ options: { size: 'hard' }, random: seeded(1) });
    assert.deepEqual([large.rows, large.cols], [15, 15]);

    assert.equal(small.over, false);
    assert.equal(small.solved, false);
    assert.equal(RULES.turn(small), 'you');
    const moves = RULES.legalMoves(small);
    assert.equal(moves.length, small.answer.filter(Boolean).length, 'the suggested moves are the cells still to paint');
    assert.equal(moves.every(move => small.answer[move.row * small.cols + move.col] === 1), true);
    assert.equal(moves.every(move => move.value === 'paint'), true);
    assert.equal(RULES.pickCpuMove(small, {}), null, 'a solo puzzle has no model seat');
});

test('the clues describe the hidden answer and are all the player sees', () => {
    const game = RULES.createState({ options: { size: 'easy' }, random: seeded(2) });
    const { rowClues, colClues } = PICROSS_INTERNALS.buildClues(game.answer, game.rows, game.cols);
    assert.deepEqual(game.rowClues, rowClues);
    assert.deepEqual(game.colClues, colClues);
    for (let row = 0; row < game.rows; row++) {
        const filled = game.answer.slice(row * game.cols, row * game.cols + game.cols)
            .filter(Boolean).length;
        const clues = game.rowClues[row].reduce((sum, value) => sum + value, 0);
        assert.equal(clues, filled, `row ${row + 1} clues add up to its filled cells`);
    }
    const prompt = RULES.promptBoard(game);
    assert.match(prompt, /Column clues:/);
    assert.match(prompt, /Row clues and the grid so far/);
    assert.equal(prompt.includes('answer'), false, 'the answer is never printed');
});

test('painting, marking and clearing change one cell at a time', () => {
    let game = RULES.createState({ options: { size: 'easy' }, random: seeded(3) });
    const before = game.cells.slice();
    game = paint(game, 1, 2);
    assert.equal(game.cells[1 * game.cols + 2], PICROSS_INTERNALS.PAINTED);
    assert.equal(game.moves, 1);
    assert.equal(game.cells.filter((value, index) => value !== before[index]).length, 1);

    game = RULES.applyMove(game, { row: 1, col: 2, value: 'mark' });
    assert.equal(game.cells[1 * game.cols + 2], PICROSS_INTERNALS.MARKED);
    assert.equal(game.moves, 2);

    game = RULES.applyMove(game, { row: 1, col: 2, value: 'clear' });
    assert.equal(game.cells[1 * game.cols + 2], PICROSS_INTERNALS.UNTOUCHED);
    assert.equal(game.moves, 3);

    const same = RULES.applyMove(game, { row: 1, col: 2, value: 'clear' });
    assert.equal(same, game, 'clearing an empty cell is not a move');
    assert.equal(RULES.applyMove(game, { row: 99, col: 0, value: 'paint' }), game);
    assert.equal(RULES.applyMove(game, { row: 0, col: 0, value: 'scribble' }), game);
});

test('a solved grid ends the puzzle and stops accepting taps', () => {
    let game = RULES.createState({ options: { size: 'easy' }, random: seeded(4) });
    assert.equal(RULES.status(game).over, false);
    game = solve(game);
    assert.equal(game.solved, true);
    assert.equal(game.over, true);
    assert.equal(RULES.turn(game), null);
    assert.deepEqual(RULES.legalMoves(game), []);
    const status = RULES.status(game);
    assert.equal(status.over, true);
    assert.equal(status.winner, 'you');
    assert.equal(status.label, 'Puzzle solved');
    assert.match(status.detail, /Every clue reads correctly/);
    assert.equal(RULES.progress(game).rowsDone, game.rows);
    assert.equal(RULES.progress(game).colsDone, game.cols);
    assert.equal(RULES.hintCell(game), null, 'nothing left to hint at');
    const after = paint(game, 0, 0);
    assert.equal(after, game);
});

test('marks are notes, not answers, so the puzzle waits for paint', () => {
    let game = RULES.createState({ options: { size: 'easy' }, random: seeded(5) });
    for (let row = 0; row < game.rows; row++) {
        for (let col = 0; col < game.cols; col++) {
            game = RULES.applyMove(game, { row, col, value: 'mark' });
        }
    }
    assert.equal(game.solved, false);
    assert.equal(game.over, false);
    assert.equal(RULES.progress(game).painted, 0);
});

test('a hint points at a cell that still needs work', () => {
    let game = RULES.createState({ options: { size: 'easy' }, random: seeded(6) });
    const hint = RULES.hintCell(game);
    assert.notEqual(hint, null);
    assert.equal(hint.value, 'paint');
    const index = hint.row * game.cols + hint.col;
    assert.equal(game.answer[index], 1, 'the hint names a filled cell of the answer');
    assert.notEqual(game.cells[index], PICROSS_INTERNALS.PAINTED);

    // Painted where it should be empty: the puzzle still wants a correction, so the hint says clear.
    const stray = game.answer.findIndex(value => value === 0);
    const strayRow = Math.floor(stray / game.cols);
    const strayCol = stray % game.cols;
    game = paint(game, strayRow, strayCol);
    for (let row = 0; row < game.rows; row++) {
        for (let col = 0; col < game.cols; col++) {
            if (game.answer[row * game.cols + col]) {
                game = paint(game, row, col);
            }
        }
    }
    assert.equal(game.solved, false, 'the stray paint keeps the clues out of step');
    const clear = RULES.hintCell(game);
    assert.deepEqual(clear, { row: strayRow, col: strayCol, value: 'clear' });
});

test('progress counts the rows and columns that already read correctly', () => {
    const game = RULES.createState({ options: { size: 'easy' }, random: seeded(7) });
    const empty = RULES.progress(game);
    assert.equal(empty.painted, 0);
    assert.equal(empty.total, 25);
    assert.equal(empty.rowsTotal, 5);
    assert.equal(empty.colsTotal, 5);
    const solved = RULES.progress(solve(game));
    assert.equal(solved.solved, true);
    assert.equal(solved.painted, game.answer.filter(Boolean).length);
});

test('a reply reads row and column from prose, lists or shorthand', () => {
    const game = RULES.createState({ options: { size: 'normal' }, random: seeded(8) });
    assert.deepEqual(RULES.parseMoveReply(game, 'row 3 column 4'), { row: 2, col: 3, value: 'paint' });
    assert.deepEqual(RULES.parseMoveReply(game, 'r2c1'), { row: 1, col: 0, value: 'paint' });
    assert.deepEqual(RULES.parseMoveReply(game, '5,6'), { row: 4, col: 5, value: 'paint' });
    assert.deepEqual(RULES.parseMoveReply(game, '7 2'), { row: 6, col: 1, value: 'paint' });
    assert.deepEqual(RULES.parseMoveReply(game, 'mark row 1 column 1'), { row: 0, col: 0, value: 'mark' });
    assert.equal(RULES.parseMoveReply(game, 'no idea'), null);
    assert.equal(RULES.parseMoveReply(game, 'row 40 column 40'), null);
    assert.equal(RULES.parseMoveReply(game, ''), null);
});

test('a saved puzzle survives a JSON round trip and rejects edited clues', () => {
    const game = solve(RULES.createState({ options: { size: 'easy' }, random: seeded(9) }));
    const restored = RULES.hydrate(JSON.parse(JSON.stringify(game)));
    assert.notEqual(restored, null);
    assert.equal(restored.solved, true);
    assert.equal(RULES.status(restored).label, 'Puzzle solved');
    assert.deepEqual(restored.answer, game.answer);

    const raw = () => JSON.parse(JSON.stringify(game));
    assert.equal(RULES.hydrate(null), null);
    assert.equal(RULES.hydrate({ ...raw(), id: 'minesweeper' }), null);
    assert.equal(RULES.hydrate({ ...raw(), rows: 99 }), null);
    assert.equal(RULES.hydrate({ ...raw(), answer: [1, 0, 1] }), null);
    assert.equal(RULES.hydrate({ ...raw(), answer: raw().answer.map(() => 2) }), null);
    assert.equal(RULES.hydrate({ ...raw(), cells: raw().cells.map(() => 9) }), null);
    assert.equal(RULES.hydrate({ ...raw(), moves: -1 }), null);
    const doctored = raw();
    doctored.rowClues[0] = [9];
    assert.equal(RULES.hydrate(doctored), null, 'clues must describe the stored answer');
});

test('the rules card describes the puzzle and its options', () => {
    assert.equal(RULES.id, 'picross');
    assert.equal(RULES.name, 'Picross');
    assert.equal(RULES.kind, 'solo');
    assert.equal(RULES.icon.startsWith('fa-'), true);
    assert.deepEqual(RULES.difficulties, []);
    assert.equal(RULES.options[0].id, 'size');
    assert.equal(RULES.options[0].default, 'normal');
    assert.equal(RULES.options[0].compact, 'easy', 'phones start on the smallest puzzle');
    const state = RULES.createState({ options: { size: 'easy' }, random: seeded(10) });
    assert.equal(RULES.describeMove(state, { row: 0, col: 0, value: 'paint' }), 'Painted row 1, column 1');
    assert.equal(RULES.describeMove(state, { row: 1, col: 1, value: 'mark' }), 'Marked row 2, column 2');
    assert.equal(RULES.describeMove(state, { row: 1, col: 1, value: 'clear' }), 'Cleared row 2, column 2');
    assert.equal(RULES.describeMove(null, { row: 0, col: 0, value: 'paint' }), '');
});
