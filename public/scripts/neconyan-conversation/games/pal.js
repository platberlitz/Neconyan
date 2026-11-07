/**
 * The other side of a versus game. A move is asked of the chat connection first
 * (the conversation's connection profile when it has one, otherwise the main API),
 * and the rules module's own search plays the move when that answer is unusable.
 * Nothing here touches the chat itself: the panel decides what to do with the move.
 */
import { generateRawData } from '../../../script.js';
import { ConnectionManagerRequestService } from '../../extensions/shared.js';
import { extractProfileResponseText } from '../../extensions/in-chat-agents/llm-utils.js';
import { getConnectionProfiles } from '../personas.js';

const REPLY_TOKENS = 140;
const REQUEST_TIMEOUT_MS = 45000;

function findProfile(name) {
    const wanted = String(name || '').trim();
    if (!wanted) {
        return null;
    }
    const profiles = getConnectionProfiles();
    const match = profiles.find(profile => profile?.id === wanted)
        || profiles.find(profile => profile?.id && profile.name === wanted);
    return match ? { id: match.id, name: match.name } : null;
}

function seatNames(names) {
    const list = (Array.isArray(names) ? names : [])
        .map(name => String(name || '').trim())
        .filter(Boolean);
    if (!list.length) {
        return 'the chat characters';
    }
    if (list.length === 1) {
        return list[0];
    }
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function sameMove(left, right) {
    if (!left || !right) {
        return false;
    }
    const leftPromotion = left.promotion || null;
    const rightPromotion = right.promotion || null;
    return left.column === right.column
        && left.from === right.from
        && left.to === right.to
        && leftPromotion === rightPromotion;
}

async function askConnection(profileName, messages, signal) {
    const profile = findProfile(profileName);
    if (profile) {
        const response = await ConnectionManagerRequestService.sendRequest(profile.id, messages, REPLY_TOKENS, {
            stream: false,
            signal,
            extractData: false,
            includePreset: false,
            includeInstruct: false,
        });
        return extractProfileResponseText(response);
    }

    const raw = await generateRawData({
        prompt: messages,
        responseLength: REPLY_TOKENS,
        cacheScope: 'auxiliary',
        literalPrompt: true,
        signal,
    });
    return typeof raw === 'string' ? raw : extractProfileResponseText(raw);
}

/**
 * Ask the pal's side for a move.
 * @returns {Promise<{move: object|null, source: 'model'|'search'|'none'}>} source says
 *   whether the move came back from the connection or from the rules module's search.
 */
export async function requestPalMove({ rules, state, difficulty = 'normal', profileName = '', palNames = [], userName = 'the human player' } = {}) {
    if (!rules || !state || state.over) {
        return { move: null, source: 'none' };
    }
    const legal = rules.legalMoves(state);
    if (!legal.length) {
        return { move: null, source: 'none' };
    }

    const board = rules.promptBoard(state);
    const messages = [
        {
            role: 'system',
            content: `You are ${seatNames(palNames)}, playing ${rules.name} against ${String(userName || 'the human player').trim() || 'the human player'}. `
                + 'Work out one legal move from the board and reply with the move only. No explanation, no commentary, no roleplay.',
        },
        { role: 'user', content: board },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let text = '';
    try {
        text = await askConnection(profileName, messages, controller.signal);
    } catch (error) {
        console.warn('[neconyan] the pal could not be reached for a move', error);
    } finally {
        clearTimeout(timer);
    }

    let parsed = null;
    if (text) {
        try {
            parsed = rules.parseMoveReply(state, text);
        } catch (error) {
            console.warn('[neconyan] the pal answered with something unreadable', error);
        }
    }
    const legalMatch = parsed && legal.find(move => sameMove(move, parsed));
    if (legalMatch) {
        return { move: legalMatch, source: 'model' };
    }

    const searched = rules.pickCpuMove(state, { difficulty });
    return searched ? { move: searched, source: 'search' } : { move: null, source: 'none' };
}

export const testExports = { seatNames, findProfile, sameMove };
