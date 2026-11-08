# Changelog

## v1.5.2

### Highlights
- **Bun 1.4.0 or later** is now required when you run Neconyan with Bun, and prereleases of 1.4.0 such as `1.4.0-canary.1` are refused. Older Bun versions stop before the server starts, explain the known crash in Structured Prefill, and point to Node 24, which is still supported.
- **Structured Prefill** in Formatting turns your assistant prefill or a separate starter template into a reply pattern. **Ready-to-use preset** holds five built-in starting points; your saved **Prefill presets** list starts empty. For a first try, tick **Use a separate starter template**, put `I feel [[opt:calm|curious]]. [[keep]]` in **Starter template**, and turn on **Use Structured Prefill**.
- **Structured Prefill** can enforce the pattern with **Provider schema** where the provider supports it, or use **Instructions (best effort)** elsewhere. The status says whether the reply matched, and **Continue overlap** stops a continuation repeating the join. A mismatch keeps the reply and reports it.
- **Conversation games** adds Chess and Connect Four against the characters in the current DM, plus Minesweeper and Picross when you want to puzzle alone. Each branch keeps its own board, and the characters can see the seats, turn and board.
- **Conversation** branch controls now sit centred under their chat card, and the empty Pals list puts its cat above a centred caption instead of wrapping the caption beside it.
- The Conversation message area now sits in a translucent, inset panel, so the wallpaper shows through while messages keep their own bubbles. Starlight Conservatory uses a flat tint instead of a gradient, which avoids stripes in WebKit.
- **Push notifications** are opt-in per device and account. Pick **Push notifications** under Settings → System & Device → Notifications to show toasts and new Conversation DMs on the lock screen or in the notification shade. Browser notifications need HTTPS or localhost; on iPhone and iPad, add Neconyan to the Home Screen first. The Android and iPhone apps use local notifications and need their local server running.
- Blocking the optional notifications module no longer stops Neconyan from loading. If a content blocker blocks it, the app still starts, the notification control is unchecked and disabled, and its status says why. Logging out while the module is blocked still turns off the local and cached notification record.
- **Scratchpad** can attach up to eight text files, PDFs or images to a message from the composer. PDFs share their selectable text, images need an image-capable model, and prepared content is capped at 2 MiB per message.
- **Scratchpad** can review and save edits to the shared preset, including prompt modules and Text Completion template fields, without overwriting newer preset changes.
- **Catelier** shares writing style, connection and prefill choices, length targets, NSFW guidance, prompt set, custom instructions, portrait guidelines and the Creator name across drafts. Private character text, notes and proposals stay in their draft.
- **Catelier** exports **Download character JSON** as a Character Card V3 and includes an embedded portable lorebook when the draft has one. Private notes and linked book files stay out; use the private draft backup for draft-only material.
- Companions that keep notes in later replies can use **Insert the block at depth** to place one labelled notes block a chosen number of messages from the newest reply. Setting a depth switches kept notes to **One labelled block**; leaving it blank uses the agent's Position and Depth fields.
- A failed settings load now shows a readable **Neconyan could not finish loading** panel with the actual error, **Retry startup** and **Read report**, instead of reloading the page in a loop. The older WebKit cache and module panel still offers **Clear frontend cache and reload** and **Continue anyway**.
- Saved server replies recover more reliably. A completed Mewmory-prepared reply interrupted after the provider result can finish saving, including its after-reply Agents, without another paid request.
- A resumed Roleplay preview now stays below the last saved message after a reload, or keeps its existing position for a replacement reply, instead of appearing above the greeting when it arrives before the saved chat has drawn.
- A server reply that ends with a provider error or content filter keeps the text that arrived and its display Regex formatting, marks the outcome, and skips automatic after-reply Agents rather than throwing the reply away.
- Old server-side job records no longer block new server Roleplay or image work after their jobs have left the ledger. Neconyan stops reserving their full media slot once the job is gone, while the saved history and proofs stay untouched. This fixes the stuck reservation case; a genuinely full media budget can still refuse new work.
- **Jev** reuses an identical completed decision for up to 24 hours in one bounded server cache, with separate Mewmory and Pawthfinder keys. Changing the scene, candidates, model or connection asks again; changing the threshold reuses the stored scores.
- **Starlight Conservatory** now adds a small sparkle burst when you tap, with a softer cursor trail and foreground twinkles. Reduced Motion still keeps the overlay still.
- The **Custom CSS** assistant's guidance now covers the current shell styles, the Conversation layout and the phone layout rules. It is told to preserve your existing shell, palette, wallpaper, fonts and cat visibility unless you ask for a change.
- Pill shell styles keep their panel corners inside the window, so rounded panels no longer clip at the edge.
- The phone tour card no longer pans sideways when you drag it.

### Merged Staging PRs
- PR #511 (2026-11-06) `fix(personas): clarify chat and character lock badges`
- PR #512 (2026-11-06) `ci(e2e): balance release checks across 20 test groups`
- PR #513 (2026-11-06) `fix(e2e): correct field focus and isolate release checks`
- PR #514 (2026-11-06) `feat(scratchpad): edit presets and copy every code block`
- PR #515 (2026-11-06) `fix(kimi): detect partial prefill for bracket-labelled models`
- PR #516 (2026-11-06) `feat(scratchpad): attach files and images from the composer`
- PR #517 (2026-11-07) `feat(prefill): add native structured reply templates`
- PR #518 (2026-11-07) `fix(formatting): pair the sections and drop the blank bands`
- PR #519 (2026-11-07) `feat(formatting): give structured prefill its own section`
- PR #520 (2026-11-07) `fix(presets): stop pill shells clipping the prompt list`
- PR #521 (2026-11-07) `feat(prefill): add presets, guided setup and reply checks`
- PR #522 (2026-11-07) `fix(catelier): share settings across drafts and export ccv3 cards`
- PR #523 (2026-11-07) `feat(conversation): play games with the current chat characters`
- PR #524 (2026-11-07) `fix: recover saved replies and show readable startup failures`
- PR #525 (2026-11-07) `feat(agents): add companion depth insertion for kept notes`
- PR #526 (2026-11-07) `fix(quick-image-gen): surface provider refusals during prompt rewrites`
- PR #527 (2026-11-07) `fix(shell): cap panel rounding in pill styles`
- PR #528 (2026-11-07) `fix(tour): stop the phone card panning sideways`
- PR #529 (2026-11-07) `fix(prefill): send starter requests with captured stopping strings`
- PR #530 (2026-11-07) `perf(retrieval): cache jev decisions for mewmory and pawthfinder`
- PR #531 (2026-11-07) `feat(starlight): add sparkle bursts to mobile taps`
- PR #532 (2026-11-07) `fix(roleplay): report server reply errors and retain display regex`
- PR #533 (2026-11-07) `feat(notifications): add opt-in push alerts across platforms`
- PR #534 (2026-11-07) `fix(starlight): soften cursor effects and lift foreground twinkles`
- PR #535 (2026-11-07) `fix(startup): tolerate blocked optional notifications`
- PR #536 (2026-11-07) `fix(generation): release unusable media reservations`
- PR #537 (2026-11-08) `chore(release): prepare the 1.5.2 help and release notes`
- PR #538 (2026-11-08) `fix(runtime)!: require Bun with safe timed pattern checks`
- PR #539 (2026-11-08) `fix(roleplay): keep resumed previews after saved messages`
- PR #540 (2026-11-08) `test(e2e): settle settings and inspect visible controls`
- PR #541 (2026-11-08) `perf(startup): defer optional prefill controls and game rules`
- PR #542 (2026-11-08) `fix(conversation): centre controls and add a translucent message pane`
- PR #543 (2026-11-08) `fix(custom-css): update the assistant styling guidance`
- PR #544 (2026-11-08) `docs(changelog): record the remaining release highlights`
- PR #545 (2026-11-08) `fix(roleplay): prevent chat flicker after messages appear`
- PR #546 (2026-11-08) `test(e2e): correct conversation and scratchpad checks`
- PR #547 (2026-11-08) `fix(scratchpad): keep the narrow header readable`
- PR #548 (2026-11-08) `docs(assistants): clarify accent button contrast`

## v1.5.1

### Highlights
- **Scratchpad** can now create as well as edit. Ask an assistant for a new persona and review its name, description and title, or share your persona and ask for a new **Scenario Note**. **Save change** creates it. A new persona uses the default portrait and your selected persona stays selected, and a new note is saved to the persona without being switched on. Saving the same suggestion again doesn't make a duplicate.
- **Quick Actions** can pin any page the main search finds, including Catelier, Notebooks, Scratchpad, the chat modes and the Handbook, alongside the settings shortcuts. Simple Mode now keeps Quick Actions in the sidebar and lets you edit it, and the desktop and phone lists stay separate.
- The Android app now clears a data folder lock left behind by an earlier run, so a server closed without warning no longer sends it into a start loop that only clearing the app's data could end. It still refuses when the earlier server may be running or the lock holds anything the app never writes, and the Android failure page now says what to do. The iPhone app clears a leftover lock the same way. Each refusal names the lock fields that differed, and a clearance is logged in **server.log**.
- The iPhone app stops retrying by itself after a page crash, a failed page load or a failed local sign-in. **Try again** and **Share startup log** stay available, including after you return from another app. The startup log survives relaunches, records the last startup step, timings, device details and recent activity, hides credentials it recognises, and can be shared even if the local server never started. The shared report includes the end of the server log.
- **Quick Image Gen** now sends GPT Image 2.6 Sunburst and Flare through the Responses image route, as it already did for the 2.5 names. Choosing either model in the GPT Image provider with a proxy URL generates a picture instead of returning an error from the plain images endpoint.
- Setting up update checks for an extension no longer touches the installed copy until its update history is ready. A failed download or a locked file leaves the extension and its history as they were, and temporary folders stay out of the extension list.
- The round persona picture at the left of the bottom bar now shows a new image as soon as you replace it, rather than keeping the old one until the page reloads.
- **Pawthfinder** keeps the lore it already picked for a reply when you swipe or regenerate it, instead of paying the retrieval model to choose the same lore again. **Reuse the lore when swiping** is on by default under Pawthfinder settings and needs Tool Mode or Predictive Pipeline; turn it off to pick lore fresh for every swipe. A changed message, a different lorebook or a failed retrieval still picks lore again, and the reuse lives in the open page, so the first swipe after a reload asks again.

### Merged Staging PRs
- PR #502 (2026-11-06) `fix: protect extension setup and stop iPhone startup retry loops`
- PR #503 (2026-11-06) `feat(scratchpad): create personas and scenario notes`
- PR #504 (2026-11-06) `fix(android): let the app reclaim its own leftover data lock`
- PR #505 (2026-11-06) `feat(quick-actions): add searchable pages and simple mode access`
- PR #506 (2026-11-06) `fix(ios): let the app reclaim its own leftover data lock`
- PR #507 (2026-11-06) `fix(quick-image-gen): route GPT Image 2.6 through Responses`
- PR #508 (2026-11-06) `chore(release): prepare 1.5.1 for release`
- PR #509 (2026-11-06) `fix(persona-bar): refresh the persona image after an avatar change`
- PR #510 (2026-11-06) `feat(pathfinder): reuse lore retrieval when swiping`

