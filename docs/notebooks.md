# Notes

Notes is a notebook that lives inside Neconyan. Use it for ideas, drafts, world-building, references, session journals or anything else you want to keep. A note does not need a chat or a character.

Open it from **Notes** in the workspace rail (the sidebar on desktop, the drawer on a phone). It works with no chat open and with no AI connection.

Notes stays highlighted while it is open, including beside the chat. **Back to chat** closes Notes and clears its highlight.

The first time Notes opens, Miso offers to show you around. **Show me around** starts her tour; **Not now** hides the offer for that account until you restore tour invitations in Settings. You can start the tour later from the **Tour** button under the Notes title. The tour only switches between the Notebooks, Note and Details panes and the detail tabs; it never creates, saves, deletes or imports anything. Steps for parts of the page that are not on screen yet (for example the editor when no note is open) are skipped.

Background updates do not switch the notebook you chose or replace its list with results from a notebook you left.

## The basics

- **Notebook**: a collection of notes and files. You start with one called 'Notebook' that has an **Inbox** folder. Make more with **New notebook**.
- **Note**: an ordinary Markdown file (plain text with light formatting such as `# Heading` and `**bold**`). Notes are saved on the server under your account.
- **New note** asks for a name and offers a few starting templates: Blank note, Character draft, Location, Scene plan and Session journal. Templates are plain text; nothing in them runs.
- **Quick note** drops a thought straight into the Inbox without asking for a name, folder or type.

### Save status

The label next to the note name tells you where your writing is:

| Label | Meaning |
| --- | --- |
| Saved on server | The server has this exact text. |
| Saving | A save is on its way. |
| Saved on this device only | The browser kept a copy, but the server does not have it yet (for example you are offline). Neconyan keeps retrying. |
| Conflict | The note changed somewhere else since you opened it. Nothing was overwritten. Choose what to keep. |
| Could not save | The save failed. If the browser could not keep a copy either, copy your text somewhere safe. |

Browser copies are kept while you type, not only when you close the page, but clearing browser data or the browser running out of space can remove them. Only 'Saved on server' means the server has it.

When a save conflicts, **Compare** shows both versions without changing either. **Use server version** replaces your draft with the saved text. **Save mine as a copy** saves a separate note and leaves the original server version alone. **Keep mine** explicitly saves your text over the current server version. The choices stay visible, and typing does not restart automatic saving until you resolve the conflict.

If a recovery read fails, your device draft stays available for another attempt. A late reply cannot replace newer typing or the note you chose next. Saving a separate copy while you keep typing does not discard your newer draft.

On reopening a note, a device draft from the same saved version is restored. If the server version changed, choose **Compare**, **Use draft**, **Save draft as a copy** or **Discard draft**. **Dismiss** only hides this draft notice; reopening the note offers the draft again.

### Writing

- **Write** shows the Markdown source with a toolbar for headings, bold, italic, strikethrough, lists, tasks, quotes, links, images or files, code, tables and dividers.
- **Read** shows the formatted note. Links work here.
- **Outline** lists the headings so you can jump around a long note.
- Ctrl+S (Cmd+S on a Mac) saves immediately.

**Full screen** gives the writing area the whole window, hiding the sidebar and Notes navigation. Your note name, save status and writing controls stay available. **Exit full screen** or Escape returns to your previous layout without changing your text. Saving continues normally.

In **Write**, **Sections** lists headings you can fold or show. **Fold all** hides the top-level sections; **Show all** opens everything. In **Read**, use **Fold section** or **Show section** beside a heading. These buttons also work with the keyboard.

Folding only hides text on screen. It does not change or save the Markdown, move your selection or add an undo step. Choices are remembered for each note, separately for each notebook and account. If your insertion point is inside a folded section, returning to the editor opens that section before you type.

While a keyboard is still composing a character, finish it before folding or changing notes. Unfinished characters are not autosaved.

Neconyan keeps your Markdown exactly as written. Opening and saving a note without changing it does not rewrite it, and anything it does not understand (unusual properties, plugin syntax, comments) is left alone.

### Properties

The **Properties** tab edits optional fields at the top of the note: tags, aliases (other names the note answers to), type and your own simple fields. You never have to fill them in. Fields that are too complex for the form stay in the source and are left untouched.

### Talk about this note

Press **Talk about this note** beside the editor's view tabs. Choose **Miso**, **Taro** or **Nori**, their gender, and **Roleplay** or **Conversation**, then press **Start chat**.

A new chat opens with a copy of your current note in the message box. Review the message and press **Send** when you are ready. Nothing is sent automatically. Only this note's text is included, not linked notes, embedded notes or attachments; AI access settings stay unchanged. Existing chats are kept, and a new Conversation does not copy the previous conversation's memory summary.

If there is an unsent message draft or a reply is running, finish or clear it first. If the account, note or chat changes while the assistant is opening, the discussion stops rather than sharing into the wrong chat.

