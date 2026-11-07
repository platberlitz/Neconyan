/**
 * The chess board. Squares are buttons: the first tap lifts one of your own
 * pieces, the second plays a move from the list the rules module reports, and a
 * promotion asks which piece you want before anything is played.
 */
import { h, clear } from '../../../notebooks/dom.js';
import { t } from '../../../i18n.js';

const FILES = 'abcdefgh';
// The two Unicode chess sets are drawn differently by every font, so the sides read apart, and the
// pal's pieces are tinted ginger on top of that.
const WHITE_GLYPHS = { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔' };
const BLACK_GLYPHS = { P: '♟', N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚' };
const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

function glyphFor(piece) {
    const shaped = piece?.[0] === 'w' ? WHITE_GLYPHS[piece[1]] : BLACK_GLYPHS[piece?.[1]];
    return shaped || '?';
}

function squareName(index) {
    return `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
}

function isLightSquare(index) {
    const file = index % 8;
    const rank = Math.floor(index / 8);
    return (file + rank) % 2 === 0;
}

/** @returns {{element: HTMLElement, setState: Function, destroy: Function}} */
export function createChessView({ onMove } = {}) {
    const element = h('div', { class: 'neco-games-chess' });
    const board = h('div', { class: 'neco-games-chess-board', role: 'grid', 'aria-label': 'Chess board' });
    const promotion = h('div', { class: 'neco-games-chess-promotion', role: 'group', 'aria-label': 'Choose the promotion piece', hidden: true });
    element.append(board, promotion);

    let state = null;
    let moves = [];
    let hint = null;
    let interactive = false;
    let status = null;
    let selected = null;
    let pending = null;
    let cells = [];
    let cursor = null;

    function sideName() {
        return state?.you === 'b' ? 'your pal' : 'you';
    }

    function pieceLabel(piece) {
        if (!piece) {
            return '';
        }
        const owner = piece[0] === state?.you ? 'your' : 'your pal\'s';
        return `${owner} ${PIECE_NAMES[piece[1]] || 'piece'}`;
    }

    function tap(index) {
        if (!state || state.over || !interactive) {
            return;
        }
        pending = null;
        const piece = state.board[index];
        const own = Boolean(piece && piece[0] === state.you);
        if (selected !== null) {
            const candidates = moves.filter(move => move.from === selected && move.to === index);
            if (candidates.length) {
                play(candidates);
                return;
            }
            selected = own ? index : null;
            paint();
            return;
        }
        if (own) {
            selected = index;
            paint();
        }
    }

    function play(candidates) {
        selected = null;
        if (candidates.length > 1) {
            pending = {
                from: candidates[0].from,
                to: candidates[0].to,
                options: candidates.map(move => String(move.promotion || 'q').toLowerCase()),
            };
            paint();
            return;
        }
        const move = candidates[0];
        onMove?.({ from: move.from, to: move.to, promotion: move.promotion || null });
    }

    function choosePromotion(kind) {
        if (!pending) {
            return;
        }
        const move = { from: pending.from, to: pending.to, promotion: kind };
        pending = null;
        paint();
        onMove?.(move);
    }

    function renderPromotion() {
        clear(promotion);
        if (!pending) {
            promotion.hidden = true;
            return;
        }
        promotion.hidden = false;
        promotion.append(h('span', { class: 'neco-games-chess-promotion-label', text: t`Promote to` }));
        for (const kind of pending.options) {
            const upper = kind.toUpperCase();
            promotion.append(h('button', {
                type: 'button',
                class: 'neco-games-chess-promo',
                dataset: { kind },
                'aria-label': `${sideName()} ${PIECE_NAMES[upper] || 'piece'}`,
                onclick: () => choosePromotion(kind),
            }, h('span', { class: 'neco-games-chess-glyph', 'aria-hidden': 'true', text: glyphFor(`${state?.you || 'w'}${upper}`) })));
        }
        promotion.append(h('button', {
            type: 'button',
            class: 'neco-games-chess-promo is-cancel',
            text: t`Cancel`,
            onclick: () => {
                pending = null;
                selected = null;
                paint();
            },
        }));
    }

    function paint({ focusDisplay = null } = {}) {
        const focused = document.activeElement instanceof HTMLElement && board.contains(document.activeElement)
            ? cells.indexOf(document.activeElement)
            : -1;
        clear(board);
        cells = [];
        if (!state) {
            renderPromotion();
            return;
        }

        const flipped = state.you === 'b';
        const last = state.history?.[state.history.length - 1] || null;
        const inCheck = status?.label === 'Check';
        const kingIndex = inCheck ? state.board.indexOf(`${state.toMove}K`) : -1;
        const hinted = hint && Number.isInteger(hint.from) && Number.isInteger(hint.to) ? hint : null;
        const targets = new Set(selected === null ? [] : moves.filter(move => move.from === selected).map(move => move.to));

        if (cursor === null) {
            cursor = 0;
            for (let position = 0; position < 64; position++) {
                const displayFile = flipped ? 7 - (position % 8) : position % 8;
                const displayRank = flipped ? position >> 3 : 7 - (position >> 3);
                const index = displayRank * 8 + displayFile;
                const piece = state.board[index];
                if (piece && piece[0] === state.you) {
                    cursor = position;
                    break;
                }
            }
        }

        for (let position = 0; position < 64; position++) {
            const displayFile = flipped ? 7 - (position % 8) : position % 8;
            const displayRank = flipped ? position >> 3 : 7 - (position >> 3);
            const index = displayRank * 8 + displayFile;
            if (position % 8 === 0) {
                board.append(h('span', { class: 'neco-games-chess-rank', 'aria-hidden': 'true', text: String(displayRank + 1) }));
            }
            const piece = state.board[index];
            const classes = ['neco-games-chess-square'];
            if (isLightSquare(index)) {
                classes.push('is-light');
            }
            if (index === selected) {
                classes.push('is-selected');
            }
            if (targets.has(index)) {
                classes.push(piece ? 'is-capture' : 'is-target');
            }
            if (last && (last.from === index || last.to === index)) {
                classes.push('is-last');
            }
            if (index === kingIndex) {
                classes.push('is-check');
            }
            if (hinted && (hinted.from === index || hinted.to === index)) {
                classes.push('is-hint');
            }
            const square = h('button', {
                type: 'button',
                class: classes.join(' '),
                dataset: {
                    index: String(index),
                    square: squareName(index),
                    piece: piece || '',
                    side: piece ? (piece[0] === state.you ? 'you' : 'pal') : '',
                },
                tabindex: position === cursor ? '0' : '-1',
                'aria-label': `${squareName(index)}, ${piece ? pieceLabel(piece) : 'empty'}`,
                onclick: () => {
                    cursor = position;
                    tap(index);
                },
            });
            if (piece) {
                square.append(h('span', { class: 'neco-games-chess-glyph', 'aria-hidden': 'true', text: glyphFor(piece) }));
            }
            board.append(square);
            cells.push(square);
        }

        board.append(h('span', { class: 'neco-games-chess-rank', 'aria-hidden': 'true' }));
        for (let file = 0; file < 8; file++) {
            const displayFile = flipped ? 7 - file : file;
            board.append(h('span', { class: 'neco-games-chess-file', 'aria-hidden': 'true', text: FILES[displayFile] }));
        }

        renderPromotion();

        const wanted = focusDisplay === null ? focused : focusDisplay;
        if (wanted >= 0 && wanted < cells.length) {
            cells[wanted].focus({ preventScroll: true });
        }
    }

    board.addEventListener('keydown', (event) => {
        if (!interactive || !state) {
            return;
        }
        const position = cursor ?? 0;
        const rowStart = position - (position % 8);
        let next = null;
        switch (event.key) {
            case 'ArrowLeft':
                next = position % 8 > 0 ? position - 1 : null;
                break;
            case 'ArrowRight':
                next = position % 8 < 7 ? position + 1 : null;
                break;
            case 'ArrowUp':
                next = position >= 8 ? position - 8 : null;
                break;
            case 'ArrowDown':
                next = position < 56 ? position + 8 : null;
                break;
            case 'Home':
                next = rowStart;
                break;
            case 'End':
                next = rowStart + 7;
                break;
            default:
                return;
        }
        if (next === null || next === position) {
            return;
        }
        event.preventDefault();
        cursor = next;
        paint({ focusDisplay: next });
    });

    function setState(next, { moves: nextMoves = [], hint: nextHint = null, interactive: nextInteractive = false, status: nextStatus = null } = {}) {
        if (next !== state) {
            selected = null;
            pending = null;
            cursor = null;
        }
        state = next;
        moves = Array.isArray(nextMoves) ? nextMoves : [];
        hint = nextHint || null;
        interactive = Boolean(nextInteractive);
        status = nextStatus || null;
        paint();
    }

    return {
        element,
        setState,
        destroy() {
            clear(element);
        },
    };
}