## v1.5.0

### Highlights
- **Catelier** is a new character studio. Start a private draft, answer its questions before generating, then accept one proposed field while the rest is still being written. You can regenerate a field with optional revision notes, accept alternate greetings one at a time, and compare draft changes with your library. Nothing reaches your library until **Save to library**.
- Catelier can start a reply with a saved **Prefill**, use a separate **Partial prefill** for Kimi K3 and K3.1 Pro, and show **Live model output** while it writes. Refusals, cancellations and cut-off replies stay out of the draft, and a server connection keeps writing after you close the page.
- Characters gain **Purrks**: switchable traits, moods, keyword triggers or Scene AI directions. **Extract from card** finds existing traits and Orb fragments without a model request, and **Create switchable Purrks on import** adds them switched off.
- **Thinking Reply Recovery** is a bundled Agent, off until you enable it, that writes the missing reply when a model finishes thinking and returns no text. Your other after-reply Agents and Companions then work on the recovered reply, and you can also run it by hand on an old thinking-only message.
- Agents now have their own **Agent prefills** section. **Extra messages** accepts `[system]`, `[user]` or `[assistant]` role lines, and **Kimi K3 / K3.1 partial prefill** can seed reasoning with `<think>` or supply the start of the answer, following model overrides and fallback connections.
- **Scratchpad** can edit every character card field, and with **Your persona and Scenario Notes** shared it can also propose persona details, Scenario Note text and reviewed persona or note avatars. Each suggestion needs **Save change** before anything is written.
- **Jev** decision models now have saved presets in Mewmory and Pawthfinder, with memory focus and window controls in Mewmory. A saved connection profile can supply the model, so retrieval can use a smaller, cheaper connection than the reply.
- The **Chat Style** and **Shell Style** pickers now show preview cards for every option, so you can see the message layout or miniature window before applying it. Previews follow your palette and accent, and the choice still saves as before.
- Settings now have **Bottom Bar Buttons**, where you can hide, show and reorder the persona bubble, reasoning button, chat switcher, search field, scroll buttons and chat actions. The layout is saved for this browser and **Reset to defaults** brings everything back.
- **Scenario Notes** can each have their own avatar. While a note is active, new Roleplay and Conversation messages use its picture, and earlier messages keep theirs. Exporting a PNG or JSON persona card embeds the full picture; Backup your personas to a file stores only the path to the saved picture, not the image itself. The picture is kept at the size you chose, so it stays sharp when zoomed and on Ripple; notes set before this update keep their smaller copy until you choose the picture again.
- **Starlight Conservatory** and **Sunken Reef** are new shell styles, with an animated night sky and an ocean scene. Both keep your chosen palette and accent, and the creatures stay behind your messages.
- Saving a connection profile or Chat Completion preset with a reverse proxy now asks **Connecting To Proxy** once for that address. Declining stops the profile or preset from being saved or imported, and a confirmed address is not asked about again.
- On native DeepSeek, an explicit **None** now turns thinking off for DeepSeek v4 Pro and DeepSeek Flash, so the reply length controls stop reserving room for reasoning. DeepSeek Flash offers only the effort levels it actually uses, and a request with no effort still counts as thinking.
- When the Android app cannot start its local server, the failure page now shows the reason the server recorded, such as an unfinished identity repair, instead of saying no cause was supplied. The line is written as **Could not start Neconyan:** followed by the reason and **Saved data has been kept.**
- Typing is smoother in the Roleplay and Conversation composers, the message editor, Author's Note, persona details, Agents searches, Prompting Lab and tag searches. Display work now waits for a short pause instead of redrawing on every key.
- **Save memory in the background** is an optional switch under Settings > System & Device > Memory and performance, off by default and saved per device. When you switch away it releases older off-screen messages and reusable caches, then restores the chat and your reading position; drafts, edits and active replies are protected.
- If the page fails to finish starting twice in a row, Neconyan now opens a safe start screen before loading the app. From there you can read the crash report, start in low-memory mode or clear the cached app files, instead of the browser reloading too fast to read anything. iPhones caught in a startup crash loop switch to low-memory mode automatically unless you turned it off.
- The **View agent changes** icon no longer disappears when after-reply Agents finish while the tab is in the background.

### Merged Staging PRs
- PR #402 (2026-11-02) `fix(composer): contain the accent and finish the Cozy Warm border`
- PR #403 (2026-11-02) `feat(appearance): add previews to the chat style picker`
- PR #404 (2026-11-02) `feat(mobile): make swipeable button rows easier to discover`
- PR #405 (2026-11-02) `fix(roleplay): retain reasoning effort on server replies`
- PR #406 (2026-11-02) `fix(archive): restore loading and refresh the native layout`
- PR #407 (2026-11-02) `fix(connections): keep model selection from resetting scroll`
- PR #408 (2026-11-02) `feat(settings): let miso help choose settings`
- PR #409 (2026-11-02) `fix: restore rail taps and immediate composer scrolling`
- PR #410 (2026-11-02) `feat(agents): recover replies from completed thinking`
- PR #411 (2026-11-02) `feat(agents): move dice roller into companions`
- PR #412 (2026-11-03) `feat(creator): add a draft character and lorebook workspace`
- PR #413 (2026-11-02) `fix(agents): keep the page still when toggling agents`
- PR #414 (2026-11-03) `fix(mewmory): avoid copying the search index when hiding messages`
- PR #415 (2026-11-03) `fix(mobile): keep rail scroll lines on their rail when a sibling grows`
- PR #416 (2026-11-03) `chore: set staging version to 1.5.0`
- PR #417 (2026-11-03) `fix(storage): clean up empty ownership directories after failed creation`
- PR #418 (2026-11-03) `fix(shell): align page titles and close controls`
- PR #419 (2026-11-03) `fix(prompting-lab): keep sidebar labels readable`
- PR #420 (2026-11-03) `fix(agents): restore thinking reply recovery`
- PR #421 (2026-11-03) `feat(agents): redesign companion connections controls`
- PR #422 (2026-11-03) `feat(creator): match format picker to field selector pills`
- PR #423 (2026-11-03) `feat(catelier): ask questions before generating`
- PR #424 (2026-11-03) `fix(agents): complete manual thinking reply recovery flow`
- PR #425 (2026-11-03) `feat(catelier): add prefills and live model output`
- PR #426 (2026-11-03) `fix(catelier): reject model refusals before applying replies`
- PR #427 (2026-11-03) `feat(scratchpad): edit all character card fields`
- PR #428 (2026-11-03) `fix(scratchpad): align session action buttons`
- PR #429 (2026-11-03) `feat(catelier): add granular proposal review controls`
- PR #430 (2026-11-03) `feat(agents): improve prefill settings and add Kimi partial prefills`
- PR #431 (2026-11-03) `fix(agents): show companion tracker portraits`
- PR #432 (2026-11-04) `feat(mewmory): add Jev decision presets and memory focus controls`
- PR #433 (2026-11-04) `feat(shell): add animated Starlight Conservatory shell style`
- PR #434 (2026-11-04) `feat(pathfinder): add Jev decision model presets`
- PR #435 (2026-11-04) `fix(time-machine): use account-relative snapshot deletion paths`
- PR #436 (2026-11-04) `ci(github): stop Miso runs cancelling other pull requests`
- PR #437 (2026-11-04) `feat(shell-styles): calm the Starlight Conservatory sky`
- PR #438 (2026-11-04) `fix(agents): preserve agent change history when replies end early`
- PR #439 (2026-11-04) `feat(characters): add switchable character card Purrks and Orb fragment import`
- PR #440 (2026-11-04) `fix(jev): fix direct connections and server retrieval logs`
- PR #441 (2026-11-04) `fix: keep model icons next to the first timestamp only`
- PR #442 (2026-11-04) `feat(appearance): add previews to shell style options`
- PR #443 (2026-11-04) `feat(pathfinder): add option to disable World Info keyword activation`
- PR #445 (2026-11-04) `docs: translate readme`
- PR #446 (2026-11-04) `feat(appearance): add 30 esoteric accent profile seeds`
- PR #447 (2026-11-04) `fix(creator): show the streaming live reply at the top of the section`
- PR #448 (2026-11-04) `fix(catelier): accept plain-text coverage summaries`
- PR #449 (2026-11-04) `test: repair current browser test failures`
- PR #450 (2026-11-04) `fix(purrks): stop the phone bottom bar clipping the badge`
- PR #451 (2026-11-04) `perf: reduce repeated chat rendering and library work`
- PR #452 (2026-11-04) `test(resumable): pin eviction order, 504 resume attempts and Stop while resuming`
- PR #453 (2026-11-04) `refactor(editor): remove duplicate empty placeholder attributes`
- PR #454 (2026-11-04) `fix(i18n): translate the chat rename failure message`
- PR #455 (2026-11-04) `fix(welcome): show one message when a recent chat rename fails`
- PR #456 (2026-11-05) `fix(chat): build each request from one settings snapshot`
- PR #457 (2026-11-05) `fix(reasoning): let an explicit None turn off DeepSeek v4 Pro reasoning`
- PR #458 (2026-11-05) `fix(nanogpt): keep a declared reasoning effort on Claude models`
- PR #459 (2026-11-04) `feat(catelier): keep writing on the server after closing the page`
- PR #460 (2026-11-04) `fix(import): restore windows imports and enable zip app updates`
- PR #461 (2026-11-04) `fix(android): prevent startup and export crashes`
- PR #462 (2026-11-04) `fix(agents): use refusal fallbacks and keep successful parallel edits`
- PR #463 (2026-11-05) `fix(image-review): say when a change was already undone`
- PR #464 (2026-11-05) `fix(image-input): treat a shown group image refusal as handled on send`
- PR #465 (2026-11-05) `fix(notebooks): drop the note share that ends soonest past the limit`
- PR #466 (2026-11-05) `fix(localisation): prefer the most specific caption pattern`
- PR #467 (2026-11-05) `fix(chat): read stopping strings and prefill with the settings snapshot`
- PR #468 (2026-11-05) `fix(reasoning): treat None as thinking off for native DeepSeek Flash`
- PR #469 (2026-11-05) `fix(proxy): confirm a profile or preset proxy when it is saved`
- PR #470 (2026-11-05) `docs: refresh the readme and assistant help for 1.5.0`
- PR #471 (2026-11-05) `test(chat): load the proxy helpers in the stopping-strings snapshot tests`
- PR #472 (2026-11-05) `docs(readme): restore the decorative section banners`
- PR #473 (2026-11-05) `fix(reasoning): treat deepseek-flash with no effort as thinking`
- PR #474 (2026-11-05) `fix(reasoning): list none in the deepseek effort hint`
- PR #475 (2026-11-05) `feat(settings): add and reorder bottom chat bar buttons`
- PR #476 (2026-11-05) `docs(readme): bring the translations in line with the new README`
- PR #477 (2026-11-05) `fix(personas): defer description redraws while typing`
- PR #478 (2026-11-05) `fix(settings): improve style previews and keep cards rectangular`
- PR #479 (2026-11-05) `fix(personas): align the scenario note editor header`
- PR #480 (2026-11-05) `fix(proxy): save presets with the proxy address you approved`
- PR #481 (2026-11-05) `fix(authors-note): defer panel redraws while typing`
- PR #482 (2026-11-05) `feat(scratchpad): edit personas, avatars and scenario notes`
- PR #483 (2026-11-05) `feat(personas): give scenario notes their own avatars`
- PR #484 (2026-11-05) `fix(dialogue-colors): hide unequipped personas`
- PR #485 (2026-11-05) `fix(proxy): wait for approval before updating a profile's proxy`
- PR #486 (2026-11-05) `fix(personas): preserve scenario note avatar detail`
- PR #487 (2026-11-05) `perf(frontend): avoid repeated redraws across workspaces`
- PR #488 (2026-11-05) `feat(shell-styles): add the Sunken Reef ocean shell style`
- PR #489 (2026-11-05) `feat(scratchpad): copy individual markdown blocks`
- PR #490 (2026-11-05) `fix(roleplay): recover thinking-only replies after a chat save`
- PR #491 (2026-11-05) `fix(shell-styles): keep Sunken Reef creatures behind messages`
- PR #492 (2026-11-05) `feat(memory): add optional background memory saving`
- PR #493 (2026-11-05) `fix(android): name the cause when the local server cannot start`
- PR #494 (2026-11-05) `perf(typing): stop per-keystroke redraws in editors and composer`
- PR #495 (2026-11-05) `fix(chats): rework Hush spacing and correct style descriptions`
- PR #496 (2026-11-05) `perf(startup): avoid repeated scans and serial template loads`
- PR #497 (2026-11-05) `fix(personas): keep scenario note portraits at full size`
- PR #498 (2026-11-05) `fix(startup): offer a safe start after repeated browser crashes`
- PR #499 (2026-11-05) `fix(agents): keep the changes badge after returning to the tab`
- PR #500 (2026-11-06) `chore(release): prepare 1.5.0 for release`

