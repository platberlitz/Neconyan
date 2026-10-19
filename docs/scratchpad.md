# Scratchpad

For usage questions, start with [Scratchpad in the official handbook](https://platberlitz.github.io/neconyan-docs/helpers/scratchpad/).

Scratchpad is a side conversation with an assistant you choose. Use Miso, Taro or Nori, copy a character card, or make someone of your own. Ask about anything, compare ideas, or use the chat you have open to talk through a scene, check continuity or ask for lorebook entries. Nothing you write there goes into the story, and the characters in the chat never see it.

All assistants can do the same things in Scratchpad. The included three keep their own personalities: Miso is the cheerful guide, Taro the careful troubleshooter and Nori the playful writing partner. Each uses the Male, Female or Neutral version you picked for that assistant elsewhere in Neconyan.

## Opening it

- **Anywhere, including Home**: choose **Scratchpad** in the desktop sidebar or the phone menu, just under **Notebooks**. You don't need an open chat.
- **Roleplay**: press the clipboard button labelled **Scratchpad** in the bottom chat bar, or open **Chat tools** (the menu beside the message box) and choose **Scratchpad**.
- **Conversation**: press **Scratchpad** in the quick tools row.
- **Notes**: open a note and press **Ask Scratchpad**. Choose the whole note or selected text, review what will be shared and press **Open Scratchpad**.

On desktop Scratchpad opens beside the workspace. Drag its left edge (or focus the edge and use the arrow keys) to change its width, and use **Full width** or **Beside chat** to switch layouts. On a phone it fills the screen. **Back to chat** returns to an open conversation; **Close** leaves General Scratchpad. Opening Notebooks closes Scratchpad, and opening Scratchpad closes Notebooks.

Without a visible chat, you get **General Scratchpad**: one session list for your account, separate from every chat and note. General is one list, so you don't have to remember which character you selected before asking an everyday question. Home always uses General, even if a chat is still loaded underneath. Selecting a card or persona changes the reference material, not where General sessions are saved.

Roleplay sessions are shared across all chats for the same character. Conversation sessions are shared across branches for the same character or group within the active persona, separately from Roleplay sessions and other personas. Groups keep their own Roleplay list, separate from their members' solo sessions. Switching chats changes the context Scratchpad reads, not the saved sessions. Existing chat-specific sessions appear together automatically, including replies already in progress. Sessions stay private in your account's Scratchpad storage; exporting a character card does not include them.

**Ask Scratchpad** opens sessions belonging to the note, not the open chat. It saves unfinished note edits before sharing, offers a 30-minute read-only grant and lets you explicitly allow proposed edits. Selected text shares only that exact passage. The open story, character cards, persona, linked notes and attachments are not included. **Back to Notes** returns to the source note. Permanent AI access settings stay unchanged.

## Talking

### Your own assistants

Press **Assistants** beside the portraits to open your library. It opens in its own window, so a long list of assistants doesn't crowd the conversation.

- **Use a character card** searches your saved characters. **Add** copies the picture, description, personality and example dialogue into a Scratchpad assistant. Later edits to either copy are independent. Scenario, greetings, lorebooks and card-specific system instructions aren't copied. A very long card is shortened to fit: names keep their first 80 characters, and the personality and example dialogue keep their first 64,000 bytes each.
- **Add a new assistant** starts with a name and personality you write yourself. **Choose picture** accepts PNG, JPEG or WebP images up to 16 MB, cropped to a square portrait. A picture and example dialogue are optional.
- **Edit** changes a saved assistant's name, personality, picture or example dialogue. **Save assistant** makes those changes available to future replies across your account. Replies already accepted keep their original personality; saved replies keep their original speaker names.
- **Delete**, inside **Edit**, removes an assistant from your library after you confirm. Sessions that already used them keep their own copy, so earlier conversations still read correctly; they show as **Only in this session** there.
- **Use** selects an assistant. In a round table it includes or excludes them, with up to three selected at once.

You can save up to 24 of your own assistants; delete one to make room. They have the same connections, global instructions and prompt controls as the included assistants. A session-specific prompt still takes priority over personality edits; reset it under **Context → Assistant prompts** to use the saved personality again. Session exports include copies of the assistants used there, so importing a session keeps their identities without adding them to your account library. Use **Edit** to save an imported assistant to your library.

Under **Context → Global user instructions → Edit user instructions**, save preferences that apply across every Scratchpad in your account. Choose **All assistants**, or **Selected assistants** and tick the ones you want. Your text accompanies each chosen assistant's prompt in existing and new sessions, including round tables and note discussions. It is saved on the server, so it follows your account across devices. Leave the text blank and press **Save instructions** to turn it off. Replies already in progress keep their original instructions. Session exports do not include these account-wide preferences.

Under **Context → Assistant prompts**, choose an assistant's **View or edit** button to read and edit the complete instructions, including personality and change-card formats. **Save prompt** applies your text to that assistant in the current session. New sessions in the same list inherit your choices. **Reset to default**, followed by **Save prompt**, restores the instructions for their saved personality. App-reference knowledge and the Notebook permissions contract are appended automatically. Defaults reflect the current context and round-table selection; saved custom text is otherwise used as written.

Pick who you are talking to under **Talking with**, type in the box at the bottom and press **Send** (or Enter on desktop; Shift+Enter adds a new line). **Quick prompts** fill the box with a request you can edit before sending. General offers **Brainstorm**, **Help me decide** and **Create a character**. Chat sessions offer **Read the scene**, **Plot ideas**, **Catch me up**, **Continuity check** and **Lore gaps**.

The input starts one line high and grows as you add lines, up to a few lines, so the whole message stays readable. Longer drafts scroll inside it, and pasted text keeps its line breaks.

Press **New session** at the top of Scratchpad to start a fresh conversation in the current list, including General.

Turn on **Round table** to ask up to three assistants together. Press their portraits to include or exclude them; keep at least one selected. **Ask 2** or **Ask 3** sends one question to everyone selected, using each assistant's own connection profile and personality. Each answer is labelled and saved separately in the same session. The reply limit applies to each assistant.

Turn on **Random** beside **Round table** for one reply per message. **Ask 1** picks one of the selected assistants at random, using that assistant's personality and connection. The same assistant can be picked again on your next message. **Try again** keeps the speaker of the answer you are replacing. Random is saved with the session; turn it off to ask everyone selected again.

With **Random** off, round-table assistants answer at the same time. They share your question and the earlier conversation, but do not see the other answers being written in that round. Ask a follow-up to compare their views or have them respond to one another. **Stop all** stops unfinished replies and keeps answers already saved. If one connection fails, the other answers are kept and you can retry just the failed assistant. Random uses **Stop** for its single reply.

To give the conversation more room, press **Talking with** (just the arrow on phones) and the assistant picker and session line fold into one slim bar. Press the bar to bring them back. Scratchpad remembers which way you left it.

Replies are written on the server with streaming on or off. Once your message has been accepted, they keep going when you switch tabs on your phone, close Scratchpad, reload the page or close the browser. The finished reply and any thinking the model sends are saved for when you come back. **Stop** ends a reply early. While a reply is being written you cannot send another message in the same session.

Streaming has a separate 64 MiB transfer allowance because the provider repeats data around each small piece of text. Scratchpad saves up to 2 MiB each for the answer and thinking. These byte limits are separate from the model's token limit; long replies are no longer cut off at the old 64 KiB saving limit. Messages you type stay limited to 64 KiB. When a long reply is sent back to the model as earlier conversation, only its first 128 KiB is included, so one long answer does not push older turns out. Each saved Scratchpad file holds up to 32 MiB. Older chat-specific files stay in place and appear in the shared list without being combined into one oversized file. If a file fills up, delete old sessions or long replies, or enable automatic cleanup in **Sessions**.

Each message has a few buttons:

- **Copy** copies the text.
- **Save selection or message to note** saves a selected passage or the message to a new Inbox note or an existing note. Replies omit change cards; reasoning is never copied. The quotation keeps its Scratchpad speaker and date.
- **Edit message** lets you correct either side of the conversation. The assistant sees the edited text next time.
- **Use as draft in the chat box**, only with a visible Roleplay or Conversation chat, copies an assistant reply (without any change cards) into the story's message box. Nothing is sent; you decide what to do with it. General never writes into a chat hidden beneath Home.
- **Try again** asks that assistant for a new version of its answer to your latest message. In a round table it keeps the other assistants' answers.
- **Delete** removes the message from Scratchpad. The story is not affected.

When you ask how something in Neconyan works, the assistant also gets the same help reference that assistant chats use.

## Web search

Turn on **Web** beside the message box to search the web before the assistant answers. I've kept it off by default; your choice is saved per session. The search service receives only the message you're sending, with extra whitespace removed and a limit of 400 characters. It doesn't receive your chat, character cards, persona, saved notes or earlier Scratchpad messages. Scratchpad uses your message directly as the search query.

Set the account-wide provider under **Context → Web search**:

- **Brave Search** uses a Brave Search API key. Press **Manage Brave Search key** and add it with the same key manager as your other API keys.
- **SearXNG** uses your own instance. Enter its base address, including any path such as `https://search.example.com/searxng`. Enable JSON output, the machine-readable search results, in its `search.formats` setting. A 403 error means SearXNG refused the request, often because JSON output is off or this server isn't allowed to use it. A private or local address also needs to be in the server's private address whitelist, its list of allowed local addresses. Only an administrator can save one.
- **NanoGPT (Linkup)** uses the saved NanoGPT API key and the direct web search endpoint with Linkup at standard depth. It works even when your Scratchpad assistant uses another chat provider.
- **Exa** uses an Exa API key, added with **Manage Exa key**. Scratchpad asks for automatic search and short highlights from each page, which become the result snippets.
- **Tavily** uses a Tavily API key, added with **Manage Tavily key**, at basic search depth.
- **Custom address** sends a GET request to any search API that returns JSON. Put `{query}` where the search words go and, if the service takes one, `{count}` where the number of results goes, for example `https://search.example.com/api?q={query}&limit={count}`. Each result needs a `url` (or `link`) and a `title` (or `name`). A key is optional: add it with **Manage custom search key**. **Key header** chooses where it goes; `Authorization`, the default, sends `Bearer <key>`, and any other header, such as `X-API-Key`, sends the key as it is. Redirects aren't followed, and a private or local address follows the same administrator rule as SearXNG.

**Results to read** sets how many results to keep, from 1 to 10 with 5 as the default. If Web is on but the provider or key is missing, sending stops before any job starts and tells you what to set up.

Scratchpad searches once per message, or once for a whole round table, and waits up to 20 seconds. The assistant is told to cite the numbered results it uses as `[n]` and treat their contents as reference material. If search fails, the assistant can still answer, with a visible failure note and no sources. **Stop** cancels the reply, including while it's searching.

Finished replies keep a collapsible **Sources** list with the exact query and numbered links. Links open in a new tab without sending the page your Scratchpad address. The saved reply keeps the provider, query, source titles and addresses, but doesn't retain the result snippets. Session exports remain text-only and don't include these search records, so imported text can't become a verified source list.

## What Scratchpad reads

Scratchpad rebuilds the reference material every time you send. With a visible chat it reads that chat as it is now. General shares no story messages, swipes, chat metadata, Author's Note, preset or lorebook text. Your active persona can be shared; a deliberately selected card without a chat can also be shared. Home includes no hidden character card. A Conversation card without a branch uses its Conversation persona, never the underlying Roleplay card. **Character cards** and **Your persona** still control those optional references, and **Show preview** shows exactly what will go with your next message.

On Home and in Roleplay, General uses your account persona's base description, without additions selected for a hidden chat. Only the user and character name placeholders are filled in; other macros stay as text rather than reading a hidden story. General keeps saved notes, assistant connections, prompts, streaming and reply limits. **Current connection** uses your current model settings, or choose a saved profile for each assistant. Message and lore controls are hidden because there is nothing to share. In a chat, the **Context** tab also offers:

- **Recent messages to read**: how many of the latest messages to share (15 to start with). Use 0 to share none. Hidden messages are skipped unless you turn on **Include hidden messages**.
- **Pick specific messages and swipes**: tick particular messages instead. For Roleplay messages with several swipes, expand **Swipes** and tick the versions you want to compare. Each version is labelled with its message and swipe number, and the current version is marked. This does not change the selected swipe in the story. Picked messages and swipes replace the recent messages setting until you press **Clear picks**.
- **Also share**: **Character cards** (every card in the chat, complete and exactly as saved, with `{{char}}` and `{{user}}` left in place: description, personality, scenario, first message, alternate and group-only greetings, example messages, creator's notes, system prompt, post-history instructions, character's note, tags, creator, version and linked lorebooks), **Your persona**, **Author's Note** (Roleplay only), **Lorebook entries** and **Current preset** (Roleplay only, off by default; the label shows the preset's name).
- **Current preset** shares the generation preset as its own section, apart from the cards, persona and lorebooks, so Scratchpad can tell which instructions come from where. Every module is listed in prompt order and marked on or off, with its role and in-chat depth, and its text exactly as saved. Slots such as the character description or chat history are named but not filled, so no card or chat text is repeated there. In Chat Completion it lists the Prompt Manager modules; in Text Completion it lists the system prompt, context template and instruct template. The preview reports how many modules are on and off.
- **Lorebook entries**: entries from the lorebooks active in this chat are shared when they are always active, when one of their keywords appears in the last five shared messages, the recent Scratchpad conversation or what you are sending, or when you set them to **Always**. **Never** keeps an entry out. **Auto** goes back to the normal rules. Entries hidden from agents are never shared. At most 40 entries go in at once. Each lorebook folds its entries under its name, with a count of how many are shared right now; press the name to open or close it. Lorebooks start closed, and stay open while you change their entries.
- **Assistant connections**: choose a saved connection profile for each assistant separately. Each profile includes its model and connection settings. **Same connection as the chat** uses whatever the chat uses. Switching assistants keeps each assistant's choice, and a new session inherits those choices. Scratchpad also remembers each assistant's last choice, so chats without a Scratchpad session start with it. With **Same connection as the chat**, regex scripts limited to particular characters are skipped; global and preset scripts still apply. A model with tool calling is not needed.
- **Stream replies**: on by default. Shows the reply and any thinking the model sends as they arrive, including thinking before the answer starts. The Thinking block can be folded while it updates. Turn this off to wait for the finished reply. The choice is saved with the session and applies to every round-table participant.
- **Longest reply (tokens)**: the reply length limit (32000 to start with), leaving room for models that count thinking towards their output limit. Existing sessions keep their saved limit.
- **Saved notes**: **Add saved note** searches only notes shared with assistants through Notebook AI access. Choose the whole note or a heading section. Up to 12 notes or sections can be selected, with up to 24,000 characters per page. **Next page** and **Previous page** choose the shared page; other sections and pages stay out. **Open note** returns to Notebooks, **Remove** stops including it and **Stop sharing** revokes a temporary grant. When AI access is allowed anywhere in a notebook, every message also lists that notebook: its name, its access level, whether assistants may create notes or publish lore there, and how many notes they can read, so they can suggest new notes. The list itself contains no note titles or text, and **Show preview** includes it. A notebook is left out only when neither it nor any note in it allows AI access.

