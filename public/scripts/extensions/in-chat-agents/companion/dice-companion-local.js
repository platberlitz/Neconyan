/**
 * The seam between the central companion runner and the Dice Roller widget.
 *
 * This module has zero imports and no DOM access, so the runner can ask the
 * local Dice Roller to roll without importing the widget (or the whole app)
 * into unit tests and server-safe code.
 */

let diceRunner = null;

/**
 * @param {((agentId: string, messageIndex: number) => object|null)|null} runner
 */
export function setDiceCompanionRunner(runner) {
    diceRunner = typeof runner === 'function' ? runner : null;
}

/**
 * Rolls in the mounted widget. Returns a display-only result; the roll itself
 * reaches the chat only when the user presses Add to message or Send.
 * @param {string} agentId
 * @param {number} messageIndex
 * @returns {object|null}
 */
export function runDiceCompanionLocally(agentId, messageIndex = -1) {
    if (!diceRunner || !agentId) {
        return null;
    }
    return diceRunner(agentId, messageIndex);
}
