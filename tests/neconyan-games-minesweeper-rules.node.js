import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, MINESWEEPER_INTERNALS } from '../public/scripts/neconyan-conversation/games/rules/minesweeper.js';

const { MINE } = MINESWEEPER_INTERNALS;

/** A tiny deterministic generator, so every field in these tests is the same one twice. */
function seeded(seed) {
    let value = seed >>> 0;
    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function fresh(size = 'easy') {
    return RULES.createState({ options: { size }, random: seeded(7) });
}

function reveal(state, row, col) {
    return RULES.applyMove(state, { row, col, value: 'reveal' });
}

function mineIndexes(state) {
    return state.grid.map((value, index) => (value === MINE ? index : -1)).filter(index => index >= 0);
}

test('each field size comes with its own mine count and an untouched grid', () => {
    const small = RULES.createState({ options: { size: 'easy' }, random: seeded(1) });
    assert.deepEqual([small.rows, small.cols, small.mines], [8, 8, 10]);
    const medium = RULES.createState({ options: {}, random: seeded(1) });
    assert.deepEqual([medium.rows, medium.cols, medium.mines], [10, 10, 16]);
    const large = RULES.createState({ options: { size: 'hard' }, random: seeded(1) });
    assert.deepEqual([large.rows, large.cols, large.mines], [14, 14, 32]);

    assert.equal(medium.placed, false);
    assert.equal(medium.over, false);
    assert.equal(medium.revealed.some(Boolean), false);
    assert.equal(medium.grid.every(value => value === 0), true);
    assert.equal(RULES.turn(medium), 'you');
    assert.equal(RULES.legalMoves(medium).length, 100);
    assert.equal(RULES.pickCpuMove(medium, {}), null, 'a solo puzzle has no model seat');
});

test('the first reveal lays the mines somewhere else and never on the opening cell', () => {
    let game = fresh();
    game = reveal(game, 3, 3);
    assert.equal(game.placed, true);
    assert.equal(game.over, false);
    assert.equal(mineIndexes(game).length, game.mines);
    const opening = 3 * game.cols + 3;
    assert.equal(game.revealed[opening], true);
    assert.equal(game.grid[opening], 0, 'the opening cell is always blank');
    for (const other of MINESWEEPER_INTERNALS.neighboursOf(game, 3, 3)) {
        assert.notEqual(game.grid[other], MINE, 'nor is a neighbour mined');
        assert.equal(game.revealed[other], true, 'a blank opening cell opens its neighbours');
    }
    // The numbers must agree with the mines around them.
    for (let row = 0; row < game.rows; row++) {
        for (let col = 0; col < game.cols; col++) {
            const index = row * game.cols + col;
            if (game.grid[index] === MINE) {
                continue;
            }
            const counted = MINESWEEPER_INTERNALS.neighboursOf(game, row, col)
                .filter(other => game.grid[other] === MINE).length;
            assert.equal(game.grid[index], counted);
        }
    }
});

test('a flag goes on and off, but never onto an open cell', () => {
    let game = reveal(fresh(), 0, 0);
    const hidden = game.revealed.findIndex(value => !value);
    assert.ok(hidden >= 0);
    const hiddenRow = Math.floor(hidden / game.cols);
    const hiddenCol = hidden % game.cols;
    game = RULES.applyMove(game, { row: hiddenRow, col: hiddenCol, value: 'flag' });
    assert.equal(game.flagged[hidden], true);
    assert.equal(game.moves, 2);
    game = RULES.applyMove(game, { row: hiddenRow, col: hiddenCol, value: 'flag' });
    assert.equal(game.flagged[hidden], false);
    assert.equal(RULES.applyMove(game, { row: 0, col: 0, value: 'flag' }), game, 'an open cell is settled');
    assert.equal(game.revealed[0], true);
    assert.equal(RULES.applyMove(game, { row: hiddenRow, col: hiddenCol, value: 'dig' }), game);
    assert.equal(RULES.applyMove(game, { row: 99, col: 1, value: 'reveal' }), game);
});

test('opening around a numbered cell needs the right number of flags', () => {
    let game = fresh('normal');
    game = reveal(game, 4, 4);
    const numbered = [];
    for (let row = 0; row < game.rows; row++) {
        for (let col = 0; col < game.cols; col++) {
            const index = row * game.cols + col;
            if (game.revealed[index] && game.grid[index] > 0) {
                numbered.push({ row, col, index });
            }
        }
    }
    assert.ok(numbered.length > 0, 'a medium field shows some numbers after the first reveal');
    const target = numbered[0];
    assert.equal(RULES.applyMove(game, { row: target.row, col: target.col, value: 'chord' }), game,
        'no flags means nothing to open');

    const around = MINESWEEPER_INTERNALS.neighboursOf(game, target.row, target.col);
    const mines = around.filter(index => game.grid[index] === MINE);
    for (const index of mines) {
        game = RULES.applyMove(game, { row: Math.floor(index / game.cols), col: index % game.cols, value: 'flag' });
    }
    const before = game.revealed.filter(Boolean).length;
    game = RULES.applyMove(game, { row: target.row, col: target.col, value: 'chord' });
    assert.equal(game.over, false);
    assert.ok(game.revealed.filter(Boolean).length >= before, 'opening around the number reveals more ground');
});

test('a mine ends the game and shows the field', () => {
    let game = reveal(fresh(), 0, 0);
    const mine = mineIndexes(game).find(index => !game.revealed[index]);
    assert.notEqual(mine, undefined);
    game = reveal(game, Math.floor(mine / game.cols), mine % game.cols);
    assert.equal(game.over, true);
    assert.equal(game.won, false);
    assert.equal(game.exploded, mine);
    assert.equal(game.revealed[mine], true);
    const status = RULES.status(game);
    assert.equal(status.label, 'Mine hit');
    assert.equal(status.winner, null);
    assert.match(RULES.promptBoard(game), /A mine was hit and the field is lost\./);
});

test('clearing every safe cell wins and flags the rest', () => {
    let game = reveal(fresh(), 0, 0);
    for (let index = 0; index < game.grid.length && !game.over; index++) {
        if (game.grid[index] !== MINE && !game.revealed[index]) {
            game = reveal(game, Math.floor(index / game.cols), index % game.cols);
        }
    }
    assert.equal(game.over, true);
    assert.equal(game.won, true);
    assert.equal(game.revealed.filter(Boolean).length >= game.rows * game.cols - game.mines, true);
    assert.equal(mineIndexes(game).every(index => game.flagged[index]), true);
    const status = RULES.status(game);
    assert.equal(status.label, 'Field cleared');
    assert.equal(status.winner, 'you');
    assert.equal(RULES.progress(game).won, true);
    assert.equal(RULES.hintCell(game), null);
    assert.match(RULES.promptBoard(game), /The field is cleared\./);
});

test('a hint points at a safe cell and the field prompt hides the mines', () => {
    let game = reveal(fresh(), 4, 4);
    const hint = RULES.hintCell(game);
    assert.notEqual(hint, null);
    assert.deepEqual(hint, { ...hint, value: 'reveal' });
    const index = hint.row * game.cols + hint.col;
    assert.equal(game.revealed[index], false);
    assert.notEqual(game.grid[index], MINE);
    const prompt = RULES.promptBoard(game);
    assert.equal(prompt.includes('*'), false, 'mines stay hidden while the field is live');
    assert.match(prompt, /Minesweeper, 8 rows by 8 columns with 10 mines\./);
    assert.match(prompt, /Progress: /);
});

test('a reply reads row and column from prose, lists or shorthand', () => {
    const game = fresh('normal');
    assert.deepEqual(RULES.parseMoveReply(game, 'row 3 column 5'), { row: 2, col: 4, value: 'reveal' });
    assert.deepEqual(RULES.parseMoveReply(game, 'r4c2'), { row: 3, col: 1, value: 'reveal' });
    assert.deepEqual(RULES.parseMoveReply(game, '6,7'), { row: 5, col: 6, value: 'reveal' });
    assert.deepEqual(RULES.parseMoveReply(game, '9 3'), { row: 8, col: 2, value: 'reveal' });
    assert.deepEqual(RULES.parseMoveReply(game, 'flag row 2 column 2'), { row: 1, col: 1, value: 'flag' });
    assert.equal(RULES.parseMoveReply(game, 'no idea'), null);
    assert.equal(RULES.parseMoveReply(game, 'row 40 column 1'), null);
    assert.equal(RULES.parseMoveReply(game, ''), null);
});

test('a saved field survives a JSON round trip and rejects a doctored grid', () => {
    let game = reveal(fresh(), 2, 2);
    game = RULES.applyMove(game, { row: 0, col: 0, value: 'flag' });
    const restored = RULES.hydrate(JSON.parse(JSON.stringify(game)));
    assert.notEqual(restored, null);
    assert.deepEqual(restored.grid, game.grid);
    assert.deepEqual(restored.revealed, game.revealed);
    assert.equal(restored.placed, true);
    assert.equal(restored.moves, game.moves);

    const raw = () => JSON.parse(JSON.stringify(game));
    assert.equal(RULES.hydrate(null), null);
    assert.equal(RULES.hydrate({ ...raw(), id: 'picross' }), null);
    assert.equal(RULES.hydrate({ ...raw(), rows: 99 }), null);
    assert.equal(RULES.hydrate({ ...raw(), grid: [0, 0] }), null);
    assert.equal(RULES.hydrate({ ...raw(), revealed: raw().revealed.map(() => 'yes') }), null);
    assert.equal(RULES.hydrate({ ...raw(), moves: -1 }), null);
    const blank = raw();
    blank.placed = false;
    blank.grid = blank.grid.map(() => 0);
    blank.revealed = blank.revealed.map(() => false);
    blank.flagged = blank.flagged.map(() => false);
    assert.notEqual(RULES.hydrate(blank), null, 'an untouched field loads before the first reveal');

    const miscounted = raw();
    const target = mineIndexes(game).find(index => game.grid[index] === MINE);
    miscounted.grid[target] = 0;
    assert.equal(RULES.hydrate(miscounted), null, 'the numbers must match the mines');

    const openedMine = raw();
    openedMine.revealed = openedMine.revealed.map(() => false);
    openedMine.revealed[mineIndexes(game)[0]] = true;
    assert.equal(RULES.hydrate(openedMine), null, 'a revealed mine needs the loss that explains it');
});

test('the rules card describes the puzzle and its options', () => {
    assert.equal(RULES.id, 'minesweeper');
    assert.equal(RULES.name, 'Minesweeper');
    assert.equal(RULES.kind, 'solo');
    assert.equal(RULES.icon.startsWith('fa-'), true);
    assert.deepEqual(RULES.difficulties, []);
    assert.equal(RULES.options[0].id, 'size');
    assert.equal(RULES.options[0].default, 'normal');
    assert.equal(RULES.options[0].compact, 'easy', 'phones start on the smallest field');
    const state = fresh();
    assert.equal(RULES.describeMove(state, { row: 0, col: 0, value: 'reveal' }), 'Uncovered row 1, column 1');
    assert.equal(RULES.describeMove(state, { row: 0, col: 0, value: 'flag' }), 'Flagged row 1, column 1');
    assert.equal(RULES.describeMove(state, { row: 0, col: 0, value: 'chord' }), 'Opened around row 1, column 1');
    assert.equal(RULES.describeMove(null, { row: 0, col: 0, value: 'reveal' }), '');
});
