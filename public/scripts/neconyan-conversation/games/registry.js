/**
 * The games Conversation mode can offer. Order matters: the versus games come
 * first because they are the ones played with the pals of the chat, then the
 * puzzles someone settles into alone.
 */
import { RULES as CHESS } from './rules/chess.js';
import { RULES as CONNECT_FOUR } from './rules/connect-four.js';
import { RULES as MINESWEEPER } from './rules/minesweeper.js';
import { RULES as PICROSS } from './rules/picross.js';

export const GAME_RULES = Object.freeze([CHESS, CONNECT_FOUR, PICROSS, MINESWEEPER]);

export function getGameRules(id) {
    const wanted = String(id || '');
    return GAME_RULES.find(rules => rules.id === wanted) ?? null;
}

export function isVersusGame(rules) {
    return rules?.kind === 'versus';
}