## v1.4.1

### Highlights
- **Author's Note** now has four tabs: **This chat**, **Character**, **Persona** and **New chats**, with a summary of what reaches the prompt. You can combine several character notes and keep a different selection for each persona. Persona notes are also reachable from Persona Management and the composer Persona picker.
- The chat name above the message box opens a searchable list of the current character's or group's saved chats, with previews and message counts. **Name chats automatically** replaces dated chat names after six messages by default, once the app is idle. Each title usually uses one request to the current model, with a second attempt if the structured response fails; names you chose yourself stay as they are. Change the threshold or switch it off under **Chat & Writing > Chat & messages > Chat window**.
- **Edit sidebar** appears beside each section heading on desktop and in the phone drawer. Move buttons between sections, hide them with **X**, or use **Restore defaults**. Hiding a button doesn't delete its page or data.
- **Tag Management** has **Tags & Folders** and **Characters & Groups** tabs, searchable tags and cards, folder grouping, tag merging and bulk assignment. **Prune**, **Backup**, **Restore** and **Undo** help with tidying the library without editing every card separately.
- **UI Theme** has searchable palette previews and **All**, **Dark** and **Light** filters, with 115 Regex Agent tracker themes available as full interface themes. Relationship and Ethereality tracker cards have their faithful layouts back, and accent buttons and narrow search controls remain readable across more shell styles.
- **Reasoning Effort** in Connections and the composer uses the levels a model supports across NanoGPT, OpenRouter and supported native providers. Models without an effort setting disable the setting in Connections and hide the composer button, while keeping your saved choice for other models; models that require reasoning don't offer **None**.
- **Agents** shows an **Agent updates ready** banner with **Update all** and **Dismiss**. Updating includes edited built-in agents after a warning, so check that warning before replacing your changes. **Chatroom** Companions gain polls, room events and direct viewer replies. A poll option fills the reply box; **Send reply** makes one Companion request without adding a message to the main chat.
- Interrupted replies keep their partial prose or thinking, including when the response limit is reached before any prose appears. Neconyan explains early endings, stalled streams and connection loss, and never cancels a running held reply to make room for another. Refused or failed swipes no longer leave swiping locked, and Doom tracker callbacks work again.
- **Mewmory** waits for running Agents before hiding older messages, preserves reading progress and avoids redundant work. Companion notes wait for scrolling to stop before clearing older notes, and fallback errors appear instead of blank replies.
- Damaged Notebook files no longer discard Scratchpad replies or block **Blank note**. Desktop sessions load over plain HTTP again, NovelAI V5 and Gemini image settings are corrected, and account, file and outbound request boundaries have tighter checks. In-app help links now point to the Neconyan handbook.

### Merged Staging PRs
- PR #345 (2026-10-30) `fix(gemini): omit the image settings when none are set`
- PR #346 (2026-10-30) `fix(agents): report fallback errors instead of a blank companion reply`
- PR #347 (2026-10-30) `fix(gemini): send empty image settings when none are saved`
- PR #348 (2026-10-30) `fix(scratchpad): keep the reply when a notebook file is damaged`
- PR #349 (2026-10-30) `fix(gemini): leave out empty image settings for older image models`
- PR #350 (2026-10-30) `fix(scratchpad): stop always adding the note title to note discussions`
- PR #351 (2026-10-30) `fix(notebooks): offer Blank note when saved templates can't be read`
- PR #352 (2026-10-30) `fix(notebooks): tidy share-again messages and the Back to note label`
- PR #353 (2026-10-30) `fix(mewmory): wait for running agents before hiding older messages`
- PR #354 (2026-10-30) `fix(mewmory): stop auto-hide skipping replies and hiding unread messages`
- PR #355 (2026-10-30) `test(mewmory): wait for the accent fade before measuring contrast`
- PR #356 (2026-10-30) `fix(images): explain integrity failures on the image checks`
- PR #357 (2026-10-30) `fix(notebooks): say an ended share is no longer shared`
- PR #358 (2026-10-30) `fix(quick-image-gen): send NovelAI V4 prompt structures for V5 models`
- PR #359 (2026-10-30) `fix(lorebooks): give the Lorebook settings bar a solid background`
- PR #360 (2026-10-30) `fix(agents): wait for scrolling to stop before clearing older notes`
- PR #361 (2026-10-30) `fix(chat): never leave swiping locked after a refused or failed swipe`
- PR #362 (2026-10-30) `fix(appearance): persist shell style with account settings`
- PR #363 (2026-10-30) `fix(tide): keep collapsible panels readable`
- PR #364 (2026-10-30) `fix(mewmory): preserve reading progress and avoid redundant work`
- PR #365 (2026-10-30) `fix(chat): say why a rename is refused when Scratchpad is damaged`
- PR #366 (2026-10-31) `fix(rail): give the phone rail icon buttons a 44px tap area`
- PR #367 (2026-10-31) `fix(generation): say when a streamed reply ends early and keep the rest`
- PR #368 (2026-10-31) `fix(generation): never cancel a running reply to make room for a new one`
- PR #369 (2026-10-31) `fix(generation): catch stalled streams and bound resume waits`
- PR #370 (2026-10-31) `fix: support Doom tracker and explain replies cut off while reasoning`
- PR #372 (2026-10-31) `fix(startup): load desktop sessions over plain http`
- PR #373 (2026-10-31) `fix(roleplay): preserve partial prose and thinking-only replies`
- PR #374 (2026-10-31) `feat(authors-note): redesign panel and surface persona notes`
- PR #375 (2026-10-31) `perf(qig): speed up png validation`
- PR #376 (2026-10-31) `fix(regex-themes): preserve accent button contrast across shells`
- PR #377 (2026-10-31) `perf: reduce repeated work in chat search and reply cleanup`
- PR #378 (2026-10-31) `fix(extensions): align tool settings navigation`
- PR #379 (2026-10-31) `feat(agents): add chatroom polls, events and direct viewer replies`
- PR #380 (2026-10-31) `feat(agents): show an update banner that updates every agent`
- PR #381 (2026-10-31) `feat(regex-agent-themes): restore faithful relationship and ethereality layouts`
- PR #382 (2026-11-01) `feat(themes): ship Regex Agent tracker themes as UI themes`
- PR #383 (2026-11-01) `feat(settings): add automatic theme palette previews`
- PR #384 (2026-11-01) `fix(composer): follow the accent on the XP send button`
- PR #385 (2026-11-01) `fix(generation): report connection loss before a reply appears`
- PR #386 (2026-11-01) `feat(sidebar): edit sections in place and remove buttons`
- PR #387 (2026-11-01) `fix(characters): preserve name ownership when the input moves`
- PR #388 (2026-11-01) `fix(nanogpt): honour declared reasoning effort support`
- PR #389 (2026-11-01) `feat(characters): add native tag and folder manager`
- PR #390 (2026-11-01) `fix(sidebar): show edit controls in the phone drawer`
- PR #391 (2026-11-01) `feat(reasoning): share supported effort choices across providers`
- PR #392 (2026-11-01) `feat(authors-note): mix several character notes per persona`
- PR #393 (2026-11-01) `fix(security): harden account, file and outbound request boundaries`
- PR #394 (2026-11-01) `docs(help): point in-app help links at the Neconyan handbook`
- PR #395 (2026-11-01) `feat(chat): add a searchable composer chat browser`
- PR #396 (2026-11-01) `feat(chat): name chats automatically with the current model`
- PR #397 (2026-11-01) `fix(shell): align character and lorebook page headers`
- PR #398 (2026-11-01) `docs(readme): refresh screenshots and add version and language links`
- PR #399 (2026-11-01) `fix(meower): uncramp actions and add accent-aware message borders`
- PR #400 (2026-11-01) `fix(regex-themes): keep search navigation readable in narrow panels`

## v1.4.0