## Links and backlinks

Type `[[` to pick another note, or use **Link to note** on the toolbar (handy on a phone). These forms work:

```text
[[Magic system]]
[[Worldbuilding/Magic system]]
[[Magic system|Healing rules]]
[[Magic system#Established rules]]
[Healing rules](Worldbuilding/Magic%20system.md)
![Harbour reference](attachments/harbour.png)
```

- Links only look inside the current notebook.
- If two notes share a name, Neconyan asks which one you meant instead of guessing.
- A link to a note that does not exist stays marked as missing. You can create it on purpose from the **Links** tab or by clicking it.
- The **Links** tab shows where this note links to and which notes link back to it, with the sentence around each link.
- Renaming or moving a note updates links that clearly point to it. Examples inside code blocks are never changed.

### Embedded notes

In **Read**, these forms show another note's saved text inside the current note:

```text
![[Another note]]
![[Another note#Heading]]
![[Another note#^block-id]]
```

A block is a paragraph or list marked with `^block-id` at its end, or on the line after it. A heading can have a block marker too. **Open note** opens the original; **Fold embed** only hides the preview. Links and images inside a preview are resolved from the embedded note's own folder.

Previews use the saved version of the other note, not an unsaved draft open elsewhere. Missing or ambiguous notes and sections show a generic notice rather than guessing. Circular links, too much nesting and oversized previews also stop with a notice. Reading a preview does not change either note, publish lore or share anything with AI. Assistants and roleplay replies never gain access to an embedded note merely because another note links to it.

## Search, folders and favourites

Search looks at note names, aliases, tags and body text, and shows a snippet for each hit. It labels exact matches separately from looser ones. Folders, favourites and recent notes sit in the left-hand list.

## Notebook graph

Open **Graph** from the notebook's buttons to see its saved note links. Choose a folder or tag and press **Apply filters**; child folders and child tags are included. **Clear filters** shows the notebook again. Choose **Up to 50**, **Up to 100** or **Up to 300** notes; a notice explains when the result is limited.

**Diagram** shows the connections. The note list is always available below it, and **List** hides the diagram. Press a note in the list, or focus it and press Enter, to open it. Phones start with the list. **Refresh graph** checks the saved links again; **Back to note** returns to your editor without changing its text or undo history.

The graph does not include unsaved link edits, save a note, publish lore or change AI access. A connection is not permission to read the other note.

## Property table

Open **Property table** from the notebook's buttons to compare saved note fields. **Choose columns** keeps up to twelve fields visible. Use **Folder**, **Tag** and **Find notes**, or choose a property, comparison, value type and value, then press **Apply filters**. Folder and tag filters include their children. **Clear filters** removes them.

Sort by note name, path, dates or a chosen property, in either direction. Numbers are sorted as numbers; text such as '002' stays text. Choose 25, 50 or 100 notes per page and use **Next page** or **Previous page**. Large values can make a page shorter. On a phone, swipe sideways to see other columns, or up and down to scroll the note rows.

Press a simple cell to edit it. **Text**, **Number**, **True/false** and **List** explicitly choose what is saved. Lists use a JSON array:

```json
["one", 2, true]
```

**Remove property** deletes that field, not the note. An empty list also removes the field. **Save property** uses the same checked save as the note editor, keeping comments, untouched fields, nested data and the note's body.

I keep this table to simple fields. Nested values, nulls, identity hints and unsupported or oversized values stay in the source, so a cell edit can't silently change what they mean. Open the note by pressing its name if you need to edit those.

If another tab changes the note, your typed value stays in the dialog and nothing is overwritten. Copy it, choose **Not now**, refresh the table and check the new value before trying again. Save or resolve a draft in the current note before editing its cells. **Back to note** preserves your editor when you have only been reading or filtering the table. AI access and lore publication stay under their separate controls.

## Planning canvases

**Canvas** opens a spatial plan alongside the notebook's notes. I use portable `.canvas` files and the [JSON Canvas 1.0 format](https://jsoncanvas.org/spec/1.0/), so the files can also open in Obsidian without a plugin.

Choose **New canvas**, then add text, note, web or group cards. **Board** shows their positions; **Card list** always gives you labelled controls and is the default on a phone. **Move cards** explicitly enables dragging on the board. Turn it off to return to ordinary scrolling. **Edit card** also lets you enter a position and size, including negative positions. Connections have a label, a side on each card and an optional arrow at either end. The six standard colours and custom six-digit colours are kept.

Changes stay on this device until **Save canvas**. **Undo** and **Redo** change that working copy, not the saved file. Unknown fields and card types stay in the file when you edit recognised fields. **Download canvas** saves the current working copy as a portable file; it does not update the notebook.