**Show preview** under **What Scratchpad will read** shows the exact context that goes with your next message and an estimate of its size in tokens.

Saved-note text and permissions are read again on the server for every send. If they change while a reply is being prepared, send again with the new version. Unavailable, private or expired notes show **Not shared** without their text. Links do not expand access. Notebook text is reference material, not instructions. Removing a reference or revoking access cannot withdraw text already sent to a model.

Context settings belong to the session, and a new session starts with the settings of the one you were using (without picked messages or temporary note grants). Picked messages stay tied to their original chat. In another chat, Scratchpad shares none of those messages and does not substitute recent messages; clear the picks or choose messages there. Switching between General and a chat restores each list's unsent draft while the page stays open. Drafts don't survive a browser reload. Accepted replies keep running in their original list.

## Macros in drafts

When writing reusable cards and greetings, the assistants are instructed to use `{{user}}` for the chatting persona and `{{char}}` for the card's character. Names used to find a character or lorebook stay concrete.

They can also suggest relevant Macro Enhanced features: adaptable pronouns, repeatable scene variations, conditional greetings, shared lore or custom helpers. Suggestions should include usable syntax, why it helps and any setup it needs. Macro Enhanced needs the extension and experimental macro support enabled; its Reference and Playground help check a snippet. A suggestion does not install a custom macro or set up its variables.