### Highlights
- Group scenes now have a **Scene Director** that picks up to three speakers or hands the scene back to you. **Let them talk** continues for one to eight replies, **Ensemble** writes a whole scene in one request and splits it into character messages, and you can mark who is present, keep whispers to their recipient, give any member a Narrator or game master role, and regenerate as another member. Characters also keep to their own lines by default. The Director makes its own model request before a reply when it is on, so a small, fast profile helps.
- **Where replies are written** under Settings > Chat & messages > Replies lets you keep supported solo, group and guided replies in the browser (the default) or on the server; a server reply, including its after-reply Agents, finishes after you close the page or your phone sleeps. Replies that use Notebook context still go to the server even when you pick the browser. If that route cannot include your page prompts, Neconyan explains why instead of generating a reply missing instructions.
- The standalone **iPhone app** is now in the project: it bundles Node.js, the server and the interface, keeps chats and settings on the phone, and needs no other computer. Backup ZIPs picked in the app are copied into its storage and imported by the server, and page-written replies keep going with silent audio when you leave. The project includes an unsigned device build and an iOS release workflow that produces the IPA for sideloading; it is not an App Store build.
- **Mewmory** can keep recent chat by message count instead of tokens, starting at 10 messages and leaving older ones out of the prompt in batches of 5 once they are recorded; the saved chat keeps them. Every tab opens with a status card, the next reply's memories sit at the top of Now, and Archive leads with search. Fallback connections and one shared profile now cover every text role, trackers are restated in Mewmory's own words, and new memories keep two to four sentences of detail.
- **Agents** gains **Vitals**, a game-style Companion for Health, Satiety, Hydration, Energy and Morale that arrives installed but switched off. **Help me choose** asks Taro four questions and recommends agents without an AI request, Companion notes can open in draggable, collapsible windows, and the list now sorts by plain-language type instead of two competing filters.
- **Prompt Adherence Checker** is a new after-reply agent, off until enabled, that rewrites lines against the prompts switched on in the active preset and makes its own model request when it runs. **Parallel Off-Screen (Extended)** is a new tracker, also off, that instead adds longer prompt text for three short off-screen scenes to the normal reply, so it makes no separate request. **Vitals** also makes its own model request when it runs, and other tracker repairs may call a model too. Refusals now skip after-reply Agents and Companions, and tracker runs try saved fallback connections when a reply is unusable.
- **Dice Roller** is on by default, with its dice button first beside the message box. Roll d4 to d100 with up to four dice, a bonus, difficulty and advantage or disadvantage; the result adds a short roll line and a system note so the model writes the outcome as settled fact without mentioning dice or numbers. Switch it off under Extensions > Manage extensions.
- **Time Machine** is now a list and detail view with snapshot cards, kind filters, a history timeline and field-by-field comparisons; phones swap between the list and one snapshot instead of squeezing both. **Quick Image Gen** puts status, prompt, Style, Configuration and Generate in one Create card, with Gallery, History, Logs and Quick setup underneath and settings behind tabs.
- **Google Font** now has separate pickers for body text, headings, chat messages and code, each with presets and a custom Google Font option, plus **Reset all fonts**. The sidebar has a **Reorder** button beside Workspace, and buttons can move between sections, such as Persona into Workspace.
- **Stay open in the background** is an opt-in Android browser switch, off by default, that plays a sound too quiet to hear while Neconyan is hidden so Chrome is less likely to unload the tab. It costs battery, shows a media notification and can pause music in other apps, and it is hidden in the Android app.
- **Server replies** no longer keep their reserved 72 KiB after you stop them or once they drop out of job history, so the no-room error from those abandoned reservations no longer blocks new replies. Failure cards now say what happened instead of showing 'Reply stopped' and the server's internal wording, and replies survive stops and navigation.
- Account backups and imports no longer stop at the old fixed 8 GiB limits or 32 GiB retained-file quotas, Android's **Update APK** control works again, and Visual Novel Mode now works in Ripple and keeps the composer on screen on phones.
- Phones do less work: touch handlers no longer cancel taps after a ghost touch, closed panels and lab pages no longer leave the page inert, and Agents, Regex Agent Themes, chat watchers and hidden polls stop rebuilding work in the background. Disabled speech providers wait until you open their settings or use speech controls instead of loading during startup. A chat load that stalls for eight seconds now offers Home instead of leaving its loading dialogue over the page.
- **Kimi K3.1 Pro** is recognised for partial prefill, reasoning and reply cleanup, including `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed`, and both IDs are in the native Moonshot model list.

### Merged Staging PRs
- PR #265 (2026-10-21) `fix(agents): stop swipes rerunning agents from an earlier reply`
- PR #266 (2026-10-21) `fix(agents): stop rerun agents staying blocked after a finished reply`
- PR #267 (2026-10-21) `feat(expressions): let the agent name the character on shared cards`
- PR #268 (2026-10-21) `fix(chat-styles): fill the Ripple avatar frame with the expression`
- PR #269 (2026-10-21) `fix(scratchpad): make composer actions icon-only`
- PR #270 (2026-10-21) `fix(generation): keep partial text and stop agents on provider filter`
- PR #271 (2026-10-22) `feat(groups): add directed scenes, whispers and ensemble replies`
- PR #272 (2026-10-21) `fix(generation): save agent-edited continuations and stop blocked ret…`
- PR #273 (2026-10-22) `feat(agents): add Prompt Adherence Checker for enabled preset prompts`
- PR #274 (2026-10-22) `fix(groups): tidy the group editor, greetings, speaker bar and director`
- PR #275 (2026-10-22) `feat(mobile): help Neconyan stay open in the background on Android`
- PR #276 (2026-10-22) `fix(botsearcher): keep {{user}} in private JannyAI imports`
- PR #278 (2026-10-22) `fix(scratchpad): share story messages whole or not at all`
- PR #280 (2026-10-22) `fix(mewmory): omit the Gemini 3 thinking level when no effort is set`
- PR #281 (2026-10-23) `fix(roleplay): reconnect unchanged files after moving data`
- PR #282 (2026-10-23) `fix(distiller): recover from failed and cleared jobs`
- PR #283 (2026-10-23) `feat(sidebar): add a reorder button and allow moves between sections`
- PR #285 (2026-10-23) `fix(authors-note): stop typing in the note scanning the whole page`
- PR #286 (2026-10-23) `fix(termux): retry transfer checks after temporary timestamp changes`
- PR #287 (2026-10-24) `fix(storage): prevent false authoring save conflicts on exfat drives`
- PR #288 (2026-10-24) `feat(kimi): add K3.1 Pro partial prefill support`
- PR #289 (2026-10-24) `fix(generation): stop agents when a provider ends a reply with an error`
- PR #290 (2026-10-24) `feat(mewmory): add fallback and shared profiles, restate trackers`
- PR #291 (2026-10-24) `feat: add Parallel Off-Screen (Extended) tracker`
- PR #292 (2026-10-25) `feat(chat): choose where replies are generated`
- PR #293 (2026-10-25) `perf: reduce repeated chat, settings and navigation work`
- PR #294 (2026-10-25) `feat(quick-image-gen): rework the panel around a create card and settings tabs`
- PR #295 (2026-10-26) `fix(ios): tidy the top bar and composer in the home-screen app`
- PR #296 (2026-10-26) `fix(ios): keep status-bar sampling active without a safe-area inset`
- PR #297 (2026-10-26) `fix(ios): keep composer corners clear of the screen edge`
- PR #298 (2026-10-26) `fix(backup): allow account downloads beyond fixed binary quotas`
- PR #299 (2026-10-26) `fix(settings): tighten category tab spacing`
- PR #300 (2026-10-26) `fix(android): restore apk update controls`
- PR #301 (2026-10-26) `fix(import): remove fixed archive and retained-file size quotas`
- PR #302 (2026-10-26) `fix(server): apply auto-stash choices and show changed files`
- PR #303 (2026-10-26) `fix(updater): ignore generated account backup downloads`
- PR #304 (2026-10-26) `fix(agents): keep companion actions in one row on ios`
- PR #305 (2026-10-26) `feat(time-machine): rework the popup into a list and detail layout`
- PR #306 (2026-10-27) `fix(agents): finish manual Agent actions on the server`
- PR #307 (2026-10-27) `feat(compact-mode): make Compact Mode compact everywhere`
- PR #308 (2026-10-27) `fix(visual-novel): make Visual Novel Mode work in Ripple and on phones`
- PR #309 (2026-10-27) `feat(appearance): choose Google Fonts for headings, chat and code`
- PR #310 (2026-10-27) `fix(agents): keep Send usable while Agents finish a reply`
- PR #311 (2026-10-27) `feat(ios): add a standalone sideloadable iPhone app`
- PR #312 (2026-10-27) `fix(sync): repair legacy data for github folder sync`
- PR #313 (2026-10-27) `ci(ios): build the iphone app for main releases`
- PR #314 (2026-10-27) `fix(agents): stop redrawn companion cards from resaving the chat`
- PR #315 (2026-10-27) `fix(agents): preserve accepted input when retrying companions`
- PR #316 (2026-10-27) `fix(roleplay): keep replies the server stopped or could not save`
- PR #317 (2026-10-27) `fix(roleplay): use the Agents stop while server Companions run`
- PR #318 (2026-10-27) `perf(phone): fix tap-swallowing freezes and trim main-thread work`
- PR #319 (2026-10-28) `fix(send): show the user's message before the Roleplay routing check`
- PR #320 (2026-10-28) `perf(frontend): reuse templates, translations and model rows`
- PR #321 (2026-10-28) `perf(backend): reuse unchanged catalogue and image settings reads`
- PR #322 (2026-10-28) `feat(mewmory): add recent-message windows and clearer controls`
- PR #323 (2026-10-28) `feat(mewmory): make status, next reply and search easy to find`
- PR #324 (2026-10-28) `test(mewmory): match the new prompt labels`
- PR #325 (2026-10-28) `fix: repair prompt rendering and staging test failures`
- PR #326 (2026-10-28) `fix(agents): run Companions in the page when the server has no room`
- PR #327 (2026-10-28) `fix(roleplay): stop colour rewrites cancelling server replies`
- PR #328 (2026-10-28) `fix(roleplay): free space held by unsaved replies and explain failures`
- PR #329 (2026-10-28) `fix(roleplay): free room held by stopped replies on every write`
- PR #330 (2026-10-28) `fix(roleplay): preserve regex rules on recovered server replies`
- PR #331 (2026-10-28) `fix(roleplay): retain server replies across stops and navigation`
- PR #332 (2026-10-29) `fix(botsearcher): allow imports after a reply finishes`
- PR #333 (2026-10-29) `fix(agents): skip after-reply agents when the reply is a refusal`
- PR #334 (2026-10-29) `feat: add Vitals companion and Dice Roller extension`
- PR #335 (2026-10-29) `fix(personas): keep scenario note toggles from jumping the viewport`
- PR #336 (2026-10-29) `fix(connections): remove outdated reply formats`
- PR #337 (2026-10-29) `feat(agents): add draggable collapsible companion windows`
- PR #338 (2026-10-29) `fix(agents): keep the companion run button accented in every shell style`
- PR #339 (2026-10-29) `feat(agents): add taro's agent recommendations`
- PR #340 (2026-10-29) `fix(agents): keep Send working while Agents finish a streamed reply`
- PR #341 (2026-10-29) `feat(agents): sort agents by plain-language type`
- PR #342 (2026-10-29) `fix(agents): try fallbacks for unusable tracker replies`
- PR #343 (2026-10-29) `fix(custom-css): refresh accent and font prompt guidance`
- PR #344 (2026-10-29) `chore(release): prepare 1.4.0 readiness`

## v1.3.7

