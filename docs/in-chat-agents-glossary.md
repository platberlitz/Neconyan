# In-Chat Agents Glossary

For setup and usage questions, start with [Agents in the official handbook](https://platberlitz.github.io/neconyan-docs/helpers/agents/).

Every label here matches what you see on screen. Search for the word you saw, read the short entry, and jump back. Sections follow the order you meet things: the Agents panel, then an agent's editor, then the Companion panel.

## Core Terms

**Agent**: a saved prompt plus settings that decide when it runs, which model it uses and where its result goes. In-Chat Agents (ICA for short) is the extension that runs them.

**Inline agent**: an agent that works on the main reply itself. It can add instructions to the prompt before the reply is written, or change the reply afterwards.

**Companion**: an agent that makes its own separate model request after a reply and saves the result as a note. It never replaces the reply.

**Main model**: the model that writes the normal chat reply.

**Context**: everything sent to a model in one request - system prompt, character card, persona, World Info, Author's Note, recent messages and any agent prompts.

**Macro**: a placeholder such as `{{char}}`, `{{user}}` or `{{random::a::b}}` that Neconyan fills in before sending.

## Main Agents Panel

Open **Agents** to find everything below. The top of the panel shows a status line (for example 'Ready' or 'Running an agent…'), counts of agents, enabled agents and companions, and **Prompt tokens**.

| Control | What it does |
| --- | --- |
| **Agents On / Agents Off** | Pauses or resumes every agent at once. Each agent keeps its own switch. |
| **Stop agent** | Cancels the agent that's running right now. Only shown during a run. |
| **Create agent** | Opens a blank agent editor. |
| **Browse library** | Opens the Agent library of ready-made agents and starter kits. |
| **Select** | Lets you tick several agents and change them together. |
| **Saved setup** | Saves your agents and their switches under a name, then loads or deletes that setup later. Loading keeps agents that aren't in the setup. |
| **How Agents work** | Opens this page. |
| **More tools** | Opens the menu below. |

**More tools** menu:

| Item | What it does |
| --- | --- |
| **Update templates** | Updates bundled agents that have a newer version. Only shown when an update is waiting, and it then reads **Update All** with a count. |
| **Fix trackers** | Reruns your enabled trackers, and the companions linked to them, on the last reply. |
| **Companion activity** | Opens the list of your companions with their latest results. |
| **Move trackers to companions** | Turns inline tracker agents into companions that run on their own. |
| **Import agents** | Adds agents from a JSON file. |
| **Export agents** | Downloads all your agents as `in-chat-agents.json`. |
| **Reset bundled agents** | Puts bundled agents back to their original settings. Your own agents aren't touched. |

**Manage agents** and **Connections & defaults** switch between the agent list and the shared settings.

The list tabs are **All**, **Pinned**, **Before reply**, **After reply** and **Companions**. The **Search agents** box and the category filter (Tracker, Randomizer, Content, Companion, Custom) only change what you see. They never switch anything off.

**Prompt tokens** counts the agent prompts added to the main request. Companion requests and other agent requests cost extra on top of that.

### Agent Cards

Each agent has a card. The round switch turns it on or off, the star pins it to the Pinned tab, and the grip lets you drag it into a new order. The small labels only show what matters at a glance, such as its trigger chance, connection profile, model or where companion notes go. Order, depth, regex rules and version are listed at the top of the editor and of **Quick settings** instead. Tapping the card itself does nothing, so you cannot open something by accident; use its buttons. A label such as 'Update v3 → v4' means an update is waiting; click it to update just that agent.

| Button | What it does |
| --- | --- |
| **Run** / **Apply to reply** | Runs the agent on the last assistant reply now. Companions say Run, inline agents say Apply to reply. |
| **Edit** | Opens the full editor with every setting. On phones it fills the whole screen. |
| **More actions** | Opens **Quick settings** (a short popup with the most used options: connection, model, timing and, for companions, notes and history; its **Open full editor** button keeps your changes and opens the editor), **Preview feedback** or **Preview prompt**, **Apply to target** (run it on a chosen reply, note or your text box), **To companion** / **To prompt or reply**, **Export** and **Delete**. |

**Quick settings** and the editor use the same names for the same fields.

Companion cards also show these controls right on the card, and each change saves straight away:

| Control | What it does |
| --- | --- |
| **Keep in chat history** | Sends this companion's saved notes with later replies. |
| **notes** box | How many of its most recent notes to keep. Leave it blank to keep all of them. Typing a number also switches **Keep in chat history** on. |
| **Connections** | Opens tick boxes for the other companions: **Runs after** (reads their latest notes first and runs again when they change), **Sends notes to** (they get this companion's latest note as extra context) and **Shares one request with** (runs with them in one request when their connections and models match). The line beside it sums up the current links. **More connection options** opens the full list with search. |

### Changing Several Agents

Press **Select**, tick the agents you want, or use **Select filtered**. The bar then offers **Quick settings**, **Batch & connect**, **Keep in history** with a **notes** box (blank keeps all notes) and **Stop keeping**. **More changes** adds **Enable**, **Disable**, **On Companions** (lets the selected after-reply agents also work on companion notes), **System role**, **User role**, **To companion**, **Edit other properties** and **Delete**. **Edit other properties** only changes the fields you move off 'Don't change'.

## Connections & Defaults

Open this with **Connections & defaults** at the top of the Agents panel. These settings apply to every agent that doesn't set its own.

**Default connection profile**: the connection agents use. **Current connection** follows whatever you're chatting with, so if your main model is GLM, agents use GLM too.

**Companion connection profile**: a separate default just for companions. A quick, cheap model works well here. **Default connection** means 'use the one above'. A companion's own profile, set in its editor, beats both.

**After-reply agents**: how after-reply rewrite and append agents run. **Run together** sends every agent the original reply at once. When several agents return different rewrites, one extra request combines their compatible edits into a coherent reply, using the last participating rewrite agent's connection and the largest output limit among those rewrites. Later agents take priority where their edits conflict. The combining request also reads the added blocks for consistency. Identical rewrites, a single rewrite and append-only runs need no extra request. **Run one at a time** follows each agent's Order, so later rewrites read the earlier edits, and is kinder to rate limits. Either way, rewrite agents only edit the reply itself: added blocks such as choices or trackers are set aside, cleaned of any copy of the reply and of duplicates, then placed back around the finished reply.

**Companion agents**: the same choice for companions. Batching and 'wait for' links can still group or delay particular companions.

**Run companions at the same time as after-reply agents**: starts companions while reply changes are still running. Faster, but companions then read the reply before it's been rewritten. Leave it off if a companion needs the final text.

**Agent prefill messages**: extra text sent at the start of agent requests, split into `[system]`, `[user]` and `[assistant]` blocks. Most people should leave it empty. Models that refuse prefills can fail when there's anything in it.

**Keep individual and group chat switches separate**: remembers which agents are on separately for one-to-one chats and group chats.

**Show agent edit notifications**: the master switch for pop-up notices from reply changes. Each agent also has its own switch.

**Keep the original when an Agent refuses**: in **Context & notifications**, on by default. When a rewrite, append, intercept or combining pass answers with a refusal instead of the text, Neconyan discards it, keeps the original and says so in a notice. Refusal wording already in the original doesn't count, so characters can still refuse things in the story.

**Show the reply before agents check it**: shows the reply as it arrives, before an agent that checks the reply has finished. A testing aid; leave it off unless you're debugging such an agent.

**Companion panel button**: opens the Companion panel from a **Floating side button** or a **Top bar button**.

**Keep Pawthfinder available**: keeps Pawthfinder and its lorebook tools loaded. Turning it off unloads them everywhere without touching other agents. The status line under it says whether Pawthfinder is on, or what is still missing: the Pawthfinder agent, the main **Agents On** switch, or the Pawthfinder agent's own switch (the same switch as its card and the top of **Open Pawthfinder**). **Open Pawthfinder** opens its own settings.

## Agent Editor

Open it with **Edit** on a card, **Open full editor** in **Quick settings**, or **Create agent**. The line under the title sums up the agent: when it runs, where its result goes, its order, regex rules and version. On phones the editor fills the whole screen and the tabs sit in a row you can scroll sideways. Changes only stick when you press **Save**; **Cancel** asks before throwing away unsaved changes.

The tabs follow the order you usually need them: **What it does**, **When it runs**, **What it changes**, **Companion notes** (companions only), **Model** and **Regex**. Only **What it does** needs filling in; the other tabs are optional. **What it changes** only shows when there is something to change: a prompt placed in the request, a change to the reply, or a companion feeding its notes back.

### What It Does

**Name** and **Description**: what the agent list shows.

**Category**: Tracker, Randomizer, Content, Companion, Tool or Custom. Tracker also unlocks the Custom Tracker Builder and tracker repair.

**Where results go**: **Prompt or reply** puts the result into the request before the reply, or changes the reply after it. **Companion note** makes it a companion that writes its own note beside the reply instead, and adds the **Companion notes** tab. Companion category always uses Companion note. A line under the choice explains the one you picked.

**Pin this agent**: adds it to the Pinned tab.

**Prompt**: the agent's instructions. Say what to look at, what to produce and what not to do. Tell a companion not to continue the roleplay. Saving with an empty prompt brings you back here.

**Preview**: shows the prompt with macros filled in, exactly as the model will get it.

**Refine**: asks AI to improve the prompt (clarity, shorter, more specific, less slop or your own instruction). Read the result before you press **Accept**, especially for trackers with an exact format.

**Custom Tracker Builder**: shown under the prompt when Category is Tracker. Fill in **Tracker Format Example** (the exact output you want), optional **Rules / Behavior Notes** and **HTML / Style Notes**, then press **Generate Kit**. It drafts the prompt, extraction and display regex for you. Check what it made before using it in a chat you care about.

## When It Runs

**Run timing**: **Before reply** runs before the reply is written, so it can add to or change the request. **After reply** runs after the reply arrives, so it can check, rewrite or add to it. **Before and after** does both. Companions don't show this choice; they always run after the reply.

**Order**: lower numbers run first. It sets the sequence, not importance, and matters most when agents run one at a time (see Connections & defaults).

**Chance to run (%)**: the chance the agent runs when everything else matches. 100 is always, 0 is never on its own.

**Only run when these words appear**: comma-separated words the chat must contain. Leave it empty to run every time.

**Run for these kinds of reply**: which actions can trigger it: **Normal** replies, **Continue**, **Impersonate** and **Quiet** background requests from other tools.

## What It Changes

### Where Its Prompt Goes

Decides where a before-reply prompt, or a companion's fed-back notes, go in the request the AI receives.

**Add to the request or change it** (before-reply agents): **Add its prompt to the request** adds the prompt straight into the main request with no extra cost, like a preset toggle. **Run first and change the request** makes a separate request first (an intercept) that can rework the request or the reply. Intercepts cost more.

The next settings only appear for intercepts:

| Setting | What it does |
| --- | --- |
| **Timing** | **Pre-generation** reworks the request before the main model sees it. **Post-main generation** works on the reply after it's written. |
| **Apply Mode** | **Replace context** swaps in the agent's result. **Wrap / append** keeps the original and adds the result. **Patch via tags** only replaces what sits between the patch tags. |
| **Insert Position** | Puts a wrapped result **After original context** or **Before original context**. |
| **Wrap Prefix** / **Wrap Suffix** | Fixed text placed around a wrapped result. |
| **Patch Start Tag** / **Patch End Tag** | The tags Patch mode looks for, `<context_patch>` and `</context_patch>` by default. |
| **Maximum output tokens** | Output limit for the intercept request. |

**Position**: **In Prompt** (with the normal prompt), **In Chat** (among the messages) or **Before Prompt**.

**Depth**: for In Chat, how many messages up from the newest one it goes. 0 is the very end. Companion feedback uses it too.

**More placement options** holds two rarer settings. **Sent as** sends the text as **System**, **User** or **Assistant**; some models take User instructions more seriously than late System ones. **Let World Info entries trigger on this text** lets words in this prompt or note trigger World Info entries; turn it off if the prompt names lots of things that set off unrelated lore.

### Changes to the Reply

Shown for after-reply agents that write into the prompt or reply.

**Use this agent's prompt to rewrite or add to the reply**: after the reply is written, sends it to the agent for a separate edit. **How it changes the reply**: **Rewrite the reply** replaces the reply, so the agent has to return the whole message; **Add to the end of the reply** keeps the reply and adds the agent's text after it. **Maximum output tokens** is the limit for that request; rewrites need enough room for the full reply. **Recent messages** lets it read up to 30 earlier messages as context; they are never rewritten.

**Show a notification while it works**: shows progress, as long as the global notification switch is on too.

**Also change text written with Impersonate**: also runs this agent's reply changes and regex on text written for you.

**Also change companion notes**: also runs them on companion notes before they're saved. **Companions to change** limits this to chosen companions; none picked means all. Don't point a prose rewriter at a strict tracker unless its prompt keeps the tracker's format.

**Save or add text without the AI**: simple non-AI steps. **Extract to Variable** saves text matched by a pattern into a variable. **Append Text** adds fixed text after the reply.

## Companion Notes

Shown when Where results go is Companion note. This is where a companion's own settings live, in three groups.

**AI Maker**: writes a draft companion prompt from your description. **Preview Feedback**: shows the notes this companion would feed into the next reply.

### How It Runs

| Setting | What it does |
| --- | --- |
| **Order** | Lower runs first when companions run one at a time, and sets their order in the panel. |
| **Run companion** | **Automatically after replies** runs by itself. **Only when I run it** is manual only. |
| **Show notes** | **Under replies** as a note card, in the **Companion panel**, or **Hidden** (saved but not shown). |
| **Format** | Asks for **Markdown**, **Safe HTML** or **Plain text**. |

> [!NOTE]
> Hidden isn't the same as the eye button in the Companion panel. Show notes decides where a note shows up. The eye button just stops the companion running automatically, without changing Show notes or deleting notes.

**Order** doesn't make one companion wait for another when they run together. Use **Runs after** under **Connections to other companions** for that.

### What It Reads

**Chat messages to read**: the fewest recent messages the companion reads. 10 means at least ten.

**Start after chat tokens**: waits until the chat is about this long before running automatically, and keeps reading older messages until it has this many tokens. 0 turns it off.

**Previous notes to read**: how many of its own earlier notes it rereads, 1 to 10. Needs **Read its previous notes**.

Tick **Include character card**, **Include persona**, **Include World Info**, **Include Author's Note** and **Include System Prompt** to add those to its request. The character card part skips the greeting and example dialogue.

> [!NOTE]
> Every extra source costs tokens and can distract the companion. A simple tracker usually only needs recent messages and its own last note.

**Read its previous notes**: sends this companion's earlier notes back to it, so a tracker can update its last state instead of starting over. Empty or failed notes are skipped.

### Notes It Remembers

**Keep in chat history**: sends saved notes to the main model with later replies. Read its previous notes is for the companion's own memory; this one is for the main model's. Also on the companion card, in the Select bar and in the Companion panel.

**Notes to keep when not keeping all**: how many recent notes stay in history. **Keep all saved notes** keeps every one, which adds up fast in long chats.

**Where kept notes go**: **Newest reply** attaches the kept notes to the latest reply, **Each note's own reply** leaves each note with the reply it came from, and **One labelled block** gathers them under `[<Name> - kept notes]`, placed with this agent's Position, Depth, Sent as and World Info fields under What it changes. Also in **Quick settings**.

**Keep notes when the reply is hidden**: keeps a note even after you hide the message it's attached to.

**Feed recent notes into future generations**: slips recent notes into the main request using this agent's Position, Depth and Sent as from What it changes. **Recent notes to feed back** sets how many, 1 to 10.

> [!NOTE]
> Feedback and Chat History are two routes for the same notes. Feedback puts them at a set position; Chat History carries them with the messages. A note already in Chat History isn't fed back again.

### More Companion Options

**Maximum output tokens**: output limit for the companion's note.

**Use agent prompt as-is (no added instructions)**: stops Agents adding its usual format instruction. Handy when the prompt already spells out the exact output.

### Connections to Other Companions

**Share one request with linked companions**: lets this companion share one request with those picked in **Companions that share this request**. They only batch when their connection, model, context and target match; otherwise they run separately.

**Send latest notes to other companions**: passes this companion's latest note to the ones picked in **Companions that receive its notes**. It only goes one way.

**Runs after**: it reads the notes of the companions picked here, and runs again when any of them writes a new note. **Delay until selected companions finish** makes it wait for them in the same run instead of running twice. Long chains add requests and time.

### Template-Only Settings

**Chatroom Style**, **Custom Style Library** and **Extra Character Reactors** (Chatroom): the chat style, your own styles in `Name: instructions` form, and up to 12 outside characters who comment.

**Director Voice** and **Custom Voice Library** (Director's Commentary): the commentary voice, including your own voices.

**Plot Objective** (Plot Compass): where you'd like the story to go, without forcing the current scene.

## Model

**Connection profile** and **Model override**: use a different connection or model for this agent only. Leave them on **Use the shared default** and empty to follow Connections & defaults.

## Agent Regex

**Add Regex** attaches a regex script to this agent; **Load Bundled Regex** restores the scripts a bundled agent came with. Scripts run when the agent does, and can find, remove or reformat text. Bundled trackers use them to turn raw output into a tidy display. Each script has its own **Find Regex**, **Replace String**, **Placement**, **Min Depth** and **Max Depth**, and can be moved up, moved down, edited or deleted from the list.

Regex can eat formatting you wanted to keep, so try new scripts on a message you don't mind losing.

## Companion Panel

The Companion panel is titled **Companions** and slides out from the side. It shows companions whose **Show notes** is **Companion panel**. Open it with the floating side button, the **Companions** top bar button or **Companion panel** in the Extensions menu.

You can drag the floating button to any edge. **Hide the floating button** hides it; bring the panel back from the Extensions menu or switch to the top bar button in Connections & defaults. A companion with nothing saved yet shows 'No state yet'.

**Header buttons**:

| Button | What it does |
| --- | --- |
| **Lock panel** / **Unlock panel** | Keeps the panel open when you click elsewhere. |
| **Hide the floating button** | Hides the side button. |
| **Close panel** | Closes it. |

**Run buttons** sit in their own row under the header, with the same names as in Companion activity:

| Button | What it does |
| --- | --- |
| **Run all** | Runs every switched-on companion on the latest reply, including those set to run only when you ask. |
| **Run automatic** | Runs only the companions set to run after replies, with a count of how many. |
| **Run failed again** | Shows only when something failed, with a count. Runs the failed companions again. |

**Buttons on each companion**:

| Button | What it does |
| --- | --- |
| **Reorder companion** (grip) | Drag, or use the arrow keys, to change its Order. |
| **Hide companion** / **Unhide companion** (eye) | Stops or restarts automatic runs. The agent and its notes stay. |
| **Run companion** | Runs it on the latest reply. |
| **Write note again** | Reruns it on the message its current note came from. |
| **Fix note format** | Reruns it with strict format rules, for broken tracker output. |
| **Edit note** | Lets you edit the saved note by hand. |
| **Open full editor** (gear) | Opens its full editor. |
| **Scroll to source message** | Jumps to the message the note belongs to. |

Under each companion's note sit the same **Keep in chat history**, **notes** and **Connections** controls as on its card in the Agents list.

Each companion also shows its message number, estimated **Input** and **Output** tokens and **Previous states** (every earlier note it wrote in this chat, 20 at a time: **Show older notes** loads the next 20). **Absorbed** means its message is hidden but the note still counts.

### Special Controls

**Send state to lorebook** (Lorebook Scout): sends the found entries to a lorebook attached to the chat.

**Plot Objective** (Plot Compass): type an objective and press **Save Plot Objective** to save it and rerun. Save an empty box to clear it.

**Private side chat** (Chat Only): press **Send aside** to talk to the companion without touching the main chat.

**Respond to the chatroom** (Chatroom): press **Send reply** to answer the chatroom. It stays out of the main chat too.

**Hide summarised messages** (Memory Shard): hides the unchanged messages that shard summarised from future prompts. They stay visible in the chat and you can unhide them later.

Some notes contain clickable choices. Clicking one puts its text in your message box.

### Notes Under Replies

Companions set to **Show note card** put their note under the reply. Each card has **Regenerate companion note**, **Edit companion note**, **Copy companion note** and **Delete companion note**, plus **Send companion note to lorebook** for Lorebook Scout.

## Companion Activity

Open it with **More tools → Companion activity**. It lists every companion with its settings as pills, lets you switch each one on or off, and offers **Keep in history**, **Run**, **Edit** and **To prompt or reply** per row. Prompt or reply agents that could become companions sit in their own section with **To companion**.

The toolbar has **Run all**, **Run automatic**, **Run failed again**, **Clean up notes**, **Open Companion panel**, **Create companion** and **Draft with AI**. **Select** lets you batch or keep several companions at once, and **Reorder** changes their order. **Latest results** shows the 20 newest notes; click one to jump to its message.

**Clean up notes** removes **Old notes** (keeps each companion's newest) or **Every note** from the companions you pick.

## Importing, Exporting, Updating and Resetting

**Import agents**: adds agents from a JSON file. Check an imported agent before switching it on, because it can add requests or change replies.

**Export agents** / **Export**: saves all your agents, or just one from its card. Export before big edits, updates or resets.

**Update templates** / the version pill: brings bundled agents up to their newest version. Your switches, pins, Order, connection and model overrides and companion settings are kept. Check the prompt and regex afterwards.

**Reset bundled agents**: puts bundled agents back to their defaults while keeping their connection profiles. Your own agents aren't touched.

**Starter kits** and **Create custom kit** (in Browse library): install a whole set of agents at once, or save your current agents as a kit of your own.

## Storage and Recovery

Agent storage has these limits so loading and saving stay quick. One MiB is 1,048,576 bytes.

| Collection | Maximum records | Maximum size per record | Maximum collection size |
| --- | ---: | ---: | ---: |
| Agents | 512 | 1 MiB | 32 MiB |
| Custom kits | 128 | 8 MiB | 32 MiB |
| Saved setups, including recovery copies | 32 | 8 MiB | 32 MiB |

Oversized or broken imports are refused. If loading finds a damaged record, your files are kept, the panel tells you which records need attention, and automatic agents pause until everything loads.

Loading a setup saves a recovery copy first. If loading is interrupted, automatic agents stay paused until you load a complete setup or that copy. If another tab saved newer changes, your save is refused instead of overwriting them.