This guidance applies to every assistant, including round tables and edited assistant prompts. Draft placeholders stay literal when sent to a model, including through text-completion connections.

## Suggested changes

When you ask for a change, the assistant can suggest one as a card in its reply instead of describing it. Nothing changes until you save it.

Scratchpad can suggest:

- **Lorebooks**: new entries (with title, keywords and text), edits to an entry's title, keywords or text, and deleting an entry.
- **Characters**: rewriting a field on a character in this chat, including group members. The fields are description, personality, scenario, first message, example messages, creator's notes, system prompt, post-history instructions, alternate greetings and tags.
- **New character cards**: draft a new character, including from General or a note discussion, then review and save it yourself.
- **Messages** (Roleplay only): rewriting a message, adding a message after another, hiding a message, showing a hidden message again and deleting a message.
- **Notebook**: creating a note, appending text, replacing a heading section or an explicitly shared selection, updating properties and suggesting publication as lore. Current Notebook read/edit permissions and temporary grants still apply. Publishing needs the separate lore permission.

Press **Review** on a card to see what is there **Now** next to the **Proposed text**. You can edit the proposed text before pressing **Save change**. **Not now** closes the review without saving, and the card stays so you can come back to it. **Dismiss** marks a card you do not want; **Undo** brings it back.

Message-change cards and **Try again** need the chat where the reply was written. Opening another chat for the same character cannot redirect a suggested message edit there. General has no message or lorebook edits. It can change only its selected card when that card was shared for the suggestion and is still selected and shared at review. Changing General's card or persona prevents redoing an old reply against the new context; send a new message instead.

