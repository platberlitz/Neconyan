# Scratchpad

Scratchpad is a side conversation with Miso, Taro or Nori. Ask about anything, compare ideas, or use the chat you have open to talk through a scene, check continuity or ask for lorebook entries. Nothing you write there goes into the story, and the characters in the chat never see it.

All three assistants can do the same things in Scratchpad. They keep their own personalities: Miso is the cheerful guide, Taro the careful troubleshooter and Nori the playful writing partner. Each uses the Male, Female or Neutral version you picked for that assistant elsewhere in Neconyan.

## Opening it

- **Anywhere**: choose **Scratchpad** in the desktop sidebar or the phone menu, just under **Notes**.
- **Roleplay**: press the clipboard button labelled **Scratchpad** in the bottom chat bar, or open **Chat tools** (the menu beside the message box) and choose **Scratchpad**.
- **Conversation**: press **Scratchpad** in the quick tools row.
- **Notes**: open a note and press **Ask Scratchpad**. Choose the whole note or selected text, review what will be shared and press **Open Scratchpad**.

On desktop Scratchpad opens beside the chat. Drag its left edge (or focus the edge and use the arrow keys) to change its width, and use **Full width** or **Beside chat** to switch layouts. On a phone it fills the screen; **Back to chat** returns to the conversation. Opening Notes closes Scratchpad, and opening Scratchpad closes Notes.

Scratchpad follows the chat you have open. Switch chats and it shows that chat's sessions instead. Renaming a saved Roleplay chat keeps its sessions, context settings and replies already in progress. A different chat that reuses the old name gets its own Scratchpad.

**Ask Scratchpad** opens sessions belonging to the note, not the open chat. It saves unfinished note edits before sharing, offers a 30-minute read-only grant and lets you explicitly allow proposed edits. Selected text shares only that exact passage. The open story, character cards, persona, linked notes and attachments are not included. **Back to Notes** returns to the source note. Permanent AI access settings stay unchanged.

## Talking

Under **Context → Assistant prompts**, choose **View or edit Miso's prompt** (or Taro's or Nori's) to read and edit the complete instructions, including personality and change-card formats. **Save prompt** applies your text to that assistant in the current session. New sessions in the same chat inherit your choices. **Reset to default**, followed by **Save prompt**, restores the built-in instructions. App-reference knowledge and the Notebook permissions contract are appended automatically. Defaults reflect the current chat and round-table selection; saved custom text is otherwise used as written.

Pick who you are talking to under **Talking with**, type in the box at the bottom and press **Send** (or Enter on desktop; Shift+Enter adds a new line). **Quick prompts** fill the box with a ready-made request you can edit before sending: **Read the scene**, **Plot ideas**, **Catch me up**, **Continuity check** and **Lore gaps**.

The input starts one line high and grows as you add lines, up to a few lines, so the whole message stays readable. Longer drafts scroll inside it, and pasted text keeps its line breaks.

Press **New session** at the top of Scratchpad to start a fresh conversation for the open chat.

Turn on **Round table** to ask up to three assistants together. Press their portraits to include or exclude them; keep at least one selected. **Ask 2** or **Ask 3** sends one question to everyone selected, using each assistant's own connection profile and personality. Each answer is labelled and saved separately in the same session. The reply limit applies to each assistant.

Round-table assistants answer at the same time. They share your question and the earlier conversation, but do not see the other answers being written in that round. Ask a follow-up to compare their views or have them respond to one another. **Stop all** stops unfinished replies and keeps answers already saved. If one connection fails, the other answers are kept and you can retry just the failed assistant.

To give the conversation more room, press **Talking with** (just the arrow on phones) and the assistant picker and session line fold into one slim bar. Press the bar to bring them back. Scratchpad remembers which way you left it.

Replies are written on the server. They keep going if you close Scratchpad, reload the page or close the browser, and the finished reply is there when you come back. **Stop** ends a reply early. While a reply is being written you cannot send another message in the same session.

Each message has a few buttons:

- **Copy** copies the text.
- **Save selection or message to note** saves a selected passage or the message to a new Inbox note or an existing note. Replies omit change cards; reasoning is never copied. The quotation keeps its Scratchpad speaker and date.
- **Edit message** lets you correct either side of the conversation. The assistant sees the edited text next time.
- **Use as draft in the chat box** copies an assistant reply (without any change cards) into the story's message box. Nothing is sent; you decide what to do with it.
- **Try again** asks that assistant for a new version of its answer to your latest message. In a round table it keeps the other assistants' answers.
- **Delete** removes the message from Scratchpad. The story is not affected.

When you ask how something in Neconyan works, the assistant also gets the same help reference that assistant chats use.

## What Scratchpad reads

Scratchpad rebuilds the story context from the open chat every time you send, so it always reads the chat as it is now. You need that chat open to send. The **Context** tab controls what is shared:

