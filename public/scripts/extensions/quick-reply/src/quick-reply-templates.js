/**
 * Ready-made quick reply sets and the helpers behind the 'Make a quick reply' builder.
 * Kept free of DOM and app imports so the message building can be unit tested.
 */

export const DEFAULT_CUSTOM_SET_NAME = 'My quick replies';

const DIRECTION_INJECT_ID = 'quick-reply-direction';
const ASK_ANSWER_WRAPPER_OPEN = '<div style="white-space: pre-wrap; text-align: start">';

/**
 * Ways a quick reply can behave. Each one is written into the reply's own message,
 * so one set can mix them freely.
 */
export const QUICK_REPLY_MODES = [
    {
        id: 'send',
        label: 'Send it as my message',
        hint: 'Sends the text straight away, as if you typed it.',
        placeholder: 'Hello there! How was your day?',
    },
    {
        id: 'box',
        label: 'Put it in the message box',
        hint: 'Fills the box so you can edit it before sending. Use {{input}} to keep what you had typed.',
        placeholder: '*{{input}}*',
    },
    {
        id: 'direct',
        label: 'Steer the next reply',
        hint: 'The AI writes its next reply following this note. The note is used once and is not added to the chat.',
        placeholder: 'Make the next reply short and full of tension.',
    },
    {
        id: 'ask',
        label: 'Ask the AI privately',
        hint: 'The AI answers in a pop-up window. Nothing is added to the chat.',
        placeholder: 'Give me three ideas for what could happen next.',
    },
    {
        id: 'command',
        label: 'Run a command',
        hint: 'For slash commands and scripts, for example /continue.',
        placeholder: '/continue',
    },
];

/**
 * Makes text safe to pass as a slash command's main value.
 * A value that starts with a quote would lose its quotes, so it is wrapped in quotes instead;
 * otherwise pipes and '{:' are escaped so they do not split or open a script.
 * @param {string} text
 * @returns {string}
 */
export function escapeQuickReplyCommandText(text) {
    const value = String(text ?? '');
    if (value.startsWith('"')) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return escapeEmbeddedCommandText(value);
}

/**
 * Makes text safe to place in the middle of a slash command's main value.
 * Only pipes and '{:' are escaped: quotes there are kept as they are, and wrapping
 * the text in quotes would leave the quotes and backslashes in the value.
 * @param {string} text
 * @returns {string}
 */
