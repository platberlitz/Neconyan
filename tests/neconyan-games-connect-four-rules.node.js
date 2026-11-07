import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, CONNECT_FOUR_INTERNALS } from '../public/scripts/neconyan-conversation/games/rules/connect-four.js';

/** A tiny deterministic generator, so tie-breaks in these tests never wander. */
function seeded(seed) {
    let value = seed >>> 0;
    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function drop(state, column) {
    const next = RULES.applyMove(state, { column });
    assert.notEqual(next, state, `column ${column} should be playable`);
    return next;
}

test('Connect Four hands the opening move to whoever was asked for', () => {
    const mine = RULES.createState({ options: { first: 'you' }, random: seeded(1) });
    assert.equal(mine.toPlay, CONNECT_FOUR_INTERNALS.HUMAN);
    assert.equal(RULES.turn(mine), 'you');
    assert.deepEqual(RULES.legalMoves(mine).map(move => move.column), [0, 1, 2, 3, 4, 5, 6]);

    const theirs = RULES.createState({ options: { first: 'pal' }, random: seeded(1) });
    assert.equal(theirs.toPlay, CONNECT_FOUR_INTERNALS.PAL);
    assert.equal(RULES.turn(theirs), 'pal');
});

test('a disc falls to the lowest free cell of its column', () => {
    let game = RULES.createState({ random: seeded(2) });
    game = drop(game, 3);
    assert.equal(CONNECT_FOUR_INTERNALS.dropRow(game.heights, 3), 4);
    game = drop(game, 3);
    assert.equal(game.heights[3], 2);
    assert.equal(game.board[CONNECT_FOUR_INTERNALS.indexAt(5, 3)], CONNECT_FOUR_INTERNALS.HUMAN);
    assert.equal(game.board[CONNECT_FOUR_INTERNALS.indexAt(4, 3)], CONNECT_FOUR_INTERNALS.PAL);
    assert.equal(game.board[CONNECT_FOUR_INTERNALS.indexAt(3, 3)], '');
    assert.equal(game.history.join(''), '33');
    assert.equal(RULES.turn(game), 'you');
});

test('four upright discs end the game for the player who made them', () => {
    let game = RULES.createState({ random: seeded(3) });
    for (const column of [0, 1, 0, 1, 0, 1]) {
        game = drop(game, column);
    }
    game = drop(game, 0);
    assert.equal(game.over, true);
    assert.equal(RULES.turn(game), null);
    assert.deepEqual(RULES.legalMoves(game), []);
    const line = game.winLine;
    assert.equal(line.length, 4);
    assert.ok(line.every(index => game.board[index] === CONNECT_FOUR_INTERNALS.HUMAN));
    const status = RULES.status(game);
    assert.equal(status.over, true);
    assert.equal(status.winner, 'you');
    assert.equal(status.label, 'Four in a row');
    assert.equal(status.detail, 'You lined up four.');
    assert.equal(RULES.promptBoard(game).includes('The game is over.'), true);
});

test('the model seat takes an immediate win before anything else', () => {
    let game = RULES.createState({ options: { first: 'pal' }, random: seeded(4) });
    for (const column of [1, 6, 2, 6, 3, 6]) {
        game = drop(game, column);
    }
    assert.equal(RULES.turn(game), 'pal');
    const move = RULES.pickCpuMove(game, { difficulty: 'normal', random: seeded(5) });
    const after = RULES.applyMove(game, move);
    assert.equal(after.over, true);
    assert.equal(RULES.status(after).winner, 'pal');
});

test('the model seat blocks a four in a row it cannot outrun', () => {
    let game = RULES.createState({ random: seeded(6) });
    for (const column of [6, 0, 6, 2, 6]) {
        game = drop(game, column);
    }
    assert.equal(RULES.turn(game), 'pal');
    assert.equal(RULES.status(game).over, false, 'the human has three upright discs, not four');
    const move = RULES.pickCpuMove(game, { difficulty: 'normal', random: seeded(7) });
    assert.deepEqual(move, { column: 6 }, 'the only column that stops the vertical four');
});

test('an easy seat still picks a legal column', () => {
    const game = RULES.createState({ options: { first: 'pal' }, random: seeded(8) });
    const move = RULES.pickCpuMove(game, { difficulty: 'easy', random: () => 0 });
    assert.deepEqual(move, { column: 0 });
    const withoutRandom = RULES.pickCpuMove(game, { difficulty: 'easy' });
    assert.equal(Number.isInteger(withoutRandom.column), true);
    assert.ok(RULES.legalMoves(game).some(candidate => candidate.column === withoutRandom.column));
    assert.equal(RULES.pickCpuMove(RULES.createState({ random: seeded(9) }), {}), null, 'the human seat is not driven');
});

test('a reply only needs a column number, a word or a zero based digit', () => {
    const game = RULES.createState({ random: seeded(10) });
    assert.deepEqual(RULES.parseMoveReply(game, '4'), { column: 3 });
    assert.deepEqual(RULES.parseMoveReply(game, 'I will take column 5.'), { column: 4 });
    assert.deepEqual(RULES.parseMoveReply(game, 'four'), { column: 3 });
    assert.deepEqual(RULES.parseMoveReply(game, 'seven'), { column: 6 });
    assert.deepEqual(RULES.parseMoveReply(game, '0'), { column: 0 });
    assert.deepEqual(RULES.parseMoveReply(game, 'zero'), { column: 0 });
    assert.equal(RULES.parseMoveReply(game, 'no idea, you pick'), null);
    assert.equal(RULES.parseMoveReply(game, ''), null);
    assert.equal(RULES.parseMoveReply(game, '12'), null, 'a number off the board is not a move');
    let finished = RULES.createState({ random: seeded(11) });
    for (const column of [0, 1, 0, 1, 0, 1, 0]) {
        finished = drop(finished, column);
    }
    assert.equal(RULES.parseMoveReply(finished, '4'), null);
});

test('a saved game survives a JSON round trip and rejects doctored boards', () => {
    let game = RULES.createState({ random: seeded(12) });
    for (const column of [0, 1, 0, 1, 0, 1, 0]) {
        game = drop(game, column);
    }
    const restored = RULES.hydrate(JSON.parse(JSON.stringify(game)));
    assert.notEqual(restored, null);
    assert.equal(restored.over, true);
    assert.equal(RULES.status(restored).winner, 'you');
    assert.deepEqual(restored.winLine, game.winLine);

    assert.equal(RULES.hydrate(null), null);
    assert.equal(RULES.hydrate({ ...JSON.parse(JSON.stringify(game)), id: 'chess' }), null);
    assert.equal(RULES.hydrate({ ...JSON.parse(JSON.stringify(game)), heights: [0] }), null);
    assert.equal(RULES.hydrate({ ...JSON.parse(JSON.stringify(game)), toPlay: 'z' }), null);
    assert.equal(RULES.hydrate({ ...JSON.parse(JSON.stringify(game)), history: [] }), null, 'discs and history disagree');
    assert.equal(RULES.hydrate({ ...JSON.parse(JSON.stringify(game)), winLine: null }), null, 'a win without its line');
    const floating = JSON.parse(JSON.stringify(RULES.createState({ random: seeded(13) })));
    floating.board[0] = CONNECT_FOUR_INTERNALS.HUMAN;
    floating.heights[0] = 1;
    floating.history = [0];
    assert.equal(RULES.hydrate(floating), null, 'a disc cannot float above empty space');
});

test('the rules card describes the game and its options', () => {
    assert.equal(RULES.id, 'connect-four');
    assert.equal(RULES.name, 'Connect Four');
    assert.equal(RULES.kind, 'versus');
    assert.equal(RULES.icon.startsWith('fa-'), true);
    assert.equal(RULES.difficulties.length, 3);
    assert.equal(RULES.options[0].default, 'you');
    assert.equal(RULES.describeMove(null, { column: 2 }), 'Column 3');
    const prompt = RULES.promptBoard(RULES.createState({ options: { first: 'pal' }, random: seeded(14) }));
    assert.match(prompt, /Connect Four on a grid of 7 columns and 6 rows/);
    assert.match(prompt, /Answer with one column number/);
    assert.match(prompt, /Legal columns: 1 2 3 4 5 6 7/);
});
