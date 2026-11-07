import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationGamesContext, testExports } from '../public/scripts/neconyan-conversation/games/prompt-context.js';
import { RULES as CHESS, CHESS_INTERNALS } from '../public/scripts/neconyan-conversation/games/rules/chess.js';
import { RULES as CONNECT_FOUR } from '../public/scripts/neconyan-conversation/games/rules/connect-four.js';
import { RULES as PICROSS } from '../public/scripts/neconyan-conversation/games/rules/picross.js';

const { squareIndex } = CHESS_INTERNALS;
const { joinNames } = testExports;

/** A tiny deterministic generator; a constant 0.5 makes Picross build an empty picture. */
function seeded(seed) {
    let value = seed >>> 0;
    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

const USER = 'Kris';
const PAL = 'Durable Nova';
const NAMES = { charName: PAL, palNames: [PAL], userName: USER };

function record(rules, state) {
    return { version: 1, id: rules.id, difficulty: 'normal', options: {}, state: JSON.parse(JSON.stringify(state)), startedAt: Date.now(), finishedNoted: false };
}

function playChess(state, from, to) {
    const next = CHESS.applyMove(state, { from: squareIndex(from), to: squareIndex(to) });
    assert.notEqual(next, state, `${from}${to} should be legal`);
    return next;
}

function drop(state, column) {
    const next = CONNECT_FOUR.applyMove(state, { column });
    assert.notEqual(next, state, `column ${column} should be playable`);
    return next;
}

test('a fresh versus chess game tells the character the seats and whose turn it is', () => {
    const state = CHESS.createState({ random: () => 0.5 });
    const context = buildConversationGamesContext(record(CHESS, state), NAMES);
    assert.match(context, /a game of Chess is being played in this DM right now, Durable Nova against Kris\./);
    assert.match(context, /Kris plays White, the uppercase pieces\. Durable Nova plays Black, the lowercase pieces\./);
    assert.match(context, /It is Kris's turn to move next\./);
    assert.match(context, /Current board:/);
    assert.match(context, /\+-----------------\+/);
    assert.match(context, /never inside your replies/);
    assert.ok(!context.includes('Answer with one move'), 'the chat prompt must not read like a move request');
});

test('a pal-first chess game flips the seat colours in the context', () => {
    const state = CHESS.createState({ options: { first: 'pal' }, random: () => 0.5 });
    const context = buildConversationGamesContext(record(CHESS, state), NAMES);
    assert.match(context, /Kris plays Black, the lowercase pieces\. Durable Nova plays White, the uppercase pieces\./);
    assert.match(context, /It is your side's turn to move next\./);
});

test('a chess game in progress names the last mover and flags check', () => {
    let state = CHESS.createState({ random: () => 0.5 });
    state = playChess(state, 'e2', 'e4');
    const context = buildConversationGamesContext(record(CHESS, state), NAMES);
    assert.match(context, /It is your side's turn to move next\./);
    assert.match(context, /Last move: Kris played e4\./);

    // 1. e4 e5 2. Qh5 Nf6 3. Qxe5+ leaves the pal side in check, still playing.
    let checking = CHESS.createState({ random: () => 0.5 });
    checking = playChess(checking, 'e2', 'e4');
    checking = playChess(checking, 'e7', 'e5');
    checking = playChess(checking, 'd1', 'h5');
    checking = playChess(checking, 'g8', 'f6');
    checking = playChess(checking, 'h5', 'e5');
    assert.equal(checking.over, false);
    const checkContext = buildConversationGamesContext(record(CHESS, checking), NAMES);
    assert.match(checkContext, /It is your side's turn to move next\. The king is in check\./);
    assert.match(checkContext, /Last move: Kris played Qxe5/);

    // Fool's mate: Black, the pal seat, wins.
    let mate = CHESS.createState({ random: () => 0.5 });
    mate = playChess(mate, 'f2', 'f3');
    mate = playChess(mate, 'e7', 'e5');
    mate = playChess(mate, 'g2', 'g4');
    mate = playChess(mate, 'd8', 'h4');
    assert.equal(mate.over, true);
    const overContext = buildConversationGamesContext(record(CHESS, mate), NAMES);
    assert.match(overContext, /The game is over\. Durable Nova won\. Checkmate\./);
    assert.ok(!overContext.includes('turn to move next'), 'a finished game has no turn');
});

test('connect four names both disc colours and the last dropped column', () => {
    let state = CONNECT_FOUR.createState({ random: () => 0.5 });
    const opening = buildConversationGamesContext(record(CONNECT_FOUR, state), NAMES);
    assert.match(opening, /a game of Connect Four is being played in this DM right now/);
    assert.match(opening, /Kris drops the O discs\. Durable Nova drops the X discs\./);
    assert.match(opening, /It is Kris's turn to move next\./);
    assert.match(opening, /1 2 3 4 5 6 7/);

    state = drop(state, 3);
    const context = buildConversationGamesContext(record(CONNECT_FOUR, state), NAMES);
    assert.match(context, /It is your side's turn to move next\./);
    assert.match(context, /Last move: Kris dropped in column 4\./);
});

test('a finished connect four game names the winner', () => {
    let state = CONNECT_FOUR.createState({ random: () => 0.5 });
    for (const column of [0, 1, 0, 1, 0, 1, 0]) {
        state = drop(state, column);
    }
    assert.equal(state.over, true);
    const context = buildConversationGamesContext(record(CONNECT_FOUR, state), NAMES);
    assert.match(context, /The game is over\. Kris won\./);
    assert.ok(!context.includes('It ended in a draw'), 'a four in a row is not a draw');
});

test('a solo puzzle is framed as the user’s own game, board unseen', () => {
    const state = PICROSS.createState({ options: { size: 'easy' }, random: seeded(21) });
    assert.equal(PICROSS.status(state).over, false, 'a seeded puzzle starts unsolved');
    const context = buildConversationGamesContext(record(PICROSS, state), NAMES);
    assert.match(context, /Kris is playing a solo game of Picross beside this DM\./);
    assert.match(context, /Where it stands:/);
    assert.match(context, /do not claim to see or solve the board yourself/);
    assert.ok(!context.includes('Current board'), 'the character never sees the solo board');
});

test('group participants are joined into the pal side of the game', () => {
    const state = CONNECT_FOUR.createState({ random: () => 0.5 });
    const context = buildConversationGamesContext(record(CONNECT_FOUR, state), {
        charName: PAL,
        palNames: [PAL, 'Durable Kit'],
        userName: USER,
    });
    assert.match(context, /Durable Nova and Durable Kit against Kris\./);
    assert.match(context, /Durable Nova and Durable Kit drop the X discs\./);
});

test('unreadable records build no context at all', () => {
    assert.equal(buildConversationGamesContext(null, NAMES), '');
    assert.equal(buildConversationGamesContext(undefined, NAMES), '');
    assert.equal(buildConversationGamesContext({}, NAMES), '');
    assert.equal(buildConversationGamesContext({ id: 'poker', state: {} }, NAMES), '');
    assert.equal(buildConversationGamesContext({ id: 'chess', state: { id: 'chess', version: 1, board: [] } }, NAMES), '');
    assert.equal(buildConversationGamesContext({ id: 'chess', state: 'nonsense' }, NAMES), '');
});

test('name helpers stay clean', () => {
    assert.equal(joinNames([]), '');
    assert.equal(joinNames(['A']), 'A');
    assert.equal(joinNames(['A', 'B']), 'A and B');
    assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
    assert.equal(joinNames(['A', 'A', ' A ']), 'A');
});