### Highlights
- Added opt-in **Simple Mode**, offered by Nori before a new account's first tour. It keeps chat, characters, connections, Presets, Lorebooks, Agents, Notebooks and Scratchpad visible. It hides Mewmory, Chat Archive, Extensions, the other Fine-tuning pages, the Characters & Lore, Appearance, Quick Actions and Troubleshooting sidebar groups, and extra composer controls. Nothing is deleted or disabled. **Show all features** brings the full layout back, and existing accounts keep their current layout.
- Added **Position Tracker** and **Visual Map** Companions. Position Tracker groups people by place, with their exact spot, activity and distance from you; Visual Map draws nearby places around your location, with character pins, a travel trail and a compass. Both carry the previous note forward and appear switched off on new and existing accounts. Each run makes a separate model request, so enable only the ones you want to pay for.
- **Expressions Agent** now classifies new persona messages using the persona's own expression set and saves the chosen portrait with the message. Each classification makes an extra request through the Agent's connection, in the background instead of delaying the character's reply. The bundled template is now version 2; existing copies can use the update badge on their Agent card or **Update All**. Updating the template is optional.
- **Tide** messages have readable cards on desktop and tablets, with tighter headers, stable spacing and reply controls that fit the layout. Downloaded message images keep the full card instead of cutting off its last lines. The collapsed desktop sidebar and its headings line up properly too.
- The Android browser composer stays inside the visible screen after switching apps, including with **Movable panels** enabled. On iPhone Safari, turning **Movable panels** off no longer leaves an empty band above the keyboard, and the Home Screen app no longer doubles the home-bar gap.
- A **Thinking...** label appears while a streamed reply has no text or visible reasoning yet, including on older Safari versions without the newer visibility check. Tool calls keep their own thinking when a provider sends reasoning between calls, instead of mixing it across the chain. **Interleaved Thinking** now works with Custom OpenAI-compatible connections as well as OpenRouter; it's off by default, and your provider must accept reasoning in tool-call messages.
- Server-run replies do less preparation: the repeated chat save is skipped when nothing changed, preview details load alongside the save, and dialogue colours are resolved earlier. Conversation reactions no longer compare the entire chat after every completed reply. Character libraries read card text without decoding the whole image, and unchanged operation records are reused when listing jobs.
- Mewmory waits 30 seconds before its first background scan, reuses unchanged chat and Story archives correctly, and gives page requests time to run during long catch-ups. Scene matching also avoids repeatedly splitting the same text.
- Image refusals now show the review notice on browser sends, open the correct review without a stale save, and avoid a second error toast from Deep Swipe or Guided Correction. Prompt Manager no longer reports a hidden error when an image is refused. The image controls and refusal notices have updated German, Italian and Portuguese translations.
- Scratchpad character drafts recover notes and alternate greetings when a model puts them inside the character object or uses the saved-card spelling. You still review the card before creation; conflicting or invalid values are rejected.
- **Time Machine** no longer mistakes its own snapshot update for a settings change on another device. Settings saves and replies can continue during capture, and the returned snapshot list keeps your newer local choices. Real changes from another device still stop a conflicting save.
- Fixed character saves on exFAT drives, file-picker cancellation closing its parent popup, and Notes list editing with unfinished frontmatter. Connection profile **Edit selected** and **Delete selected** now scroll with the desktop page.

### Merged Staging PRs
- PR #234 (2026-10-19) `fix(chat): give tide messages a readable card on desktop and tablet`
- PR #235 (2026-10-19) `fix(composer): keep the phone composer visible after app switching`
- PR #236 (2026-10-19) `perf(roleplay): show server-run replies sooner`
- PR #237 (2026-10-19) `fix(character): keep exFAT saves working after temp-file rename`
- PR #238 (2026-10-20) `perf(mewmory): keep startup responsive while memories catch up`
- PR #239 (2026-10-20) `fix(composer): keep the full-height iOS shell when MovingUI is on`
- PR #240 (2026-10-20) `perf(characters): speed up the first page load on small servers`
- PR #241 (2026-10-20) `fix(composer): end the iOS shell at the bottom of the visible area`
- PR #242 (2026-10-20) `fix(chat): show thinking while waiting for streamed output`
- PR #243 (2026-10-20) `feat(shell): add opt-in Simple Mode offered by Nori to new users`
- PR #244 (2026-10-20) `docs(readme): refresh screenshots and add Simple Mode`
- PR #245 (2026-10-20) `fix(expressions): classify persona messages with their own sets`
- PR #246 (2026-10-20) `fix(connection-profiles): let edit and delete selected scroll on desktop`
- PR #247 (2026-10-20) `fix(popup): keep file picker cancel from closing parent popup`
- PR #248 (2026-10-20) `fix(deep-swipe): suppress second toast on image refusal`
- PR #249 (2026-10-20) `fix(prompt-media): open refusal review without a stale chat save`
- PR #250 (2026-10-20) `fix(notes): keep list editing with unclosed frontmatter`
- PR #251 (2026-10-20) `fix(quick-image-gen): translate image refusal toast prefixes`
- PR #252 (2026-10-20) `feat(agents): add Position Tracker companion`
- PR #253 (2026-10-20) `feat(agents): add Visual Map companion`
- PR #254 (2026-10-20) `fix(chat): keep each tool call's own thinking in interleaved reasoning`
- PR #255 (2026-10-20) `fix(i18n): translate the image features into Portuguese`
- PR #256 (2026-10-20) `fix(i18n): translate the image features into Italian`
- PR #257 (2026-10-20) `fix(i18n): translate the image features into German`
- PR #258 (2026-10-20) `fix(scratchpad): recover misplaced character notes and greetings`
- PR #259 (2026-10-20) `fix(chat): show the image refusal notice on browser sends`
- PR #260 (2026-10-20) `fix(prompt-manager): stop a hidden error when images are refused`
- PR #263 (2026-10-20) `fix(sidebar): align the collapsed desktop rail and its headings`

## v1.3.6

### Highlights
- Ordinary Roleplay, Story, group, regenerate, continue and swipe replies now run in the browser again, including Guided Response and Guided Swipe. The first words and reasoning show as soon as they arrive, instead of waiting for the provider's next chunk. Conversation mode, protected corrections, Deep Swipe, background calls and replies that need Notebook context still run on the server.
- If you leave the tab while a browser reply is running, even before the first words arrive, the server keeps reading the response and the chat collects the finished reply when you come back. The server keeps its copy until the chat confirms the save, so a failed save doesn't mean paying for the reply again. **Stop** still cancels everything.
- A tab left open across a server update now notices when you come back to it. If nothing is happening it saves your settings and reloads itself; if you're generating, editing or typing, an **Update ready** toast waits for you to tap it.
- Added **Rerun agents** to a reply's **More** menu. It repeats the after-reply Agent pass without generating another reply, follows your **Run together** or **Run one at a time** choice, keeps your own edits and replaces the old generated blocks instead of stacking new ones. **Undo** restores the reply from before the rerun.
- Fixed server replies that streamed in correctly, then saved as raw tracker placeholders with no Agents run. The dialogue colours extension saving its counts mid-reply made the reply think your account data had changed.
- Scratchpad can search the web before answering. Turn on **Web** beside the message box (off by default, saved per session) and pick **Brave Search**, **SearXNG**, **NanoGPT (Linkup)**, **Exa**, **Tavily** or your own **Custom address** under **Context → Web search**. Only the message you're sending goes to the search service, trimmed to 400 characters, and the reply cites its numbered sources. Lorebook entries now fold under each lorebook, and Context and Sessions no longer slide sideways on phones. An opened **Swipes** list under a message in **Context** now stays open when Context refreshes in the background, instead of snapping shut while you pick versions.
- **Macro Enhanced** is now a full page with **Playground**, **Reference**, **My macros**, **This chat** and **Setup** tabs. Playground expands text without a model request, and My macros builds reusable macros with named arguments for everywhere, this browser, a character or one chat. Miso, Taro and Nori can write a macro for you, which you review and preview before it's saved in this browser, and there's an editable template pack of eleven greetings, scene starters, checks and writing nudges.
- The Regexes page has the Neconyan look, and you can describe a rule in plain words and let a connection profile draft it. The editor opens with the rule filled in and **Test Mode** running on an example, so you can check it before saving, and **Improve rule** fixes one you already have. Nothing is overwritten if the model's answer isn't a usable rule.
- Mewmory settings save automatically, including number fields, model roles and credentials, and a failed save keeps your edits for a retry. **Hide old messages automatically** now hides older history each time visible history reaches the configured trigger.
- Calico Light finally looks like Calico Light again, with a light workspace rail and a darker accent and border for contrast. Since 16 September the stock theme had been treated as a custom one. AI Custom CSS now writes light and dark rules that apply on every theme, not only stock Calico.
- Pawthfinder's settings page has the Neconyan look, with the on/off switch above its status line and compact Read / Write / Delete permission rows on phones.
- Completed replies no longer vanish with aggressive message unloading on, and your reading place holds while controls appear.
- Automatic Conversation summaries wait quietly while saved images or quotes need review, instead of logging the same error every 30 seconds.
- **Review chat images** fits on phones: long and translated button labels wrap instead of running off the edge, choosing a replacement file has a proper **Import** button, and closing the file picker no longer closes the whole review.
- Editing or hiding a message with automatic translation off no longer saves and reloads the chat a second time. Mewmory's automatic hiding had been setting it off after replies.
- Quick Image Gen's separate Text AI now defaults to 32,000 tokens and accepts up to 64,000, so long image prompts aren't cut off. Installs still on the old 500 default move to the new one; values you chose yourself are kept.
- Less repeated work on desktop and phones: resizing the window no longer reloads the chat list, large character libraries rebuild much faster, and scrolling, closed menus, extension work and Android startup do less in the background.

### Merged Staging PRs
- PR #210 (2026-10-17) `fix(mewmory): autosave settings and honour the hiding threshold`
- PR #211 (2026-10-18) `test(i18n): keep image tests valid once translations land`
- PR #212 (2026-10-18) `feat(macros): rebuild the native macro workbench`
- PR #213 (2026-10-18) `perf(mobile): reduce Android and iOS rendering and startup work`
- PR #214 (2026-10-18) `perf(desktop): reduce rendering and library loading work`
- PR #215 (2026-10-18) `feat(macroenhanced): add assistant packs and browser authoring`
- PR #216 (2026-10-18) `fix(quick-image-gen): raise Text AI max tokens default`
- PR #217 (2026-10-18) `feat(scratchpad): add web search with saved sources`
- PR #218 (2026-10-18) `ci(github): post Miso merge verdicts from staging`
- PR #219 (2026-10-18) `ci(github): trigger Miso from staging pushes`
- PR #220 (2026-10-18) `ci(github): run Miso on pull request events`
- PR #221 (2026-10-18) `feat(agents): rerun after-reply agents from the message menu`
- PR #222 (2026-10-18) `fix(chat): keep completed replies visible with aggressive unloading`
- PR #223 (2026-10-18) `fix(conversation): defer automatic summaries awaiting image review`
- PR #224 (2026-10-18) `fix(generation): recover browser replies after leaving the tab`
- PR #225 (2026-10-18) `fix(chat): prefer browser replies and show first streamed content`
- PR #226 (2026-10-19) `fix: keep server replies' agents running and reload stale pages after updates`
- PR #227 (2026-10-19) `feat(pawthfinder): give the settings page a Neconyan look`
- PR #228 (2026-10-19) `feat(regex): draft rules with a connection profile on a neconyan-style page`
- PR #229 (2026-10-19) `fix(theme): revive Calico Light and fix custom CSS tone selectors`
- PR #230 (2026-10-19) `fix(scratchpad): tidy the Context tab and add more web search options`
- PR #231 (2026-10-19) `fix(chat): keep the echo user header as narrow as the character's`
- PR #232 (2026-10-19) `fix(ui): keep image review buttons readable on phones`

