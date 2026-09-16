# Neconyan

register: product

Neconyan is a self-hosted web app for chatting with AI characters. It grew out of SillyTavern and keeps its data formats (character cards, chat files, lorebooks, presets), but the interface, the phone experience and the bundled tools are Neconyan's own. Tagline: The Cutest LLM RP Frontend (TM).

## Users

- Public release: anyone who downloads it. Assume no SillyTavern history. Every screen explains its own concept in one line; no inside jokes that need upstream knowledge.
- The owner runs it on a small VPS behind HTTP basic auth and uses it mostly from an iPhone (Safari), sometimes from a Linux desktop.
- Typical session: open the app, pick a character or a recent chat, write, wait for the reply, tweak settings rarely. Phones are first-class, not a shrunken desktop.

## Product purpose

- Roleplay and conversation with LLM characters, with the model of your choice (connection profiles cover hosted and local APIs).
- Four modes: Roleplay (classic chat), Conversation (a messenger-style DM view with a Pals rail), Meower (a social timeline), Story Mode (long-form writing).
- Included tools that ship in the box: Agents (In-Chat Agents: helpers that run before or after a reply), Mewmory (long-term memory with its own model roles), Chat Archive, LoreStitch (lorebook tools), BotSearcher (find cards on public sites), Quick Image Gen, Guided Generations, Input History, Prose Polisher.
- Work survives the phone: ticking 'Remember this device for 30 days' on the sign-in page keeps you signed in, and a reply keeps generating on the server when Safari kills the tab, then lands in the chat when you reopen it (single-character chats; agents that run after a reply are not replayed).

## Brand and tone

- Cute everywhere. Cat puns are welcome in headings, buttons, empty states and errors: 'Meowlcome', 'Purrfect', 'Preparing your Neconyan workspace', 'Choose a character, or start a temporary chat'. Keep them short and keep the meaning obvious; a pun never replaces the instruction.
- Warm, plain and direct. Sentences say what happens next. No marketing superlatives, no apologies.
- British spelling, single quotes, no em dashes. Labels are verbs or nouns, never both.
- The calico cat is the mascot: ears on panels, a backflipping pixel cat on error pages, paw prints in the wallpaper, a paw favicon in Meower.

## Anti-references

- Stock SillyTavern: dense icon drawers, nested collapsibles, tiny text, features hidden behind toggles.
- Corporate SaaS dashboard: hero metrics, card grids, gradients on text, glass everywhere.
- Discord clone: grey server rails, purple accents, chat-app chrome copied wholesale.

## Strategic principles

1. Phone parity. Anything reachable on desktop is reachable on a phone in the same number of taps. Labelled tab rows that scroll sideways beat dropdowns; one tap beats two.
2. Nothing is 'advanced'. There is no simple/advanced switch. Rare actions live in the Chat tools menu or a Fine-tuning group, but they are always there.
3. Readable first. Nunito for everything you read, Fredoka One only for headings and the brand. Solid surfaces over the wallpaper; the paws show through the canvas, never through text.
4. Cute but honest. Puns in copy, never in error causes. Errors say what went wrong and the first thing to try.
5. Accessible by default. 44px touch targets, visible focus rings, WCAG 2.2 AA contrast for every bundled theme, reduced-motion respected.
6. The server does the waiting. Long work (replies, imports, translations, memory) runs on the server and reports progress; the browser is a window onto it.
7. Your data stays yours. Same files as SillyTavern, importable both ways, no telemetry.