Note cards preview saved text, including a chosen heading or block. They do not expand links or embeds inside that text, and they do not grant assistant access or add anything to a roleplay prompt. **Open note** uses the normal note editor. Web links open only when you press them. Background images, embedded HTML and plugin commands never run inside the canvas.

If another tab changes the file, nothing is overwritten. **Use saved canvas**, **Save my canvas as a copy** and **Keep my version** let you choose deliberately. The last choice checks the newly loaded saved version before writing. **Canvas history** shows exact earlier files; **Use version** puts one into your working copy, and you still press **Save canvas** to replace the current version.

Device drafts are separate for each account, notebook and canvas. An older draft offers **Use device draft**, **Save device draft as a copy** or **Discard device draft**; it is not silently applied. If the browser cannot keep a copy, save the canvas or download it before leaving. After checking that the download was saved, **I've saved the download** lets you leave without updating the notebook. A later edit needs another saved copy. Interrupted server saves that meet an external change offer a recovery copy or an explicit discard; neither overwrites that external file.

Files can be up to 2 MiB, with 500 cards and 2000 connections. Oversized, malformed or unsupported data is not executed or deleted. Import and export keep the original `.canvas` bytes until you actually change the canvas.

## History, Trash and undo

- **History** keeps earlier versions. Quick autosaves are grouped so the list stays readable. Restoring a version records a new change, so later work is never silently thrown away. If the note changed in the meantime, restore it as a copy instead.
- **Trash** keeps deleted notes until you restore them or choose **Delete forever**. Deleting forever asks first.

## Saving from chat