## v1.3.5

### Highlights
- Every single-choice model menu is now a searchable list on phones and desktop. Type part of a name or model ID, press Enter for the first match, or scroll the full catalogue; lists are no longer cut off at 50 models. Favourites sit in their own group with a star at the right edge, and the rest are grouped by family worked out from the model ID, so a new release lands in the right group without an update. OpenRouter, ElectronHub and AIMLAPI keep their own vendor groups, and NanoGPT names start with the source that hosts the model.
- Added search to the Companion panel. It filters by companion name and latest note, says how many companions match, and leaves unfinished drafts and expanded notes alone. Escape clears the search first, then closes the panel.
- A failed Agent, Companion, translation or automatic speech step no longer throws away a finished Roleplay reply. Completed Agent changes are kept when they can be applied; if an Agent changed after a restart before the final save, the reply is saved as the model wrote it, without those edits. The main request is never repeated to repair a helper failure. You do not need to regenerate.
- Replies kept by 1.3.4.1's **Recovered reply** card are saved automatically on the first normal start after updating, using the reply that was already paid for. If the chat changed or the saved result can't be verified, the old copy stays in job history instead of overwriting your edit. There's no new recovery card or restore button, and the main model isn't asked again.
- Post-reply Agents start as soon as the main reply finishes, with pending Companion cards naming what is about to run. A finished note grows its message without moving your place in the chat, and opening a chat still lands on its newest reply.
- Server-written replies now follow **Screen updates per second** instead of redrawing twice a second, so long replies scroll more smoothly. Lower that setting if a phone struggles.
- The completed reply's token and reasoning counts update before Companions finish, instead of keeping an earlier streaming count while they run.
- Reworded the image input and repair screens. **Don't send chat images to the model** covers every picture in your chats, **Review chat images** opens the right chat after a refusal, and **Change history** uses **Prepare a converted copy**, **Save a copy as it is**, **Finish this change** and **Undo change**. The screens can be translated now.
- Rejected non-image input and truncated PNG/TIFF headers before caption decoding, fixing cases that could hang or stop the server.
- Only the selected speech provider loads at startup, reducing background requests while keeping speech available in Roleplay and Conversation.

### Merged Staging PRs
- PR #200 (2026-10-17) `fix(model-search): show favourites as a star and keep the keyboard down`
- PR #201 (2026-10-17) `feat(models): searchable, auto-grouped model lists for every backend`
- PR #202 (2026-10-17) `fix(roleplay): retry failed Agents and keep the finished reply`
- PR #203 (2026-10-17) `fix(i18n): stop collecting header names as captions`
- PR #204 (2026-10-17) `fix(images): clarify image choices and make controls translatable`
- PR #205 (2026-10-17) `fix(images): make image review and change history clear and translatable`
- PR #206 (2026-10-17) `perf(roleplay): smooth server-owned reply streaming`
- PR #207 (2026-10-17) `fix(models): show complete provider model lists`
- PR #208 (2026-10-17) `fix(chat): preserve reading position through companion updates`
- PR #209 (2026-10-17) `perf(generation): start post-reply agents sooner`

## v1.3.4.1

### Highlights
- Reopening a server-run Roleplay reply now restores **Stop** and keeps **Send** blocked until that reply settles. A second message can no longer slip into the same chat while the first reply's Agents are still working.
- If an Agent fails or the saved chat changes after the model finishes, **Recovered reply** keeps a readable copy beside the chat, with **Copy reply**, **Download reply** and **Dismiss**. It survives reopening and server restarts, including completed previews saved by the previous version, without overwriting your edits or paying for the reply again. Download a copy to keep it permanently; clearing job history or its storage limit can remove old copies.
- Finished Agent additions and sequential rewrites now appear while the remaining Agents work. Parallel rewrite alternatives still wait for their combined result. Refreshed the official handbook and assistant help to explain live progress, Stop and recovered replies.

### Merged Staging PRs
- PR #198 (2026-10-16) `fix(roleplay): preserve replies and restore live agent progress`


## v1.3.4

