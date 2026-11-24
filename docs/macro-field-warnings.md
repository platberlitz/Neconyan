# Macro warnings in text fields

A typo like `{{chra}}` used to go straight into the prompt as plain text, and you'd only notice when the model started talking about 'chra'. Text boxes that expand macros now show a small warning right under the box when a macro looks wrong. The [macro reference](https://platberlitz.github.io/neconyan-docs/macros/) in the handbook lists the macros you can use.

## What gets checked

Every text box that Neconyan runs through its macro expansion:

- Character card fields (description, personality, scenario, first message, example messages, alternate greetings, system prompt, post-history instructions and the Character's Note), plus the same fields in Catelier.
- Persona description and Author's Note (chat, character, persona and default).
- Chat overrides (scenario, example messages and system prompt).
- Lorebook entry content.
- Prompt Manager entries and the other Chat Completion prompt boxes, such as the impersonation, new chat, continue nudge and Claude prefill prompts.
- Context template, Instruct sequences, System Prompts, reasoning and start-reply fields.
- Agent instructions in the Agents editor.
- The expanded editor you open from any of these boxes.

The chat message box isn't checked. Messages you send do expand macros, but I didn't want a warning bar jumping around above the keyboard while you type.

## What the warnings mean

- **Unknown macro:** Neconyan doesn't recognise the name, so it sends the text as written. Check the spelling. Several typos in one box are listed once each, with a `+N more` count after the first three.
- **Unclosed macro:** a `{{` has no closing `}}`. Add the closing braces.
- **Extra closing braces:** a `}}` has no opening `{{`. Remove it or add the opening braces. A box with no `{{` at all never gets this one, so JSON and other brace-heavy text stay quiet.

The warning updates a moment after you stop typing, straight away when you switch characters, open another lorebook or prompt entry, or switch presets, and it disappears as soon as the text is fixed. It never stops you saving or sending.

## Which names count as known

The list comes from the live macro list, so macros registered later count too: Macro Enhanced macros and your own custom macros while Macro Enhanced is on, `{{dialoguecolors}}` from Dialogue Colors and `{{availableExpressions}}` from Character Expressions. Turn an extension off and its macros become unknown again, which is honest: they really will be sent as plain text.

Comments (`{{// note}}`, `{{//}}...{{///}}`), variable shortcuts like `{{.local}}` and `{{$global}}`, and old forms like `{{time_UTC+2}}` are never flagged.

Three kinds of box accept extra names:

- The Context story string is a Handlebars template, so its tags and fields (`{{#if}}`, `{{#each}}`, `{{else}}`, `{{this}}`, `{{wiBefore}}`, `{{loreAfter}}`, `{{anchorBefore}}` and the rest) count as known there.
- Instruct sequences replace `{{name}}` with the speaker's name.
- Agent instructions accept the Agent-only macros, such as `{{lastMessage}}`, `{{assistantName}}`, `{{active-lore}}`, `{{tracker-state}}` and `{{full-mewmory}}`.

## Bundled content

`tests/macro-field-warnings.node.js` checks every bundled Context, Instruct, System Prompt and reasoning preset, both bundled Chat Completion presets, the default settings, the bundled cards and every Agent template. The only warnings are three real ones: `{{summary}}` in the Summary prompt of Pura's Director Preset, The Ethereality Express and the default settings. Neconyan doesn't ship the Summarize extension that provides it, so it really is sent as plain text. `tests/macro-field-warnings-app.e2e.js` repeats the same check in the browser against the live macro list.
