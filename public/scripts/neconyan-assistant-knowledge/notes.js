const guide = 'docs/notebooks.md';
const panels = 'public/scripts/notebooks/notes-panels.js';
const app = 'public/scripts/notebooks/notes-app.js';

export default [
    {
        id: 'notes.start', title: 'Opening Notebooks and creating a notebook', keys: ['Notes', 'Notebooks', 'new notebook', 'new note', 'Quick note', 'Notes tour', 'Notebooks sidebar'],
        covers: ['core:notes'], sources: [guide, app, 'public/scripts/notebooks/templates.js', 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['Quick note', 'Inbox', 'Blank note', 'Save to Inbox'],
        content: 'Open Workspace → Notebooks in the desktop sidebar or phone menu; this workspace was previously called Notes. It works without a chat or AI connection and is separate from Companion notes, Persona Scenario Notes and the chat Author\'s Note. First opening creates a Notebook with an Inbox folder. New notebook makes another collection. New note offers your starting templates; Manage templates edits, adds or removes them. Blank note stays available. Quick note opens a small text box: type, then Save to Inbox; its first line supplies the name. On phones, Notebooks, Note and Details switch between panes; Back to chat returns. Miso leads Show me around and Tour without model requests or changes to notes.',
    },
    {
        id: 'notes.editing', title: 'Writing, reading and folding a note', keys: ['Write note', 'Read note', 'note editor', 'Markdown note', 'Full screen note', 'fold sections', 'note outline'],
        sources: [guide, app, 'public/scripts/notebooks/folding.js'], anchors: ['Fold all', 'Show all', 'Full screen'],
        content: 'In Notebooks, Write edits Markdown, Read formats it and Outline groups nested headings. Full screen stays on when switching all three views, keeping the draft and undo history; Exit full screen or Escape restores the workspace. Beside chat hides the introductory card for more writing space. Notes autosave; Ctrl+S or Cmd+S saves immediately. Write has Sections, Fold all and Show all; Show or hide section controls remembers whether that bar is visible. Read has Fold section and Show section. Folding hides sections only on screen; it does not change the note or AI access. Saved on server confirms saving; Saved on this device only means a local draft.',
    },
    {
        id: 'notes.templates', title: 'Editing, adding and removing note templates', keys: ['Manage templates', 'edit note template', 'Add template', 'Remove template', 'Restore default templates', 'template contents'],
        sources: [guide, 'public/scripts/notebooks/template-manager.js', 'public/scripts/notebooks/template-settings.js', 'public/scripts/notebooks/templates.js'], anchors: ['Manage templates', 'Add template', 'Remove template', 'Save templates'],
        content: 'Notebooks → New note → Manage templates edits the chosen template name, suggested note name and Markdown contents. Add template makes a choice; Remove template removes it. Save templates keeps the collection for this account; Cancel discards dialog changes. Blank note is permanent and empty. Restore default templates asks before replacing your collection with Character draft, Location, Scene plan and Session journal. Existing notes never change when a template changes or is removed. Up to 40 editable templates, 64 KiB per body and 512 KiB total. Contents copy literally: no scripts, macro substitution, AI sharing or lore publication.',
    },
    {
        id: 'notes.lists', title: 'Continuing and nesting bulleted, numbered and task lists', keys: ['continue note list', 'numbered list', 'nested bullet points', 'Tab list', 'Shift+Tab', 'Indent', 'Outdent', 'list on Enter'],
        sources: [guide, app, 'public/notes-editor.js', 'public/scripts/notebooks/list-editing.js'], anchors: ['Numbered list', 'Indent', 'Outdent', 'continueList'],
        content: 'In Notebooks → Write, Enter continues a bullet, numbered or task list. Numbers increase and new tasks are unchecked; Enter on an empty item ends the list. Selecting lines and pressing Numbered list gives consecutive numbers. Tab indents a list item by four spaces; Shift+Tab removes one level. Indent and Outdent toolbar buttons also work on selected lines. Frontmatter and fenced code examples stay literal. These edits use normal undo/redo, and list changes wait for composition to finish. Lists are Markdown text, not a separate saved structure.',
    },
    {
        id: 'notes.outline', title: 'Nested headings in the notebook outline', keys: ['outline nesting', 'collapsible outline', 'Links outline', 'subheadings', 'live note headings', 'hide outline branch'],
        sources: [guide, app, panels, 'public/scripts/notebooks/outline.js'], anchors: ['Outline', 'refreshLinksOutline', 'aria-expanded'],
        content: 'Outline and Details → Links group headings beneath their parent headings, including deeper subheadings. The arrow beside a branch hides or shows its children without changing Markdown or folding the source. Choosing a heading jumps to its exact position in Write. The Links outline follows the current editor draft, including unsaved heading changes; it does not wait for a save. Both outlines share this note\'s branch choices. Outgoing links and backlinks remain separate from the heading tree.',
    },
    {
        id: 'notes.saving', title: 'Note save status and conflicting edits', keys: ['note not saving', 'note conflict', 'Saved on this device', 'Saved on server', 'Use server version', 'Keep mine', 'Save mine as a copy'],
        sources: [guide, app, 'public/scripts/notebooks/drafts.js'], anchors: ['Saved on server', 'Saved on this device', 'Save mine as a copy'],
        content: 'In Notebooks, Saved on server means the server accepted the current text. Saving is still pending. Saved on this device only means a browser-local draft; it retries, but clearing browser storage can lose it. Conflict stops autosaving, even if you keep typing. Compare shows both versions without writing. Use server version discards your draft; Save mine as a copy keeps it in a separate note; Keep mine explicitly overwrites the current server version. A recovered draft whose server version changed offers Compare, Use draft, Save draft as a copy and Discard draft. Dismiss leaves the draft available for later. Do not report a local draft or unresolved conflict as saved on the server.',
    },
    {
        id: 'notes.history', title: 'Note history, restoring versions and Trash', keys: ['note history', 'restore note', 'deleted note', 'delete a note in Notebooks', 'Move to Trash', 'note Trash', 'previous note version'],
        sources: [guide, 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['History', 'Trash', 'Delete forever', 'Move to Trash'],
        content: 'Notebooks → History shows saved versions, with routine saves grouped rather than one permanent copy per keystroke. Restoring creates a new current revision and keeps later history. If the note changed since the selected version was inspected, the recovery path can save the old text as a copy instead of silently replacing newer work. Delete, beside Full screen above the open note, asks once and moves that note to Trash; unsaved typing is saved first. Deleted notes go to Trash in the notebook list, where Restore brings them back; Delete forever asks for confirmation. History and Trash are separate from unsaved device drafts and from a portable notebook ZIP export. Keep an account backup for broader recovery.',
    },
    {
        id: 'notes.assistant-chat', title: 'Talk about this note with an assistant', keys: ['Talk about this note', 'discuss my note', 'chat about a note', 'send note to Miso', 'send note to Taro', 'send note to Nori'],
        sources: [guide, 'public/scripts/notebooks/assistant-chat.js'], anchors: ['Talk about this note', 'Start chat'],
        content: 'In Notebooks, choose Talk about this note beside the view tabs. Pick Miso, Taro or Nori, a Male/Female/Neutral variant and Roleplay or Conversation, then Start chat. It opens a fresh assistant chat with the current note text in the composer. Review it and press Send yourself; nothing is sent automatically. Existing chats are kept, and a new Conversation branch does not inherit the old summary. A running reply or unsent composer text blocks the hand-off. Only this note is copied, not linked notes, embedded notes or attachment contents. This does not grant notebook read/edit permissions. If the note, account or target chat changes while opening, retry from the intended note.',
    },
    {
        id: 'notes.scratchpad', title: 'Discussing a note or selection in Scratchpad', keys: ['Ask Scratchpad', 'note in Scratchpad', 'selected text in Scratchpad', 'temporary Scratchpad sharing'],
        sources: [guide, app, 'public/scripts/scratchpad/index.js'], anchors: ['Ask Scratchpad', 'Open Scratchpad', 'Back to Notes'],
        content: 'Notebooks → Ask Scratchpad opens sessions belonging to this note, not a new story chat. Share the whole note or the selected Write passage for 30 minutes. It starts read-only; explicitly tick Allow proposed edits to the shared text if wanted. Unsaved text must save successfully first. Permanent AI access stays unchanged. The open story, linked/embedded notes and attachments are excluded. Context opens first and Show preview displays shared text; choose an assistant and connection before sending. No tool-calling model is needed. Stop sharing revokes the grant, Back to Notes returns, and new sessions do not inherit temporary grants. Already sent text cannot be withdrawn. Scratchpad note suggestions appear in Assistant changes and always wait for review, even with requested-edit saving enabled. Replies, selections and completed sessions can be saved back as quotations without granting access or publishing lore.',
    },
    {
        id: 'notes.links', title: 'Linking notes and finding backlinks', keys: ['note links', 'backlinks', 'wikilinks', 'Link to note', 'rename note links', 'missing note link'],
        sources: [guide, panels, 'public/scripts/notebooks/render.js'], anchors: ['Link to note', 'Links'],
        content: 'Notebooks supports [[Note]], [[Folder/Note|Label]], [[Note#Heading]] and relative Markdown links within the current notebook. Type [[ for suggestions or use Link to note on the toolbar. A missing link can deliberately create a note; an ambiguous name asks you to choose. Details → Links shows outgoing links and backlinks, meaning notes that link here. Renaming or moving a note updates clearly resolved links, not code examples or ambiguous references. Links organise writing; they do not give assistants permission to read the linked notes or automatically add them to a chat prompt.',
    },
    {
        id: 'notes.embeds', title: 'Showing another note inside a note', keys: ['note embeds', 'embed note', 'embedded heading', 'block embed', 'Fold embed', 'circular embed'],
        sources: [guide, 'public/scripts/notebooks/render.js'], anchors: ['Fold embed', 'Open note'],
        content: 'In Notebooks → Read, ![[Note]] displays another saved note, ![[Note#Heading]] displays a heading section and ![[Note#^block-id]] displays a named block. Open note goes to the source; Fold embed hides its preview. Previews use saved text, so an unsaved target draft is not shown. Missing, ambiguous, circular or oversized content is reported rather than expanded indefinitely. Embedding does not copy the source into this note, run plugins or grant AI access. Talk about this note and assistant reading do not automatically expand embedded notes into model context.',
    },
    {
        id: 'notes.properties', title: 'Finding notes and editing their properties', keys: ['note search', 'note tags', 'note aliases', 'note properties', 'favourite notes', 'frontmatter'],
        sources: [guide, panels], anchors: ['Properties', 'aliases'],
        content: 'Notebooks search covers names, aliases, tags and body text. Aliases are alternate names for finding and linking a note. Details → Properties edits tags, aliases, type and simple fields. Each custom row places Field beside Value; Add field creates another row without saving first. Field names suggest keys used in this notebook. Rename or remove rows, then Save properties once. The form is disabled while saving. Existing numbers, true/false values and lists keep their types; lists use a JSON array. Only changed fields are written, with conflict checks; nested data and untouched comments stay in the source. Property table remains the separate notebook-wide view for comparing saved fields.',
    },
    {
        id: 'notes.property-table', title: 'Comparing notes in Property table', keys: ['Property table', 'Choose columns', 'Save property', 'Remove property', 'note table filters'],
        sources: [guide, 'public/scripts/notebooks/property-table.js', 'src/notebooks/property-table.js'], anchors: ['Choose columns', 'Save property', 'Apply filters'],
        content: 'Notebooks → Property table compares saved note properties. Choose columns selects up to 12; Folder, Tag, Find notes and typed comparisons narrow the rows after Apply filters. Pages show 25, 50 or 100 notes. Edit supports Text, Number, True/false and List; Save property checks the saved revision before writing. Remove property removes that field, not the note. Nested or unsupported values remain source-only. Finish any unsaved note draft before editing its table cells. A stale revision keeps your typed value for review rather than overwriting newer work. This table reads saved files, not live unsaved editor text.',
    },
    {
        id: 'notes.graph', title: 'Viewing the notebook link Graph', keys: ['note Graph', 'notebook graph', 'Refresh graph', 'graph filters', 'graph Diagram', 'graph List'],
        sources: [guide, 'public/scripts/notebooks/graph.js'], anchors: ['Refresh graph', 'Apply filters', 'Back to note'],
        content: 'Notebooks → Graph shows connections between saved notes. Use Folder and Tag, then Apply filters; folder filters include matching descendants. Choose Up to 50, 100 or 300 notes. Diagram draws connections and List offers accessible rows for opening notes; phones start with List. Refresh graph rescans saved links and Back to note returns to the editor. Unsaved link edits will not appear yet. Graph is a navigation view, not a lore activation map: it does not enable AI access, publish lore or add linked text to model context.',
    },
    {
        id: 'notes.canvas', title: 'Creating and saving a notebook Canvas', keys: ['notebook Canvas', 'New canvas', 'Save canvas', 'Move cards', 'canvas cards', 'JSON Canvas'],
        sources: [guide, 'public/scripts/notebooks/canvas.js'], anchors: ['Save canvas', 'Move cards', 'Card list'],
        content: 'Notebooks → New canvas creates a JSON Canvas 1.0 .canvas board with text, note, web and group cards, plus labelled connections and arrows. Board is the visual view; Card list, the phone default, provides accessible editing. Move cards deliberately enables dragging; otherwise touch moves the view. Edit card also offers numeric position and size. Changes stay on this device until Save canvas succeeds. Undo/Redo changes the local draft; Download canvas exports it without saving to the server. Linked-note previews use saved text and do not expand more notes or grant AI access. A canvas supports up to 2 MiB, 500 cards and 2,000 connections.',
    },
    {
        id: 'notes.canvas-recovery', title: 'Recovering a canvas draft or conflicting version', keys: ['canvas conflict', 'canvas history', 'canvas draft', 'Use saved canvas', 'Save my canvas as a copy', 'Keep my version'],
        sources: [guide, 'public/scripts/notebooks/canvas-dialogs.js', 'public/scripts/notebooks/canvas-drafts.js'], anchors: ['Use saved canvas', 'Save my canvas as a copy', 'Keep my version'],
        content: 'A canvas is saved only after Save canvas succeeds. If another writer changed it, Use saved canvas discards the local version, Save my canvas as a copy preserves both, and Keep my version deliberately replaces the latest saved version. A recovered device draft requires a choice rather than silently overwriting the server. Canvas history → Use version loads that version into the local draft; press Save canvas to make it current. Download canvas preserves an external copy of the current draft but does not resolve a server conflict or count as a server save.',
    },
    {
        id: 'notes.ai-access', title: 'Giving assistants access to notebook notes', keys: ['note AI access', 'notebook permissions', 'Assistants can', 'Share selected text once', 'Share this note once', 'assistant cannot read notes'],
        sources: [guide, panels, 'public/scripts/notebooks/assistant-note-tools.js', 'src/notebooks/assistant.js', 'src/notebooks/permissions.js'], anchors: ['Assistants can', 'Share this note once', 'Read and suggest edits', 'minutes = 30'],
        content: 'In Notebooks → AI access, Assistants can defaults to Nothing for each notebook. Choose Read or Read and suggest edits, with per-note overrides where needed. Share selected text once or Share this note once gives a temporary grant, normally 30 minutes. Hidden notes are filtered before assistant listing, searching, reading and link results. Revoking access stops future reads and waiting changes, but cannot withdraw text already sent to a model. Text inside a note cannot grant permissions. Assistant tools in ordinary assistant chats require a compatible tool-calling model; Scratchpad uses the same permissions without needing tool calling. These permissions are separate from Roleplay reference inclusion and from manually copying a note into the composer with Talk about this note.',
    },
    {
        id: 'notes.assistant-changes', title: 'Reviewing assistant note changes before saving', keys: ['Assistant changes', 'Save change', 'Not saved yet', 'assistant edit note', 'assistant create note', 'Not now'],
        sources: [guide, panels, 'public/scripts/notebooks/assistant-note-tools.js'], anchors: ['Not saved yet', 'Save change', 'Decline'],
        content: 'With Notebooks AI access set to Read and suggest edits, Miso, Taro and Nori can propose creating, appending to or editing notes and properties. The proposal says Not saved yet and shows the change. Save change applies it; Not now leaves it waiting in Notebooks → Assistant changes; Decline discards it. Changed note revisions or revoked permissions prevent stale proposals from applying. A proposed change is not a saved note, so assistants must report the actual tool result. Lore publication has its own permission and always requires review. Allow assistants to save changes I request, without a review step is a separate, temporary opt-in, not the default.',
    },
    {
        id: 'notes.requested-save', title: 'Letting assistants save requested note edits directly', keys: ['Allow assistants to save changes I request', 'without a review step', 'automatic note saving', 'direct note edits', 'requested note changes'],
        sources: [guide, panels, 'src/notebooks/permissions.js'], anchors: ['Allow assistants to save changes I request, without a review step', 'REQUESTED_EDIT_MAX_MS', 'patch.requestedEdits.hours ?? 8'],
        content: 'Notebooks → AI access offers Allow assistants to save changes I request, without a review step. This temporary opt-in normally lasts 8 hours, with a 24-hour maximum. It permits requested create, append and edit actions within the current read/edit permissions, not unrestricted changes or new access. Revoking it returns edits to review. Scratchpad proposals always require review, regardless of this setting. Let assistants suggest publishing to lore (always reviewed) is a different permission: even with direct note saving allowed, lore publication still requires explicit review. Never claim a note was saved merely because the assistant proposed text; check the successful save result.',
    },
    {
        id: 'notes.lore-publish', title: 'Publishing a note or heading as lore', keys: ['Use as lore', 'publish note', 'note to lorebook', 'publish heading', 'note lore association'],
        sources: [guide, panels, 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['Use as lore', 'Publish'],
        content: 'In Notebooks, Use as lore publishes the whole note or one heading section. Choose a lorebook and a new or existing entry, review the preview, then Publish. Updating an existing entry changes its content while retaining its keys and other activation settings. Publishing does not automatically enable the entry or attach its book to a chat. Lore-tab associations to a character, chat, book or entry are organisational links only; they do not inject note text. Later note saves do not update published lore by default. Assistant publication proposals require the separate lore permission and review, even when requested note edits may save directly.',
    },
    {
        id: 'notes.lore-updates', title: 'Keeping a published note and lore entry in sync', keys: ['Keep lore updated when saved', 'Lore changed', 'Both changed', 'Section not found', 'note lore sync', 'Entry missing'],
        sources: [guide, panels], anchors: ['Keep lore updated when saved', 'Both changed', 'Section not found'],
        content: 'A published note link normally updates lore only after review. Keep lore updated when saved allows the link owner\'s own note saves to update it; assistant, imported and external changes still wait for review. Status can say In sync, Draft has changes, Lore changed, Both changed, Section not found, Note missing or Entry missing. Inspect both sides before choosing which text to keep. Missing notes, headings or entries are not silently recreated or attached elsewhere. A lore-bound region is excluded from separate notebook Roleplay context to avoid repeating it, and an unresolved binding holds that region out until resolved.',
    },
    {
        id: 'notes.lore-pages', title: 'Opening a lore entry as a note-style page', keys: ['Open a lore entry as a page', 'Open lore entry as page', 'Make a note copy', 'lore entry page', 'edit lore as page'],
        sources: [guide, app, panels], anchors: ['Open a lore entry as a page', 'Make a note copy'],
        content: 'Notebooks → Lore → Open a lore entry as a page is a note-style editor for the live lore entry. Save entry edits that entry directly; it does not create a notebook note. Make a note copy creates an independent Markdown note instead. Editing the copy does not change the source entry unless you deliberately publish or link it. The entry\'s activation still depends on its lorebook settings and chat attachment. Opening it as a page is not a permission grant for assistants and does not automatically turn a notebook into lore.',
    },
    {
        id: 'notes.roleplay-context', title: 'Using notebook notes as Roleplay reference', keys: ['notes in Roleplay', 'note reference context', 'Available as reference', 'Pinned note', 'Preview for this chat', 'This note is'],
        sources: [guide, panels, 'src/notebooks/context.js', 'src/generation/roleplay-execution.js'], anchors: ['Available as reference', 'Preview for this chat'],
        content: 'Notebooks → AI access has a separate Roleplay setting: This note is → Not used (default), Available as reference for matching sections, or Pinned for the whole note within its chosen scope: this chat, this character or everywhere. Preview for this chat shows eligible content. This integration runs in native server Roleplay replies, not Conversation or Mewmory. It treats notes as drafts/plans, not established events or character knowledge. The default allowance is 15% of free context, capped at 2,000 tokens, with at most eight matched sections; an oversized pinned note is reported rather than silently cut. Lore-bound regions are excluded, including unresolved bindings. Assistant read/edit permission is separate.',
    },
    {
        id: 'notes.chat-clips', title: 'Saving a chat message to a note', keys: ['Save to note', 'clip message', 'save message in notebook', 'quote chat in note'],
        sources: [guide, 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['Save to note'],
        content: 'Open a chat message\'s extra buttons and choose Save to note. It copies the selected text, or the whole message when nothing is selected, as a quotation with speaker and date. Save it to a new Inbox note or an existing note. This is a separate copy: later message edits, swipes or deletion do not update or erase the saved quotation. Saving a clip does not publish lore or grant assistant access to its notebook.',
    },
    {
        id: 'notes.attachments', title: 'Attaching images and files to notes', keys: ['note attachments', 'Image or file', 'Load external image', 'delete note attachment', 'SVG note'],
        sources: [guide, app, 'public/scripts/notebooks/render.js', 'src/notebooks/attachments.js'], anchors: ['Image or file', 'Load external image', 'MAX_ATTACHMENT_BYTES'],
        content: 'Use Image or file in Notebooks to upload a supported attachment up to 20 MiB. Images can preview in Read; other files, including SVG, are offered as downloads. Remote images wait for Load external image before contacting their host. An attachment still linked by notes cannot be deleted until those links are removed. An attachment link is not the file\'s extracted text, and does not automatically share its contents with an assistant or Roleplay model. Notebook exports include attachments; a plain copied Markdown file may still need its linked files.',
    },
    {
        id: 'notes.import-export', title: 'Importing and exporting a notebook', keys: ['import notebook', 'import a notebook', 'export notebook', 'notebook exported', 'Markdown ZIP', 'Compare with this notebook', 'Unfinished imports', 'Obsidian import'],
        sources: [guide, 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['Compare with this notebook', 'Unfinished imports'],
        content: 'Notebooks imports Markdown or ZIP after a preview. Ordinary import makes a separate notebook with AI access off and no published lore. Compare with this notebook applies selected changes; existing permissions remain, new notes start private. Hidden .obsidian settings, plugins and unsupported files are excluded. Unfinished imports resumes accepted work after reload or restart without duplicates; unused previews expire after 30 minutes. Export offers Whole notebook, A folder with optional subfolders, or Choose notes. Load more notes pages large lists. Partial ZIPs contain only chosen notes and their directly linked files, never other linked notes. Whole exports retain all supported content, including canvases. No permissions, history, lore bindings or provenance are exported. Export saves the current draft first. This is file transfer, not live sync or a complete account backup.',
    },
    {
        id: 'notes.obsidian-sync', title: 'Setting up optional Obsidian Headless sync', keys: ['Obsidian sync', 'Obsidian Headless', 'Content folder', 'Approve folder', 'Start client', 'Stop client'],
        sources: [guide, 'docs/notebooks-technical.md', 'public/scripts/notebooks/obsidian-dialogs.js'], anchors: ['Approve folder', 'Start client', 'Stop client'],
        content: 'Obsidian sync is optional and off by default. An administrator must enable it, approve allowed server folders and preinstall/configure the official Headless client for an existing content folder; the documented setup needs Node 22 or newer. Neconyan does not install the client, log in or choose a remote vault for you. In Notebooks → Obsidian sync, enter Content folder, confirm it is ready and only one client will manage it, then Approve folder. Start client is a separate action; approval alone does not start syncing. Stop client leaves files intact, and a server restart does not automatically restart the client. Newly received notes start with AI access and Roleplay inclusion off and are not published as lore.',
    },
    {
        id: 'notes.external-changes', title: 'Checking external note changes and private file history', keys: ['Check external changes', 'Private file history', 'Download snapshot', 'external note changes', 'Obsidian compatibility'],
        sources: [guide, 'public/scripts/notebooks/obsidian-dialogs.js'], anchors: ['Check external changes', 'Private file history', 'Download snapshot'],
        content: 'For an approved Obsidian content folder, Check external changes imports detected file changes and Refresh status updates the client report. Existing explicit access choices are retained; incoming new notes do not gain AI or Roleplay access or publish lore. Private file history and Download snapshot help inspect earlier local files, but are not a complete backup against simultaneous external writers. Neconyan preserves unsupported Obsidian text where possible without running plugins, Dataview, Bases, themes or templates. Browser-only note editing does not itself connect to Obsidian Sync; the separately prepared server client is required.',
    },
    {
        id: 'notes.diagnostics', title: 'Diagnosing unreadable notes and rebuilding the index', keys: ['note diagnostics', 'unreadable notes', 'Rebuild index', 'notebook index', 'note search missing'],
        sources: [guide, app, 'public/scripts/notebooks/notes-dialogs.js'], anchors: ['Check notebook', 'Rebuild index'],
        content: 'Notebooks → Check notebook opens diagnostics for unreadable files, lore links and waiting assistant changes. Rebuild index rescans notebook files for navigation and search; it does not delete notes or repair their text by asking a model. Inspect reported files and any save or import errors before assuming a missing search result means the note is gone. This notebook index is separate from Vectorization embeddings and Mewmory indexes. A successful rebuild does not resolve unsaved local drafts, enable assistant permissions or publish lore.',
    },
];