### Highlights
- Added image input choices for Roleplay and Conversation: **Send the image**, **Use a description** or **Show only**, which keeps a picture in the chat without feeding it to new automatic replies. Account and chat choices win over single images, and **Settings → Appearance → Avatar & Chat Styles → Review image input and repairs** is where you sort them out.
- Added image recovery for chats that older connections choke on: preview a compatible copy, save exact copies of embedded images, repair several chats at once, and use **Recovery history** to export the original chat or undo a repair (as long as you haven't edited that chat since).
- Stopping Agents after the main reply has finished now keeps that reply instead of throwing it away, without paying for it again. Coming back to a tab your phone suspended reconnects to the saved reply rather than leaving the preview stuck.
- Server replies now show ticking elapsed seconds with **Message Timer** on, keep the live bubble visible until the saved reply is ready, and restore the original reply when you cancel an unfinished replacement. The `{{dialoguecolors}}` instructions are captured before sending, so they still reach the model after you close the tab or retry a request.
- Dialogue colours show up while a server reply is still being written again, and finished Companion notes appear one by one, marked **Live reply**, instead of waiting for the slowest one.
- Rebuilt the Character Expressions page with clearer image tiles, **All**, **Ready** and **Missing** filters, **Generate missing** and **More image tools**. Personas get their own expression sets, you can pick a persona's expression by hand, and **Export ZIP** saves a whole set.
- Sprite cleanup leaves fewer white fringes, new sprites can be generated on a green or magenta background that's removed automatically, and there are two optional local models: AI background removal and a 2x or 4x anime enlarger. Both start off, and I'd export your set before using **Redo cleanup**.
- Expression portraits are bigger on phones and **Show expressions in phone chat** puts them above messages in every Roleplay chat style, including ones that hide avatars. Ripple keeps its side portrait.
- **Compact Input Area** works on phones again, so you can pick a single-row composer or a full-width message box above the buttons.
- **Fix trackers** now checks its output against the rules that actually display the tracker, so a block that closes its tags but still shows as raw text counts as a failed repair and your previous tracker stays.
- Added 40 dark, light and animated Regex Agent Themes with a **Browse themes** gallery (filters, **Previous**, **Next**, **Surprise me**), plus eight more Termeownal palettes, and its checkboxes and radio buttons stay round.
- Added ready-made Quick Reply sets (**Story controls**, **Reply directions**, **Writing helpers**, **Ask privately**) and **Make a quick reply** for building your own buttons, and refreshed the official handbook and assistant product help for this release.
- Fixed a Conversation schedule editor focus race that could ignore Escape just after opening.

### Merged Staging PRs
- PR #185 (2026-10-15) `fix(images): preserve chat compatibility and add recovery controls`
- PR #186 (2026-10-15) `fix(agents): keep completed replies when stopping agents`
- PR #187 (2026-10-15) `fix(roleplay): recover replies after tab suspension`
- PR #188 (2026-10-15) `feat(expressions): add persona sets, exports and cleaner sprites`
- PR #189 (2026-10-15) `fix(composer): restore the compact input toggle on phones`
- PR #190 (2026-10-16) `fix(trackers): validate repair output against display regexes`
- PR #191 (2026-10-16) `fix(roleplay): restore live colours and companion progress`
- PR #192 (2026-10-16) `feat(expressions): rebuild the expressions page and enlarge phone portraits`
- PR #193 (2026-10-16) `feat(regex-agent-themes): add 40 themes and an easier theme gallery`
- PR #194 (2026-10-16) `feat(termeownal): add eight more palettes and keep toggles round`
- PR #195 (2026-10-16) `feat(quick-reply): ready-made sets, a builder and a clearer panel`
- PR #197 (2026-10-16) `fix(roleplay): preserve live timers, replies and dialogue colours`

## v1.3.3

### Highlights
- Placed the bundled tools directly inside **Workspace**, **Fine-tuning**, **Characters & Lore**, **Appearance** and **Troubleshooting** in the sidebar instead of a separate **Included tools** list. Switched-off tools show an **Off** pill and open **Manage extensions**, **Chat Completion Tabs** can be switched on and off straight from the sidebar, and **Preset Tools** and **Chat Completion Tabs** open their settings directly without an inner drawer.
- Added **Don't color a Narrator card**, a **Not characters** list and **Clean messages** to **Dialogue Colors**. Scenario cards and titled names marked as not characters leave the speaker list and stay in the normal text colour; **Clean messages** strips `[COLORS: ...]` lines and optional colour tags from character messages and swipes with a one-click undo toast.
- Added **Low-memory mode** under **Settings → System & Device → Memory and performance**, with automatic detection on low-RAM phones and browsers, a 25-message rendering window for Roleplay and Conversation, and **Use automatic recommendations** when you want to reset manual overrides. Conversation now renders a bounded window of recent messages, keeps your reading position when loading older history, and requests phone-sized portraits on phones.
- Roleplay replies and post-reply Agents now start and finish while the browser tab is hidden or in the background. A finished server-run reply now joins the chat in place instead of redrawing every message, so long chats no longer freeze or go blank when it lands, and a hidden tab pauses the live preview to save battery. Mewmory keeps background memory work going when after-reply Agents rewrite a reply and keeps new chats enabled when the first reply races setup.
- Made start-up and background work much lighter: Mewmory's background scans skip chats that haven't changed instead of re-reading every enabled story every 15 seconds, start-up no longer uploads settings the server already has, Dialogue Colors stops recolouring and saving on every start, and phones load phone-sized pictures for recent chats and the persona button. The Android app now lets the phone sleep while its server is idle.
- Director's Commentary is now a neutral, sceptical critic that calls out what's ridiculous and says when a scene falls flat, rather than enjoying everything. With both switched on, Continuity Corrector reads the Continuity Companion's latest note, and the Companion's card opens with what the Corrector already fixed.
- Fixed `[object Object]` in the Character Expressions delete confirmation, miracle certificates that left out a citation showing as raw text, half-hidden Echo name plates after jumping through a chat, and the sign-in page asking for the language list twice.
- Card scripts now sandbox only the interactive widget a script drives instead of replacing surrounding message prose, and slash commands inside the sandbox no longer double quotation marks.
- Polished the character library, grid cards, import panel and Persona workspace, restyled BotSearcher and World Info Lab controls, added an **Open keyboard when a chat opens** setting, and opened Scratchpad's image prompt review straight from **Generate image**.
- Translated the sign-in page, server error pages and composed error messages into German, Italian and Portuguese, and refreshed the official handbook and assistant product help for this release.

### Merged Staging PRs
- PR #160 (2026-10-14) `fix(i18n): translate error pages and improve language selection`
- PR #161 (2026-10-13) `fix(i18n): translate composed error messages`
- PR #162 (2026-10-13) `fix(i18n): translate the rewritten error messages into Portuguese`
- PR #163 (2026-10-13) `fix(i18n): translate the rewritten error messages into Italian`
- PR #164 (2026-10-13) `fix(i18n): translate the rewritten error messages into German`
- PR #170 (2026-10-14) `fix(agents): update the companion lock cue in place`
- PR #172 (2026-10-14) `fix(connection-manager): keep saved details readable in narrow panes`
- PR #182 (2026-10-14) `fix(agents): let the shared agent editor scroll on desktop`

## v1.3.2

### Highlights
- Added General Scratchpad from Home, with its own account-wide sessions and no hidden chat context.
- Scratchpad can propose images through Quick Image Gen and review a new portrait before saving it to the exact shared card. Generated pictures survive closing the page; the previous portrait is preserved separately.
- Added saved browser, server and Android crash reports, with readable recovery notices and individual copy/share actions. Nothing is uploaded automatically. Recent activity helps explain what was happening; it doesn't prove what caused a crash.
- Isolated interactive card scripts and tightened their allowed slash commands. Browsers without direct-connection blocking require an explicit choice for each card; older Android wrappers need an update.
- Manual after-reply Agents now run one at a time, separately from Companions. Knowledge Guard reads active lore, the Author's Note and saved Secrets Tracker values; saved tracker context also reaches before-reply and server-owned helpers.
- Put version numbers beside Agent names, kept phone Stop controls readable and left the prompt list open. Preset section locks now fill their row's height.
- Fixed Meower saves on Windows and refreshed the handbook and assistant help for this release.

### Merged Staging PRs
- PR #156 (2026-10-13) `fix(meower): make Windows saves work`

## v1.3.1

### Highlights

- Added Continuity Corrector, an optional after-reply Agent that checks scene facts against recent messages, trackers, lore and prepared memory. Proofreader and Friction Keeper have clearer instructions for preserving tracker blocks.
- Moved **Fix trackers** beside **Agents On/Off**, with a separate repair connection, ordered fallbacks and a configurable time limit. Companion notes and Agent changes now show the model used for their results.
- Added **Pinned prompts** beside the desktop Roleplay chat. Pin frequently used prompt switches from the preset's prompt list; each preset keeps its own pins.
- Added in-app Android updates through **Server → Updates & Restart → Update APK**, with update notices and checks before Android opens the installer.
- Shared Scratchpad sessions across a character's chats and a group's chats. Conversation keeps separate lists for each persona, and selected messages and proposed edits stay tied to their original chat.
- Added **Entry tools → Vectorize all** for lorebooks and **Add all** for Meower's cast, with controls for constant lore entries and an undo option for invitations.
- Fixed Roleplay preview scrolling and streaming, Hush and Ripple layouts, accent colours on controls and character tags, scrolling in the new-connection dialog, and returning to chat after closing workspace pages.
- Reworded errors and notices to explain what happened and what to do next. Updated the official handbook and the assistants' product reference for this release.

### Merged Staging PRs
- PR #132 (2026-10-12) `feat(meower): add an add-all character selection button`
- PR #133 (2026-10-12) `feat(android): add GitHub APK updates and update notices`
- PR #134 (2026-10-12) `fix(roleplay): stabilise preview scrolling and streaming`
- PR #135 (2026-10-12) `fix(scratchpad): share sessions across character chats`
- PR #136 (2026-10-12) `fix(ui): keep buttons accent-aware across shell styles`
- PR #137 (2026-10-12) `fix(chats): correct the Hush reading layout and controls`
- PR #138 (2026-10-12) `fix(errors): rewrite error messages and toasts in plain language`
- PR #143 (2026-10-12) `fix(chats): correct the Ripple reading layout and controls`
- PR #144 (2026-10-12) `fix(motion): show the chat behind a page while it closes`

## v1.3.0

### Highlights

- Scratchpad can now talk with your own assistants as well as Miso, Taro and Nori. Copy one from a character card or write one from scratch, keep up to 24 in your library, and seat up to three at a round table. Random picks who answers, global user instructions apply across every Scratchpad in your account, the included assistants have stronger personalities, automatic cleanup is shared across chats, the story's character cards are now shared in full instead of three fields cut at 8,000 characters, and a new Current preset option shares the Roleplay preset as its own section, listing every module in order and whether it is on or off.
- Restyled Conversation as a messenger, with replies that stream in as they are written and live token counts on messages.
- Page, chat and swipe motion now follows what you tapped, Safari slides start from the first frame and missing animations are filled in. Reduced-motion settings remain respected.
- Added cat pairs, Windows 98 pixel coats and dark backgrounds, and the bottom bar width no longer follows the page width.
- Cut the freeze after opening a long chat, bounded browser caches and shared server tokenisers between requests.
- Server-built Roleplay prompts now enforce macro boundaries and save prompt variables, so browser-only Macro Enhanced macros no longer run there. Transferred-data repair no longer stops at a single bad file.
- Added a World Info Lab shortcut to Lorebooks, kept auto-closing notices up for at least 5 seconds, and fixed the Whisper reading layout, Guided Generations previews, Agents recovery checks after a chat change and dialogue colour deletion.
- Refreshed the README screenshots and added Scratchpad to them, updated the [official handbook](https://platberlitz.github.io/neconyan-docs/) for these changes and refreshed the assistants' app-help reference.

### Merged Staging PRs
- PR #107 (2026-10-10) `fix(chats): correct the Whisper reading layout and controls`
- PR #108 (2026-10-10) `fix(dialogue-colors): allow deletion after background saves`
- PR #109 (2026-10-10) `fix(scratchpad): refresh assistants and improve reply controls`
- PR #110 (2026-10-10) `feat(chat): add live token counts and conversation streaming`
- PR #111 (2026-10-10) `fix(ui): smooth iOS motion and fill in missing animations`
- PR #112 (2026-10-10) `fix(toasts): keep auto-closing toasts up for at least 5 seconds`
- PR #113 (2026-10-10) `feat(scratchpad): add global user instructions`
- PR #114 (2026-10-10) `fix(motion): start slides from the first frame on Safari`
- PR #115 (2026-10-10) `feat(lorebooks): add a World Info Lab shortcut`
- PR #116 (2026-10-10) `feat(scratchpad): strengthen personalities and add random replies`
- PR #117 (2026-10-10) `feat(conversation): restyle Conversation as a messenger`
- PR #118 (2026-10-11) `fix(guided-generations): keep guides and live previews intact`
- PR #119 (2026-10-11) `feat(motion): make page, chat and swipe motion follow what you tapped`
- PR #120 (2026-10-11) `perf(chat): cut the freeze after opening a chat`
- PR #121 (2026-10-11) `fix(ui): decouple the bottom bar width from the page width`
- PR #122 (2026-10-11) `fix(roleplay): stop single files blocking transferred-data repair`
- PR #123 (2026-10-11) `fix(roleplay): enforce macro boundaries and save prompt variables`
- PR #124 (2026-10-11) `fix(agents): stop recovery checks re-clearing after a chat change`
- PR #125 (2026-10-11) `feat(art): add cat pairs, pixel coats and dark backgrounds`
- PR #126 (2026-10-11) `feat(scratchpad): add custom and character-card assistants`
- PR #127 (2026-10-11) `perf(tokens): bound browser caches and share server tokenisers`
- PR #128 (2026-10-11) `fix(scratchpad): share automatic cleanup across chats`
- PR #129 (2026-10-11) `fix(scratchpad): share every part of the character card in full`
- PR #131 (2026-10-11) `feat(scratchpad): share the current preset as its own section`

## v1.2.5

### Highlights

- Reorganised Agents around Manage agents and Connections & defaults, with Quick settings on each card, shared edits for selected Agents, and Batch & connect for Companions.
- Added Character Authenticity Checker, an initially disabled reply rewriter that preserves story-earned character growth. Rewriters can read up to 30 recent messages, and Agent prompts can include prepared Mewmory context and group cards.
- Scratchpad can propose new character cards for review, including from a notebook discussion. Change reviews highlight additions and removals, and saving a reviewed character creates it only once.
- Character Expressions supports separate sets for people sharing a card, automatic selection from named speakers, custom expression lists, search and image filters, and improved sheet cropping and background cleanup.
- Slash-command scripts run during replies, can check, wait for or stop generation, and preserve composer drafts when requesting a reply.
- Rebuilt Formatting into task-based sections, kept Connections status compact and made Companion actions easier to reach on phones.
- Improved Echo's reading layout, fixed the Bubbles lower edge and Flat assistant artwork, added per-side sleeping-cat choices and a dark Windows XP Olive theme, and removed drawer animation stalls. Reduced-motion settings remain respected.
- Refreshed German, Italian and Portuguese interface translations. JannyAI imports now identify cards whose creators have disabled proxy access, and compatible streamed tool calls accept repeated tool names.
- Fixed Android exports started from detached download links and expanded the native runtime checks in the test suite.
- Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/) for these controls and checked the assistants' refreshed app-help reference.

### Merged Staging PRs
- PR #83 (2026-10-09) `fix(chats): keep the Bubbles lower edge behind the toolbar`
- PR #93 (2026-10-09) `fix(connections): keep status compact and use native controls`
- PR #96 (2026-10-09) `feat(agents): make the Agents page easier to follow`
- PR #99 (2026-10-09) `fix(stscript): preserve drafts and run commands during replies`
- PR #100 (2026-10-09) `feat(expressions): expand expression sets and improve cleanup`
- PR #103 (2026-10-10) `fix(ui): unify drawer motion and remove animation stalls`

## v1.2.4.2

Android fix for [#80](https://github.com/platberlitz/Neconyan/issues/80). The crash record from 1.2.4.1 showed where the server died: inside `Intl.Segmenter`, the JavaScript word splitter that Mewmory's memory search uses. That's why the long chat, which has Mewmory switched on, crashed on every send or regenerate and a fresh chat without Mewmory didn't.

### Highlights

- The Node runtime inside the APK only carried English-only ICU data (the language rules behind word splitting, sorting and similar), without word-break rules. Splitting words then crashed the whole server instead of raising an error. The APK now ships the official full ICU 78.3 data file, pinned by checksum, and the server loads it at start.
- Memory search also splits words with a plain Unicode pattern on any Node runtime that lacks that data, so it can't reach the crash again.
- The packaged-APK check now splits words inside the installed runtime. The same check on the published 1.2.4.1 APK reproduces the crash, so the check proves the fix rather than just passing.
- Saved chats, memories and settings aren't changed. Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/start/android/) and the assistants' app-help reference.

## v1.2.4.1

Diagnostic Android hotfix for [#80](https://github.com/platberlitz/Neconyan/issues/80). After 1.2.4 the reporter's existing chat still restarted the server on send or regenerate, and the copied details only said `signal 11` with no record of where the crash happened.

### Highlights

- The Android server now leaves segmentation faults to Android's crash dumper instead of Node's WebAssembly trap handler, so a native crash produces a real crash record (a tombstone) rather than ending silently as `signal 11`. WebAssembly keeps working with explicit bounds checks.
- The app decodes that crash record after the restart: signal, fault address, the crashing thread, a backtrace with library names and offsets, and the last log lines. **Copy details for a bug report** includes it, together with the native stack size.
- The server keeps a short trace of the most recent requests on Android, so the copied details name the request that was in flight when the server died. The trace from the previous start is kept across the restart.
- Hotfix versions now use four parts (`1.2.4.1`), and the Android version code accounts for the fourth part.
- The packaged-APK check now crashes the server with a real segmentation fault and expects the decoded crash record and the request trace to survive. Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/start/android/) and the assistants' app-help reference. Confirmation on the affected Samsung is still needed.

## v1.2.4

Follow-up Android hotfix for [#80](https://github.com/platberlitz/Neconyan/issues/80). The recovery in 1.2.3 helped the app reopen, but the reporter still saw native crashes when sending or regenerating in an existing chat.

### Highlights

- The Android server now runs on its own native thread with an explicit 8 MiB stack, the memory used for active function calls. It no longer depends on the default Java thread leaving enough space for Node and the tokenisers. Saved chats aren't changed.
- Copied bug reports include the native stack size. A signal-11 crash alone doesn't establish damaged chat data or an out-of-memory failure.
- Added packaged-APK checks for a 1,600-message context, long-input token counting, streamed and non-streamed replies against a test provider, and recoverable JavaScript and WebAssembly errors.
- Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/start/android/) and assistants' app-help reference. Confirmation on the affected Samsung is still needed.

## v1.2.3

Android hotfix for [#80](https://github.com/platberlitz/Neconyan/issues/80), where the app stopped opening and showed `ERR_CONNECTION_RESET` or `kill failed: ESRCH`.

### Highlights

- The Android app notices when its local server stops while starting, instead of waiting five minutes and showing an error. It restarts the server once in **safe mode**, which pauses background Mewmory updates, automatic Conversation messages and interrupted tasks until you retry them. The next start is normal.
- If the server still can't start, a recovery screen offers **Try again**, **Save a backup of my data**, **Copy details for a bug report** and **Close Neconyan**. The backup is a ZIP of your account folder, saved without the server, and **Import Backup ZIP** accepts it in another installation. Saved API keys are only included if you choose to.
- Page load failures reconnect to the workspace instead of showing the WebView error page.
- The server's memory limit now scales with the phone's memory, from 512 MB up to 2 GB, instead of a fixed 512 MB. The previous server log is kept for bug reports.
- Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/start/android/) and the assistants' app-help reference.

## v1.2.2

### Highlights

- The swipe picker shows each version as a card you can read, copy, branch from or delete. Open it from the swipe counter on desktop or with a long press on phones.
- Added **Desktop response controls** to place the swipe arrows and counter inside the bubble or below it on wide screens.
- Added **Guided Regenerate**, which replaces the latest reply using the composer text as direction. Input History now opens a searchable picker that replaces your draft.
- Reply passes set to **Run together** now run at the same time on the original reply. Differing rewrites are combined with one extra request.
- Added the **NSFW Enhancer** rewriter, off by default, and **Keep the original when an Agent refuses**, on by default. Companions can choose **Where kept notes go**.
- Mewmory can hide old messages past a token limit and turn itself on in every new chat. Its Automatic memory switches now save as soon as you change them.
- Long chats no longer fail the server World Info scan, and the Labs open saved chats up to 64 MiB.
- JannyAI link imports name the real reason they fail. A different ZIP starts its own saved upload, and expired security tokens refresh once before retrying.
- Termux recovery continues its saved data folder, keeps the phone awake during startup and switches to a file-time compatibility mode when the phone needs it.
- Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/) and the assistants' app-help reference.

### Merged Staging PRs
- PR #66 (2026-10-08) `feat: add Desktop swipe button customization controls`
- PR #67 (2026-10-08) `fix(tools): open tool pages in translated interfaces`
- PR #68 (2026-10-08) `fix(import): recover replacement zips and stale security tokens`
- PR #69 (2026-10-08) `fix(chat): keep desktop response controls clear of the bottom toolbar`
- PR #70 (2026-10-08) `fix(agents): run parallel reply passes concurrently`
- PR #71 (2026-10-08) `feat(guided-generations): add guided regenerate`
- PR #72 (2026-10-08) `fix(input-history): use a readable native picker`
- PR #73 (2026-10-08) `feat(agents): add NSFW Enhancer and keep replies when an agent refuses`
- PR #75 (2026-10-08) `feat(agents): let companions choose where kept notes go`
- PR #76 (2026-10-08) `fix(chats-styles): align document content, cats and swipe controls`
- PR #78 (2026-10-08) `feat(chat): rework the swipe picker as Neconyan cards`

## v1.2.1

### Highlights

- Search saved chats, notes, character definitions, personas and lorebook entries across your account, alongside pages and settings. Search tolerates small spelling mistakes and doesn't call a model.
- Added Dialogue Humaniser and six focused reply rewriters alongside Proofreader. Five short pre-generation note helpers are also installed by default. They start disabled; enable only the ones you need because each model-based helper adds a request.
- Reply rewriters run in order while append agents can run together. Appended blocks survive rewriting, with duplicate blocks and copied reply text cleaned up.
- Added explicit **Import as new instance** for chats from another installation. It creates a separate character instance and history. Android can select JSONL chat files, and saved ZIP imports recheck their retained upload after reinstalling.
- Reorganised Chat & Writing and Visual Toggles, added movable-panel layouts, compacted the character editor and moved Tour buttons beside page headings.
- Fixed additional lorebook selection on phones, stale Time Machine restores, Scratchpad context refresh, tracker formatting and mobile reply start delays.
- Opening Scratchpad from a note now waits for an autosave already in progress instead of rejecting the sharing request.
- Updated the [official handbook](https://platberlitz.github.io/neconyan-docs/) and the assistants' app-help reference.

### Merged Staging PRs
- PR #43 (2026-10-07) `fix(scratchpad): refresh Context when shared notes change`
- PR #44 (2026-10-07) `fix(dialogue-colors): stop wasted verification requests and fix audit bugs`
- PR #45 (2026-10-07) `fix(scratchpad): keep the default prompt from duplicating Notebook rules`
- PR #46 (2026-10-07) `fix(quick-image-gen): retain cancellation during queued image downloads`
- PR #47 (2026-10-07) `fix(time-machine): prevent lost edits and repair snapshot capture`
- PR #48 (2026-10-07) `feat(tour): shrink the Tour chip so collapsed page blurbs stay one line`
- PR #49 (2026-10-07) `fix: show names people wrote as written instead of translating them`
- PR #50 (2026-10-07) `feat(characters): compact the character editor`
- PR #51 (2026-10-07) `fix(agents): keep tracker repair labels still while loading`
- PR #52 (2026-10-07) `feat(agents): clean up tracker companion replies automatically`
- PR #53 (2026-10-07) `fix(trackers): strip copied MANDATORY markers from tracker notes`
- PR #54 (2026-10-07) `fix(chat): start mobile replies without waiting for a redraw`
- PR #56 (2026-10-07) `feat(settings): group visual toggles with plain descriptions`
- PR #57 (2026-10-07) `feat(agents): add six default reply rewrite agents`
- PR #58 (2026-10-07) `feat(agents): add five fast pre-generation note templates`
- PR #59 (2026-10-07) `docs: point help links to the official neconyan handbook`
- PR #60 (2026-10-07) `feat(import): add explicit adoption as a new instance`
- PR #61 (2026-10-07) `feat(settings): rebuild chat & writing settings and add MovingUI presets`
- PR #62 (2026-10-07) `fix(import): keep jsonl chats selectable on android`
- PR #63 (2026-10-07) `fix(lorebooks): enable the additional books picker on mobile`
- PR #64 (2026-10-07) `fix(import): recheck retained zip uploads after reinstall`
- PR #65 (2026-10-07) `fix(ui): place tours beside headings and tighten page spacing`

## v1.2.0

### Merged Staging PRs
- PR #28 (2026-10-06) `fix(notes): highlight the picked template and add a Delete button`
- PR #29 (2026-10-06) `fix: phone menu no longer sends you back to Home`
- PR #30 (2026-10-06) `feat: connect scratchpad to notebook and preserve sessions on chat rename`
- PR #31 (2026-10-06) `fix: load the chat archive on large libraries`
- PR #32 (2026-10-06) `fix: add Portuguese entries for many controls that still showed English`
- PR #37 (2026-10-06) `feat(personas): rebuild the Persona page and load its styles first`
- PR #41 (2026-10-07) `fix: let Tab accept a Notebook link suggestion on list lines`
- PR #42 (2026-10-07) `docs: say which notebook details Scratchpad sends`

## v1.1.1

### Merged Staging PRs
- PR #13 (2026-10-05) `fix: review and improve the Portuguese translation and fill selected gaps`
- PR #15 (2026-10-05) `feat: add exact chat links and account-wide launch resume`
- PR #16 (2026-10-05) `chore: refresh the English interface catalogue`
- PR #17 (2026-10-05) `fix: stop refusing saved chats over extension message fields`
- PR #18 (2026-10-05) `fix: show the Notes canvas and property-table warnings that never appeared`
- PR #19 (2026-10-05) `fix: keep preset names untranslated so selecting, renaming and deleting presets works in every language`
- PR #20 (2026-10-05) `feat: add Scratchpad, a side chat for planning stories with Miso, Taro and Nori`
- PR #21 (2026-10-05) `fix: allow empty main prompt placeholders`
- PR #22 (2026-10-05) `fix: stop the run-time localiser translating user text and finished translations`
- PR #23 (2026-10-05) `fix: keep dismissed tour invitations closed after reload`
- PR #24 (2026-10-05) `fix: slim the bottom chat bar on phone and desktop`
- PR #25 (2026-10-05) `feat: the assistants can make agents for you`
- PR #26 (2026-10-05) `feat: fit more character cards on screen in the phone list`
- PR #27 (2026-10-05) `feat: add an AMOLED black theme`

## v1.1.0

### Merged Staging PRs
- PR #4 (2026-10-02) `fix: italian translation`
- PR #5 (2026-10-02) `feat: add Windows 98, Windows Aero and Windows Aero Light themes`
- PR #6 (2026-10-02) `fix: log the Roleplay workflow routing decision and stream finish reason`
- PR #7 (2026-10-02) `fix: use the configured reply length for Roleplay workflow generations`
- PR #8 (2026-10-02) `fix: coerce numeric chat settings so a quoted context size cannot block the Roleplay workflow`
- PR #10 (2026-10-03) `feat: add Notes notebooks with assistant edits and linked lore`
- PR #11 (2026-10-04) `fix: correct three runtime localisation faults in the settings screens`
- PR #12 (2026-10-04) `fix: build accessibility labels and import counts so translations can replace them`

## v1.0.6

### Merged Staging PRs
- PR #2 (2026-09-30) `fix: improve german translation quality`