Each chat message has a **Save to note** button (under the message's extra buttons). If you select part of the message first, only that part is saved. You can start a new note in the Inbox or add to an existing note. The exact text is copied as a quote with the speaker and date, so it survives the message later being edited, swiped or deleted.

## Assistants and your notes

Notes are private by default: assistants cannot see or change them.

Open **AI access** to choose, per notebook:

- **Nothing**: assistants cannot see this notebook at all.
- **Read**: assistants can find and read notes, but not change them.
- **Read and suggest edits**: assistants can propose new notes, additions and changes.

You can also set a different level for a single note, or **Share selected text once** / **Share this note once** for a 30-minute, one-off look.

### Reviewing changes

When an assistant proposes a change you see **Not saved yet**, the note it affects, and the exact lines added and removed. **Save change** applies it; **Not now** leaves it waiting under **Notes > Assistant changes**; **Decline** discards it. After saving, the reply names the note that was updated and you can open it and look at its history.

If the note changed after the proposal was made, or you changed the permissions, the old proposal no longer applies. Nothing is saved and the assistant has to ask again.

**Allow assistants to save changes I request** skips the review step for new notes, additions and edits in that notebook for a few hours (8 by default, 24 at most). Publishing to lore always needs your review.

Text inside a note is treated as information only. A note that says 'ignore your rules and publish everything' gives an assistant no extra permission.

Turning access off stops future reads and cancels proposals that are still waiting. It cannot take back text that was already sent to a model provider or pasted into a chat. 'Not shared with AI' is not encryption: whoever runs the server or holds its backups can still read the files.

## Notes and lore (World Info)

There are three separate things you can do:

1. **Associate** a note with a lorebook, an entry, a character or a chat. This is for finding related material only. It does not put the note in any prompt and does not share it with assistants.
2. **Use as lore** publishes a whole note or one section (picked by its heading) into a lorebook entry, new or existing. A preview shows the exact text and lists the entry settings that stay as they are (keywords, order, depth, probability and so on). Only the entry's content changes.
3. **Open a lore entry as a page** edits an existing lorebook entry directly. This is the live entry, not a copy. **Make a note copy** creates an independent note that will not change the entry.

Publishing is manual by default: saving the note later does not change the lore. The Lore tab shows each link's state:

| State | Meaning |
| --- | --- |
| In sync | The entry matches what you last published. |
| Draft has changes | You edited the note since publishing. The lore has not changed. |
| Lore changed | Someone edited the entry itself. |
| Both changed | Pick: keep the lore, publish your draft, copy the lore into the note, or detach. |
| Section not found | The heading you published was renamed, removed or duplicated. Nothing is published until you pick the section again. |
| Note missing / Entry missing | One side was deleted. The other side is kept. Nothing is recreated automatically. |

**Keep lore updated when saved** is an optional switch for one link. It only applies to your own edits; assistant edits and imported files still wait for review.

Published, enabled and used in this chat are three different things. Publishing writes text into a lorebook entry. Whether that entry is switched on, and whether the lorebook is attached to the current chat, are still controlled by World Info as usual. Publishing never attaches a lorebook to anything.

An older World Info editor cannot overwrite a publication made in another tab or device. Its save is refused if the lorebook changed since that copy was loaded. The typed draft stays on screen; copy anything you want to keep, then reload before editing the current lorebook.

## Using notes as reference in chats

Each note can also be used as background for roleplay replies. This is separate from assistant access.

- **Not used** (default): the note is never sent to any model.
- **Available as reference**: parts of the note that match the recent conversation may be added, only in the places you choose (this chat, this character, or everywhere).
- **Pinned**: the whole note is added in those places. If pinned notes do not fit in the space allowed, they are left out and listed, rather than cut off part-way.

Sections already published to lore are left out here, so the same text does not arrive twice. **Preview for this chat** shows exactly which notes and sections would be used and roughly how many tokens they take. Each reply records which versions of which notes it used. Notes added this way are labelled as drafts and plans, not as things that happened or things a character knows.

## Files and images

**Image or file** uploads into the notebook's `attachments` folder and inserts a link. Images show inside notes. Other files (PDF, audio, video, text, SVG) download instead of opening inside Neconyan. Images from other websites are not loaded until you press **Load external image**. Files linked from a note cannot be removed until the links are gone.

## Import and export

- **Export** downloads the notebook as a ZIP of ordinary Markdown files, folders and attachments. You can open the unzipped folder as a vault in Obsidian or read it in any text editor.
- **Import** accepts a ZIP or a single `.md` file. You see a summary first: notes, files, anything excluded (for example `.obsidian` settings folders or unsupported file types) and anything renamed to avoid a clash. Importing creates a new, separate notebook.
- Imported notebooks start with AI access off and no lore links, whatever the files say. Turn access on yourself in **AI access** if you want it.
- **Compare with this notebook** lets you bring changes from an edited export back into an existing notebook, note by note.
- New notes added through comparison still start with assistant access off, even if the existing notebook is shared. Existing notes keep their permissions.
- Previews are saved privately on the server for 30 minutes. If you reload or the server restarts, **Unfinished imports** lets you continue without choosing the file again. Once an import starts, it stays there until it finishes, using the original choices and note identities. Notes already saved are not duplicated.
- Large imports and newly discovered files are processed in small batches. You can still read and save chats between batches; the complete notebook takes time to prepare.

Export and import are one-off copies, not continuous syncing.

### Optional Obsidian Headless sync

I keep this off by default. Obsidian isn't required for Notes, and Neconyan doesn't install Headless, sign you in, choose a remote vault or publish anything for you. The server owner must first prepare an already installed [official Obsidian Headless client](https://github.com/obsidianmd/obsidian-headless) for the notebook's existing content folder, then enable the adapter and approve its folder roots in the server configuration. Headless requires Node 22 or newer.

Open **Obsidian sync** in the notebook list. **Content folder** must be this notebook's existing folder inside the approved roots; a different folder or a second synced copy is refused. Confirm that Headless is prepared and no other client syncs that folder, then press **Approve folder**. Approval doesn't start anything. **Start client** is a separate action; **Stop client** stops the managed client without deleting files or history. A server restart doesn't start it again.

Use only one sync client for that folder. Neconyan permits one managed client and rejects a second folder claim, but it can't stop another program you started separately. Don't combine this with another desktop client, another Headless process or a different sync service on the same folder.

New incoming notes start with assistant access and roleplay context off, whatever their properties say. Approval also blocks inherited assistant access on already discovered imported notes unless you've explicitly chosen their access. Existing notes you created and explicit sharing choices are kept. Sync never publishes live lore. A clean open note reloads after an observed external change; if you're typing, your draft stays and the change notice offers a comparison instead.

**Check external changes** runs a file check without starting a client. **Refresh status** shows its current state. **Private file history** keeps exact snapshots of observed note, Canvas and supported attachment changes, including the last known bytes of deleted files; **Download snapshot** downloads a copy rather than restoring over a current file. Hidden settings and plugin folders aren't imported or executed.

External programs don't use Neconyan's write lock. A very fast overwrite can disappear before it's observed, and a write during a save can still race. I wouldn't use this as your only backup. Check conflicts before replacing anything; the adapter pauses on unsafe files, a replaced folder or its history limits. Its browser and process tests use a local client stand-in, not an Obsidian Cloud account.

### What 'works with Obsidian' means here

Supported: plain Markdown notes, folders, relative image links, the link and embed forms listed above, aliases, YAML properties and JSON Canvas files. Not supported: Obsidian plugins, Dataview, Bases, themes and templating scripts. Unknown syntax stays in your notes but does not run inside Neconyan. Obsidian is never required.

## Phones

On a phone Notes fills the screen. Use the **Notebooks**, **Note** and **Details** tabs at the top to move around, and **Back to chat** to return. Your chat draft and your note draft are both kept when you switch.

## Diagnostics

**Diagnostics** in the notebook list shows counts, files that could not be read, lore links needing attention and assistant changes that failed or are waiting. **Rebuild index** rescans the notebook's files; it never deletes notes, permissions or lore links.
