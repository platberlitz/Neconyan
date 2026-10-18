/** Shared with native assistant jobs. Keep this module free of browser imports. */
const identifier = /^[a-zA-Z][\w-]*$/;
const argumentSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'Argument name, starting with a letter. Do not use char, user or model.' },
        optional: { type: 'boolean' },
        defaultValue: { type: 'string' },
        description: { type: 'string' },
    },
    required: ['name'],
    additionalProperties: false,
};

export const BROWSER_MACRO_TOOL = {
    name: 'Neconyan_Assistant_SaveBrowserMacro',
    displayName: 'Save browser macro',
    description: 'Propose an editable Macro Enhanced prompt macro. The user reviews the exact definition and an isolated preview before it is saved for their account in this browser only. Requires Macro Enhanced and the experimental macro parser. Templates are text with supported {{macros}}, never JavaScript. Browser macros do not sync or enter account backups; server-built prompts cannot expand them. To replace an existing browser macro, supply its exact current template as expectedTemplate. Omit expectedTemplate to create a new name. Ask the user to share the definition when you do not know it.',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Macro name without braces, starting with a letter.' },
            template: { type: 'string', description: 'The complete expansion template, up to 20000 characters.' },
            description: { type: 'string', description: 'A short explanation of this macro.' },
            args: { type: 'array', items: argumentSchema, maxItems: 20 },
            expectedTemplate: { type: 'string', description: 'Exact current template when editing an existing browser macro. Omit for creation.' },
        },
        required: ['name', 'template'],
        additionalProperties: false,
    },
};

function text(value, field, max, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text of at most ${max} characters.`);
    return value;
}

export function normaliseBrowserMacroDraft(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A macro definition is required.');
    const name = text(input.name, 'Name', 128).trim();
    if (!identifier.test(name) || name.toLowerCase().startsWith('me-')) throw new Error('Choose a name starting with a letter, using letters, numbers, underscores or hyphens. The me- prefix is reserved.');
    const template = text(input.template, 'Template', 20000);
    if (!template.trim()) throw new Error('The template cannot be empty.');
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 20)) throw new Error('Use at most 20 arguments.');
    const names = new Set();
    let optionalSeen = false;
    const args = (input.args ?? []).map(arg => {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('Each argument must be an object.');
        const argName = text(arg.name, 'Argument name', 128).trim();
        const lower = argName.toLowerCase();
        if (!identifier.test(argName) || names.has(lower) || ['char', 'user', 'model'].includes(lower)) throw new Error(`Choose a unique argument name other than char, user or model: ${argName}`);
        names.add(lower);
        if (arg.optional !== undefined && typeof arg.optional !== 'boolean') throw new Error('Argument optional must be true or false.');
        const optional = arg.optional === true;
        if (optionalSeen && !optional) throw new Error('Optional arguments must follow required arguments.');
        optionalSeen ||= optional;
        return {
            name: argName,
            optional,
            defaultValue: text(arg.defaultValue, 'Argument default', 20000, ''),
            description: text(arg.description, 'Argument description', 2000, ''),
        };
    });
    return {
        name,
        template,
        description: text(input.description, 'Description', 2000, ''),
        args,
        ...(input.expectedTemplate !== undefined ? { expectedTemplate: text(input.expectedTemplate, 'Expected template', 20000) } : {}),
    };
}