Notebook cards show the exact, read-only change and also appear in **Notebooks → Assistant changes** when the reply finishes. Save or decline from either place; Scratchpad reflects that decision when reopened. They always need review, even when Notebook's requested-edit saving is enabled. **Dismiss** permanently declines an already registered Notebook proposal. Stale note revisions, changed permissions and expired grants prevent saving. To adjust a Notebook proposal, ask for a new suggestion rather than editing the review.

For new alternate greetings, the assistant only supplies the additions. **Review** shows **Existing greetings (kept)** separately from **New greetings to append**. Edit the new greetings and save; they go after the last existing alternate greeting, in order. The existing greetings and first message stay as they are.

Scratchpad checks the target again just before saving. If the entry, field or message changed while the review was open, or if you have switched to a different chat, nothing is saved and you are asked to get a fresh suggestion. A saved card says **Saved**.

Conversation mode does not offer message changes. Lorebook and character changes work in both modes.

## Sessions

The **Sessions** tab lists General sessions or the sessions for the current character, group or note. General is one account-wide list and never merges into a chat's list. Each list allows up to 40 new and existing sessions, and each session holds up to 400 messages. If combining your older chat-specific lists brings the total above 40, every session stays available and editable; delete enough sessions before creating another.

- **New session** starts a fresh conversation. **Temporary session** starts one that disappears when you open or start another session.
- **Open** switches to a session, **Rename** changes its name, **Clear messages** empties it but keeps its context settings, and **Delete session** removes it.
- **Search sessions** filters by session name and message text.
- **Export current** downloads the open session as a file. **Import** adds a session from one of those files to the current character, group or note.
- **Save session to note** saves the completed conversation as a quotation in a new or existing note. It leaves out reasoning, unfinished replies and change-card instructions.
- **Delete old sessions automatically** is one setting shared across your account, off by default. Set **Sessions to keep per list** (1 to 40, 10 by default) to keep the most recently used sessions in each list, including General. Changing it here changes it everywhere. Cleanup runs in the current list when you save the setting, and in other lists when their Scratchpad is next saved, including when a reply finishes. Older sessions are deleted for good. The open session, the one that just got a reply and any session with a reply in progress are never deleted. Enabling cleanup or lowering the limit while it is on asks you to confirm the account-wide change.

