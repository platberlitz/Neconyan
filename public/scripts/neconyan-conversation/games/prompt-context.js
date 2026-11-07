/**
 * Turns the saved games record of a conversation branch into system-prompt
 * context, so characters replying in the DM know a game is on, which seat is
 * theirs, whose turn it is and what the board looks like. Pure module: no DOM,
 * no store access, safe to import from both the browser and the server.
 */
import { getGameRules } from './registry.js';

function cleanName(value, fallback) {
    const name = String(value ?? '').trim();
    return name || fallback;
}

function joinNames(names) {
    const unique = [];
    for (const name of names) {
        const clean = String(name ?? '').trim();
        if (clean && !unique.includes(clean)) {
            unique.push(clean);
        }
    }
    if (!unique.length) {
        return '';
    }
    if (unique.length === 1) {
        return unique[0];
    }
    if (unique.length === 2) {
        return `${unique[0]} and ${unique[1]}`;
    }
    return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

function palVerb(pals, singular, plural) {
    return /[,\s]and\s|,\s/.test(pals) ? plural : singular;
}

function seatLineChess(state, user, pals) {
    const humanWhite = state.you === 'w';
    const humanColor = humanWhite ? 'White, the uppercase pieces' : 'Black, the lowercase pieces';
    const palColor = humanWhite ? 'Black, the lowercase pieces' : 'White, the uppercase pieces';
    return `${user} plays ${humanColor}. ${pals} ${palVerb(pals, 'plays', 'play')} ${palColor}.`;
}

function seatLineConnectFour(state, user, pals) {
    return `${user} drops the O discs. ${pals} ${palVerb(pals, 'drops', 'drop')} the X discs.`;
}

function lastMoveLine(rules, state, user, pals) {
    if (rules.id === 'chess') {
        const entry = Array.isArray(state.history) ? state.history[state.history.length - 1] : null;
        const san = String(entry?.san ?? '').trim();
        if (!san) {
            return '';
        }
        const pieceColor = String(entry?.piece ?? '')[0];
        const mover = pieceColor === state.you ? user : pals;
        return `Last move: ${mover} played ${san}.`;
    }
    if (rules.id === 'connect-four') {
        const columns = Array.isArray(state.history) ? state.history : [];
        const column = columns[columns.length - 1];
        if (!Number.isInteger(column)) {
            return '';
        }
        // While the game runs, toPlay has already switched to the next seat,
        // so the mover is the opposite seat. Finished games skip this line.
        const mover = state.toPlay === 'y' ? user : pals;
        return `Last move: ${mover} dropped in column ${column + 1}.`;
    }
    return '';
}

function winnerLine(status, user, pals) {
    const winner = status?.winner;
    if (winner === 'you') {
        return `${user} won.`;
    }
    if (winner === 'pal') {
        return `${pals} won.`;
    }
    return 'It ended in a draw.';
}

function buildSoloContext(rules, state, user) {
    const status = rules.status(state) || {};
    const lines = [
        `Current game: ${user} is playing a solo game of ${rules.name} beside this DM.`,
    ];
    if (status.over) {
        lines.push(`It is finished. ${cleanName(status.label, 'Over')}. ${cleanName(status.detail, '')}`.replace(/\.\s*$/, '.'));
    } else {
        lines.push(`Where it stands: ${cleanName(status.detail, 'still in progress.')}`);
    }
    lines.push('The puzzle is theirs alone. Cheer them on or talk about it naturally, and do not claim to see or solve the board yourself.');
    return lines.join('\n');
}

function buildVersusContext(rules, state, user, pals) {
    const status = rules.status(state) || {};
    const lines = [
        `Current game: a game of ${rules.name} is being played in this DM right now, ${pals} against ${user}.`,
    ];
    if (rules.id === 'chess') {
        lines.push(seatLineChess(state, user, pals));
    } else if (rules.id === 'connect-four') {
        lines.push(seatLineConnectFour(state, user, pals));
    }
    if (status.over) {
        const reason = rules.id === 'chess' ? cleanName(status.detail, '') : '';
        lines.push(`The game is over. ${winnerLine(status, user, pals)}${reason ? ` ${reason}` : ''}`.trim());
    } else {
        const turn = rules.turn(state);
        const check = status.label === 'Check' ? ' The king is in check.' : '';
        if (turn === 'pal') {
            lines.push(`It is your side's turn to move next.${check}`);
        } else if (turn === 'you') {
            lines.push(`It is ${user}'s turn to move next.${check}`);
        }
        const last = lastMoveLine(rules, state, user, pals);
        if (last) {
            lines.push(last);
        }
    }
    if (typeof rules.boardText === 'function') {
        const board = rules.boardText(state);
        if (board) {
            lines.push(`Current board:\n${board}`);
        }
    }
    lines.push('Talk about the game naturally as the chat flows. Moves are made on the game board beside the chat, never inside your replies, so do not answer with bare move notation. When it is your side\'s turn, the board collects the move separately.');
    return lines.join('\n');
}

/**
 * Build the games paragraph for a conversation system prompt.
 * @param {object|null|undefined} games Saved record from branch.games.
 * @param {object} [options]
 * @param {string} [options.charName] Name of the character the prompt is for.
 * @param {string[]} [options.palNames] Names on the character side (usually every participant).
 * @param {string} [options.userName] Name of the human player.
 * @returns {string} Context block, or '' when there is no readable game.
 */
export function buildConversationGamesContext(games, { charName = '', palNames = [], userName = '' } = {}) {
    if (!games || typeof games !== 'object') {
        return '';
    }
    const rules = getGameRules(games.id);
    if (!rules || typeof rules.hydrate !== 'function' || typeof rules.status !== 'function') {
        return '';
    }
    let state = null;
    try {
        state = rules.hydrate(games.state);
    } catch {
        return '';
    }
    if (!state) {
        return '';
    }
    const user = cleanName(userName, 'the human player');
    const names = joinNames([...(Array.isArray(palNames) ? palNames : []), charName]
        .filter(name => String(name ?? '').trim().toLowerCase() !== user.toLowerCase()));
    const pals = names || 'you and the other characters in this chat';
    if (rules.kind === 'solo') {
        return buildSoloContext(rules, state, user);
    }
    return buildVersusContext(rules, state, user, pals);
}

export const testExports = { cleanName, joinNames };
