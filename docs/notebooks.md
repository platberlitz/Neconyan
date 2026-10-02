# Notes

Notes is a notebook that lives inside Neconyan. Use it for ideas, drafts, world-building, references, session journals or anything else you want to keep. A note does not need a chat or a character.

Open it from **Notes** in the workspace rail (the sidebar on desktop, the drawer on a phone). It works with no chat open and with no AI connection.

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
| Could not save | Neither the server nor the browser could store the change. Copy your text somewhere safe. |

Browser copies are kept while you type, not only when you close the page, but clearing browser data or the browser running out of space can remove them. Only 'Saved on server' means the server has it.

### Writing

- **Write** shows the Markdown source with a toolbar for headings, bold, italic, strikethrough, lists, tasks, quotes, links, images or files, code, tables and dividers.
- **Read** shows the formatted note. Links work here.
- **Outline** lists the headings so you can jump around a long note.
- Ctrl+S (Cmd+S on a Mac) saves immediately.

Neconyan keeps your Markdown exactly as written. Opening and saving a note without changing it does not rewrite it, and anything it does not understand (unusual properties, plugin syntax, comments) is left alone.

### Properties

The **Properties** tab edits optional fields at the top of the note: tags, aliases (other names the note answers to), type and your own simple fields. You never have to fill them in. Fields that are too complex for the form stay in the source and are left untouched.

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
- `![[Another note]]` (embedding a whole note) is kept in the text and shown as a labelled chip. Neconyan does not paste the other note's content in yet.

## Search, folders and favourites

Search looks at note names, aliases, tags and body text, and shows a snippet for each hit. It labels exact matches separately from looser ones. Folders, favourites and recent notes sit in the left-hand list.

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

Export and import are one-off copies, not continuous syncing.

### What 'works with Obsidian' means here

Supported: plain Markdown notes, folders, relative image links, the link forms listed above, aliases and YAML properties. Not supported: Obsidian plugins, Dataview, Bases, Canvas, themes, templating scripts and block embeds. Their files and syntax are kept but do not run inside Neconyan. Obsidian is never required.

## Phones

On a phone Notes fills the screen. Use the **Notebooks**, **Note** and **Details** tabs at the top to move around, and **Back to chat** to return. Your chat draft and your note draft are both kept when you switch.

## Diagnostics

**Diagnostics** in the notebook list shows counts, files that could not be read, lore links needing attention and assistant changes that failed or are waiting. **Rebuild index** rescans the notebook's files; it never deletes notes, permissions or lore links.