Earlier cleanup choices are switched off when moving to character-shared sessions. Enable cleanup again in Sessions to confirm the new scope before any combined sessions are deleted.

Sessions are saved on the server under your account, separately from the chat itself. Deleting a session never touches the story.

Older Roleplay Scratchpad files keep their link to the chat's permanent identity rather than its filename, including before a rename. They appear in the shared character or group list without being moved. Groups stay separate even when they share the same chat file. This doesn't guess which character owns sessions orphaned by an earlier rename.

Exports and imports leave out picked-message references, saved-note sharing references, temporary grants and saved/declined proposal markers. Imported conversation text remains a copy of what was written; it can still contain material shared in the original session. Imported message-change cards belong to the chat chosen for import. Saving a quotation does not publish lore or give assistants new access.

## Images and portraits

Set up and enable **Quick Image Gen** first. Scratchpad checks the server's saved provider configuration before offering image instructions or **Image idea**. The chip fills an editable request to your assistant; it doesn't generate anything itself. If setup is missing, the image card explains that and offers **Open Quick Image Gen**. Ordinary text replies still work.

Ask an assistant for an illustration or a new portrait. It proposes an image card with a prompt, rather than generating a picture immediately. Press **Generate image** when you're ready. Generation stays separate from changing a card: asking for a picture shouldn't quietly replace someone's portrait.