export function escapeEmbeddedCommandText(text) {
    return String(text ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\{:/g, '\\{:');
}

/**
 * Turns the builder's plain text and chosen behaviour into a quick reply message.
 * @param {string} mode One of the QUICK_REPLY_MODES ids.
 * @param {string} text What the user typed into the builder.
 * @returns {string}
 */
export function buildQuickReplyMessage(mode, text) {
    const value = String(text ?? '').trim();
    switch (mode) {
        case 'box':
            return `/setinput ${escapeQuickReplyCommandText(value)}`;
        case 'direct':
            // Sends anything already typed first, then asks for a reply that follows the one-off note.
            return [
                `/inject id=${DIRECTION_INJECT_ID} position=chat depth=0 role=system ephemeral=true [Direction for the next reply only: ${escapeEmbeddedCommandText(value)}]`,
                '/getinput',
                '/if left={{pipe}} rule=neq right="" {: /send {{input}} | /setinput "" :}',
                '/trigger',
            ].join(' | ');
        case 'ask':
            // A failed or empty answer shows nothing instead of a blank pop-up.
            // The pop-up shows HTML, so the wrapper keeps the answer's line breaks and lists.
            return `/gen ${escapeQuickReplyCommandText(value)} | /if left={{pipe}} rule=neq right="" {: /popup ${ASK_ANSWER_WRAPPER_OPEN}{{pipe}}</div> :}`;
        case 'command':
            return value;
        case 'send':
        default:
            // A leading slash would run as a command; a leading space keeps it as plain text.
            return value.startsWith('/') ? ` ${value}` : value;
    }
}

/**
 * Picks a set name that is not taken yet, adding ' 2', ' 3' and so on when needed.
 * @param {string} baseName
 * @param {string[]} existingNames
 * @returns {string}
 */
export function getUniqueQuickReplySetName(baseName, existingNames) {
    const taken = new Set((existingNames ?? []).map(name => String(name).trim().toLowerCase()));
    const base = String(baseName ?? '').trim() || DEFAULT_CUSTOM_SET_NAME;
    if (!taken.has(base.toLowerCase())) {
        return base;
    }
    let counter = 2;
    while (taken.has(`${base} ${counter}`.toLowerCase())) {
        counter++;
    }
    return `${base} ${counter}`;
}

const direction = (text) => buildQuickReplyMessage('direct', text);
const ask = (text) => buildQuickReplyMessage('ask', text);

/**
 * @typedef {object} QuickReplyTemplateReply
 * @property {string} label
 * @property {string} icon Font Awesome class, shown on the button.
 * @property {string} title Tooltip that explains what the button does.
 * @property {string} message
 */

/**
 * @typedef {object} QuickReplyTemplate
 * @property {string} id
 * @property {string} name Name of the set it creates.
 * @property {string} icon
 * @property {string} description
 * @property {QuickReplyTemplateReply[]} replies
 */

/** @type {QuickReplyTemplate[]} */
export const QUICK_REPLY_TEMPLATES = [
    {
        id: 'story-controls',
        name: 'Story controls',
        icon: 'fa-forward',
        description: 'Keep the scene moving without typing a command.',
        replies: [
            { label: 'Continue', icon: 'fa-forward', title: 'Keep writing the last reply from where it stopped', message: '/continue' },
            { label: 'Try again', icon: 'fa-rotate-right', title: 'Write a new version of the last reply', message: '/regenerate' },
            { label: 'Write for me', icon: 'fa-user-pen', title: 'Let the AI draft your next message in the box, so you can check it before sending', message: '/impersonate' },
        ],
    },
    {
        id: 'reply-directions',
        name: 'Reply directions',
        icon: 'fa-compass',
        description: 'Nudge how the AI writes its next reply. Each note is used once and never added to the chat.',
        replies: [
            { label: 'More detail', icon: 'fa-feather', title: 'Next reply: richer description and a slower pace', message: direction('Write with richer sensory detail and a slower, more immersive pace.') },
            { label: 'Shorter', icon: 'fa-compress', title: 'Next reply: short and to the point', message: direction('Keep it short: two brief paragraphs at most.') },
            { label: 'Move it along', icon: 'fa-person-running', title: 'Next reply: something new happens', message: direction('Move the story forward with a new development, complication or event.') },
            { label: 'Time skip', icon: 'fa-hourglass-half', title: 'Next reply: jump ahead to the next important moment', message: direction('Skip ahead to the next meaningful moment and briefly sum up what happened in between.') },
            { label: 'More dialogue', icon: 'fa-comments', title: 'Next reply: let the character talk more', message: direction('Focus on dialogue. Let {{char}} speak and react in their own voice.') },
            { label: 'Inner thoughts', icon: 'fa-brain', title: 'Next reply: show what the character is thinking', message: direction('Include {{char}}\'s inner thoughts and feelings alongside what they say and do.') },
        ],
    },
    {
        id: 'writing-helpers',
        name: 'Writing helpers',
        icon: 'fa-pen-nib',
        description: 'Type your message, then tap a button to format it before you send.',
        replies: [
            { label: 'Action', icon: 'fa-hand', title: 'Wrap what you typed in *asterisks* as an action', message: buildQuickReplyMessage('box', '*{{input}}*') },
            { label: 'Speech', icon: 'fa-quote-left', title: 'Wrap what you typed in "quotes" as speech', message: buildQuickReplyMessage('box', '"{{input}}"') },
            { label: 'OOC', icon: 'fa-comment-dots', title: 'Mark what you typed as out of character', message: buildQuickReplyMessage('box', '(OOC: {{input}})') },
        ],
    },
    {
        id: 'private-help',
        name: 'Ask privately',
        icon: 'fa-circle-question',
        description: 'Get help from the AI in a pop-up window. Nothing is added to the chat.',
        replies: [
            { label: 'Recap', icon: 'fa-list-check', title: 'Sum up the story so far in a pop-up', message: ask('Briefly recap the story so far as a few bullet points. Do not continue the story.') },
            { label: 'Ideas', icon: 'fa-lightbulb', title: 'Suggest three directions the story could take', message: ask('Suggest three short, different ideas for what {{user}} could do next. Do not continue the story.') },
            { label: 'Who is here?', icon: 'fa-users', title: 'List who is in the scene and how they feel', message: ask('List the characters present in the current scene, with one line each on their mood and goal. Do not continue the story.') },
        ],
    },
];

/**
 * Finds a template by id.
 * @param {string} id
 * @returns {QuickReplyTemplate|undefined}
 */
export function getQuickReplyTemplate(id) {
    return QUICK_REPLY_TEMPLATES.find(template => template.id === id);
}