- **Recent messages to read**: how many of the latest messages to share (15 to start with). Use 0 to share none. Hidden messages are skipped unless you turn on **Include hidden messages**.
- **Pick specific messages and swipes**: tick particular messages instead. For Roleplay messages with several swipes, expand **Swipes** and tick the versions you want to compare. Each version is labelled with its message and swipe number, and the current version is marked. This does not change the selected swipe in the story. Picked messages and swipes replace the recent messages setting until you press **Clear picks**.
- **Also share**: **Character cards** (description, personality and scenario of everyone in the chat), **Your persona**, **Author's Note** (Roleplay only) and **Lorebook entries**.
- **Lorebook entries**: entries from the lorebooks active in this chat are shared when they are always active, when one of their keywords appears in the last five shared messages, the recent Scratchpad conversation or what you are sending, or when you set them to **Always**. **Never** keeps an entry out. **Auto** goes back to the normal rules. Entries hidden from agents are never shared. At most 40 entries go in at once.
- **Assistant connections**: choose a saved connection profile for Miso, Taro and Nori separately. Each profile includes its model and connection settings. **Same connection as the chat** uses whatever the chat uses. Switching assistants keeps each assistant's choice, and a new session inherits those choices. Scratchpad also remembers each assistant's last choice, so chats without a Scratchpad session start with it. With **Same connection as the chat**, regex scripts limited to particular characters are skipped, because Scratchpad does not speak as a character; global and preset scripts still apply. A model with tool calling is not needed.
- **Longest reply (tokens)**: the reply length limit (16000 to start with). Existing sessions keep their saved limit.
- **Saved notes**: **Add saved note** searches only notes shared with assistants through Notebook AI access. Choose the whole note or a heading section. Up to 12 notes or sections can be selected, with up to 24,000 characters per page. **Next page** and **Previous page** choose the shared page; other sections and pages stay out. **Open note** returns to Notes, **Remove** stops including it and **Stop sharing** revokes a temporary grant.

**Show preview** under **What Scratchpad will read** shows the exact context that goes with your next message and an estimate of its size in tokens.

Saved-note text and permissions are read again on the server for every send. If they change while a reply is being prepared, send again with the new version. Unavailable, private or expired notes show **Not shared** without their text. Links do not expand access. Notebook text is reference material, not instructions. Removing a reference or revoking access cannot withdraw text already sent to a model.

Context settings belong to the session, and a new session starts with the settings of the one you were using (without picked messages or temporary note grants).

## Suggested changes

When you ask for a change, the assistant can suggest one as a card in its reply instead of describing it. Nothing changes until you save it.

Scratchpad can suggest:

- **Lorebooks**: new entries (with title, keywords and text), edits to an entry's title, keywords or text, and deleting an entry.
- **Characters**: rewriting a field on a character in this chat, including group members. The fields are description, personality, scenario, first message, example messages, creator's notes, system prompt, post-history instructions, alternate greetings and tags.
- **Messages** (Roleplay only): rewriting a message, adding a message after another, hiding a message, showing a hidden message again and deleting a message.
- **Notebook**: creating a note, appending text, replacing a heading section or an explicitly shared selection, updating properties and suggesting publication as lore. Current Notebook read/edit permissions and temporary grants still apply. Publishing needs the separate lore permission.

Press **Review** on a card to see what is there **Now** next to the **Proposed text**. You can edit the proposed text before pressing **Save change**. **Not now** closes the review without saving, and the card stays so you can come back to it. **Dismiss** marks a card you do not want; **Undo** brings it back.

Notebook cards show the exact, read-only change and also appear in **Notes → Assistant changes** when the reply finishes. Save or decline from either place; Scratchpad reflects that decision when reopened. They always need review, even when Notebook's requested-edit saving is enabled. **Dismiss** permanently declines an already registered Notebook proposal. Stale note revisions, changed permissions and expired grants prevent saving. To adjust a Notebook proposal, ask for a new suggestion rather than editing the review.

For new alternate greetings, the assistant only supplies the additions. **Review** shows **Existing greetings (kept)** separately from **New greetings to append**. Edit the new greetings and save; they go after the last existing alternate greeting, in order. The existing greetings and first message stay as they are.

Scratchpad checks the target again just before saving. If the entry, field or message changed while the review was open, or if you have switched to a different chat, nothing is saved and you are asked to get a fresh suggestion. A saved card says **Saved**.

Conversation mode does not offer message changes. Lorebook and character changes work in both modes.

## Sessions

The **Sessions** tab lists the sessions for the open chat. Each chat keeps its own sessions, up to 40, and each session holds up to 400 messages.

- **New session** starts a fresh conversation. **Temporary session** starts one that disappears when you open or start another session.
- **Open** switches to a session, **Rename** changes its name, **Clear messages** empties it but keeps its context settings, and **Delete session** removes it.
- **Search sessions** filters by session name and message text.
- **Export current** downloads the open session as a file. **Import** adds a session from one of those files to the open chat.
- **Save session to note** saves the completed conversation as a quotation in a new or existing note. It leaves out reasoning, unfinished replies and change-card instructions.

Sessions are saved on the server under your account, separately from the chat itself. Deleting a session never touches the story.

Saved Roleplay sessions follow the chat's permanent identity rather than its filename. Existing Scratchpad files are kept in place when linked to that identity, including before a rename. Group chats stay separate by group even when groups share the same chat file. This prevents new renames from opening an empty Scratchpad; it doesn't guess which chat owns sessions orphaned by an earlier rename.

Exports and imports leave out saved-note sharing references, temporary grants and saved/declined proposal markers. Imported conversation text remains a copy of what was written; it can still contain material shared in the original session. Saving a quotation does not publish lore or give assistants new access.

## Limits and known gaps

- Message changes only work in Roleplay chats.
- Scratchpad shares what you choose in the Context tab and nothing else. It does not read Mewmory or Companion notes.
- A reply that is still being written keeps its session busy. Press **Stop** if it seems stuck.
