/**
 * Adds hand-written text as another version (swipe) of a story reply.
 * @param {object} message Story message to extend
 * @param {string} text Text of the new version
 * @param {{ sendDate: string, bias?: string, model?: string }} options
 * @returns {number} Index of the new version
 */
export function appendManualSwipe(message, text, { sendDate, bias = '', model = 'slash command' }) {
    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_info = [{}];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({}));
    }

    message.swipes.push(text);
    message.swipe_info.push({
        send_date: sendDate,
        gen_started: null,
        gen_finished: null,
        extra: {
            bias,
            gen_id: Date.now(),
            api: 'manual',
            model,
        },
    });

    return message.swipes.length - 1;
}

/**
 * Shows a version added by appendManualSwipe. Save ad-hoc changes to the
 * current version first (syncMesToSwipe), then save and redraw the chat.
 * @param {object} message Story message
 * @param {number} index Index of the version to show
 */
export function selectManualSwipe(message, index) {
    message.swipe_id = index;
    message.mes = message.swipes[index];
    message.extra = structuredClone(message.swipe_info?.[index]?.extra ?? message.extra ?? {});
}
