# Scratchpad

Scratchpad is a side conversation with Miso, Taro or Nori about the chat you have open. Talk through a scene, ask what a character wants, get plot ideas, check continuity or ask for lorebook entries. Nothing you write there goes into the story, and the characters in the chat never see it.

All three assistants can do the same things in Scratchpad. They keep their own personalities: Miso is the cheerful guide, Taro the careful troubleshooter and Nori the playful writing partner. Each uses the Male, Female or Neutral version you picked for that assistant elsewhere in Neconyan.

## Opening it

- **Anywhere**: choose **Scratchpad** in the desktop sidebar or the phone menu, just under **Notes**.
- **Roleplay**: press the clipboard button labelled **Scratchpad** in the bottom chat bar, or open **Chat tools** (the menu beside the message box) and choose **Scratchpad**.
- **Conversation**: press **Scratchpad** in the quick tools row.

On desktop Scratchpad opens beside the chat. Drag its left edge (or focus the edge and use the arrow keys) to change its width, and use **Full width** or **Beside chat** to switch layouts. On a phone it fills the screen; **Back to chat** returns to the conversation. Opening Notes closes Scratchpad, and opening Scratchpad closes Notes.

Scratchpad follows the chat you have open. Switch chats and it shows that chat's sessions instead.

## Talking

Pick who you are talking to under **Talking with**, type in the box at the bottom and press **Send** (or Enter on desktop; Shift+Enter adds a new line). **Quick prompts** fill the box with a ready-made request you can edit before sending: **Read the scene**, **Plot ideas**, **Catch me up**, **Continuity check** and **Lore gaps**.

To give the conversation more room, press **Talking with** (just the arrow on phones) and the assistant picker and session line fold into one slim bar. Press the bar to bring them back. Scratchpad remembers which way you left it.

Replies are written on the server. They keep going if you close Scratchpad, reload the page or close the browser, and the finished reply is there when you come back. **Stop** ends a reply early. While a reply is being written you cannot send another message in the same session.

Each message has a few buttons:

- **Copy** copies the text.
- **Edit message** lets you correct either side of the conversation. The assistant sees the edited text next time.
- **Use as draft in the chat box** copies an assistant reply (without any change cards) into the story's message box. Nothing is sent; you decide what to do with it.
- **Try again** asks for a new version of the latest reply. Only the latest reply can be redone.
- **Delete** removes the message from Scratchpad. The story is not affected.

When you ask how something in Neconyan works, the assistant also gets the same help reference that assistant chats use.

## What Scratchpad reads

Scratchpad rebuilds the story context from the open chat every time you send, so it always reads the chat as it is now. You need that chat open to send. The **Context** tab controls what is shared:

- **Recent messages to read**: how many of the latest messages to share (15 to start with). Use 0 to share none. Hidden messages are skipped unless you turn on **Include hidden messages**.
- **Pick specific messages**: tick particular messages instead. Picked messages replace the recent messages setting until you press **Clear picks**.
- **Also share**: **Character cards** (description, personality and scenario of everyone in the chat), **Your persona**, **Author's Note** (Roleplay only) and **Lorebook entries**.
- **Lorebook entries**: entries from the lorebooks active in this chat are shared when they are always active, when one of their keywords appears in the last five shared messages, the recent Scratchpad conversation or what you are sending, or when you set them to **Always**. **Never** keeps an entry out. **Auto** goes back to the normal rules. Entries hidden from agents are never shared. At most 40 entries go in at once.
- **Assistant connections**: choose a saved connection profile for Miso, Taro and Nori separately. Each profile includes its model and connection settings. **Same connection as the chat** uses whatever the chat uses. Switching assistants keeps each assistant's choice, and a new session inherits those choices. A model with tool calling is not needed.
- **Longest reply (tokens)**: the reply length limit (4096 to start with).

**Show preview** under **What Scratchpad will read** shows the exact context that goes with your next message and an estimate of its size in tokens.

Context settings belong to the session, and a new session starts with the settings of the one you were using (without its picked messages).

## Suggested changes

When you ask for a change, the assistant can suggest one as a card in its reply instead of describing it. Nothing changes until you save it.

Scratchpad can suggest:

- **Lorebooks**: new entries (with title, keywords and text), edits to an entry's title, keywords or text, and deleting an entry.
- **Characters**: rewriting a field on a character in this chat, including group members. The fields are description, personality, scenario, first message, example messages, creator's notes, system prompt, post-history instructions, alternate greetings and tags.
- **Messages** (Roleplay only): rewriting a message, adding a message after another, hiding a message, showing a hidden message again and deleting a message.

Press **Review** on a card to see what is there **Now** next to the **Proposed text**. You can edit the proposed text before pressing **Save change**. **Not now** closes the review without saving, and the card stays so you can come back to it. **Dismiss** marks a card you do not want; **Undo** brings it back.

Scratchpad checks the target again just before saving. If the entry, field or message changed while the review was open, or if you have switched to a different chat, nothing is saved and you are asked to get a fresh suggestion. A saved card says **Saved**.

Conversation mode does not offer message changes. Lorebook and character changes work in both modes.

## Sessions

The **Sessions** tab lists the sessions for the open chat. Each chat keeps its own sessions, up to 40, and each session holds up to 400 messages.

- **New session** starts a fresh conversation. **Temporary session** starts one that disappears when you open or start another session.
- **Open** switches to a session, **Rename** changes its name, **Clear messages** empties it but keeps its context settings, and **Delete session** removes it.
- **Search sessions** filters by session name and message text.
- **Export current** downloads the open session as a file. **Import** adds a session from one of those files to the open chat.

Sessions are saved on the server under your account, separately from the chat itself. Deleting a session never touches the story.

## Limits and known gaps

- Message changes only work in Roleplay chats.
- Scratchpad shares what you choose in the Context tab and nothing else. It does not read Notes, Mewmory or Companion notes.
- A reply that is still being written keeps its session busy. Press **Stop** if it seems stuck.