- One proposal produces one image, using your saved Quick Image Gen provider, model, size, seed, style, quality tags, style prefixes, references and matching filters. The assistant's prompt is used directly; Scratchpad doesn't borrow the latest story message, run scene-to-prompt rewriting or start a palette batch.
- An unnamed image uses global settings, with no implicit character or chat. A named image uses that shared card's saved image settings. Avatar suggestions must name exactly one shared character. In General, that must still be the selected, shared card; a different same-named card isn't a substitute.
- If your saved **Review before generate** preference is on, **Generate image** opens the prompt review by itself once the processed prompt is ready, and the waiting card offers no **Stop image**. The window shows the processed prompt and exclusions before the image provider runs: **Generate reviewed image** approves that exact input, **Cancel** declines it. Nothing is sent to the image provider without your approval. Prompt review is approve or decline only; to change the wording, ask the assistant for a new suggestion.
- The work runs on the server and continues after closing Scratchpad or the browser. **Stop image** requests cancellation. Finished pictures are saved in your account's user images, shown in the thread and available through **Open image** and **Download**.
- Failed work has a readable status on its card. **Retry saved job** resumes the same retained work. A saved provider result is reused when only local saving failed. An unknown provider outcome is not purchased again: check the provider before asking for another suggestion.

For a portrait, generating the image leaves the character card unchanged. Press **Review avatar** to compare **Current avatar** and **Proposed avatar**. **Not now** closes the review without replacing anything. Only **Save change** writes the card, after checking the exact filename, current revision and shared target again. The filename, card metadata and chats stay with the same character. The visible portraits refresh after a successful save; a refresh failure is reported separately from a refused write.

Before replacement, the complete original PNG is preserved in user images. **Previous avatar** opens that saved picture/card copy, including its embedded card data. It isn't a one-click undo action. If the previous picture can't be preserved, the replacement isn't offered.

Session exports remain text-only: conversation text and image prompts travel, but pictures, local image addresses, jobs, approvals and target permissions don't. Download pictures separately. Imported image proposals haven't been generated or approved. Ordinary prose edits keep saved image references; the generated blocks must keep their wording and order. Deleting a message/session or using cleanup removes references, not the separate user-image files. Dismissing a proposal also keeps its saved picture.

## Limits and known gaps

- Message changes only work in Roleplay chats.
- Scratchpad shares what you choose in the Context tab, plus a list of the notebooks where AI access is allowed (see Saved notes). It does not read Mewmory or Companion notes.
- A reply that is still being written keeps its session busy. Press **Stop** if it seems stuck.
