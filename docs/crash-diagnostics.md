# Crash diagnostics

I want a stopped app to leave something you can actually read. Neconyan retains errors from the server, browser page and Android APK, including their recorded causes and recent activity. Nothing is uploaded automatically. These reports don't fix low-memory crashes, and I can't guarantee a final write when a process runs out of memory or the phone loses power. A server that runs out of JavaScript heap is the exception I've worked around, because Node can write its own report as it stops (see 'Server memory, fatal errors and restarts').

## Read the report immediately

The Android app opens an unseen saved report after relaunch, before signing the page into its local server. An outdated WebView doesn't block the native reader. If the page renderer stops while the app survives, the failure screen gains the completed report and its actions. If the local server stops, its report stays available while the server starts again. Android still gets one safe-mode retry after a failed start; diagnostics don't change the restart policy.

Each native report shows its explanation, recorded error, time, earlier activity and memory measurement before the full details. 'Copy report' and 'Share report' use only the selected report and don't close the reader. 'Saved crash reports' lists up to ten reports individually. Copy or share an unsaved report before closing its screen.

In a browser, an uncleared running record from the same tab produces a persistent notice only if the previous page was visible. Background kills and discards stay available for manual reading without interrupting your return or replacing actual error reports. 'Read report' opens retained browser details immediately, even with Debugger disabled, the main application broken or the server offline. Once the notice has been presented, ordinary reloads don't offer it again. Other tabs' retained activity is available in the reader only; it never produces an automatic crash notice.

A reload that Neconyan starts itself leaves a note first: loading an update after you return to the tab, the 'Update ready' notice, a server restart or update you asked for, 'Reload now' after newer settings were saved elsewhere, a finished import, clearing cached files, and the reloads that protect your data. The note records the time, a reason from a fixed list and, for an update, the old and new version or commit. It lives in its own eight-entry slot, so routine reloads can't push a discard record out, and it is never a crash: it raises no notice, doesn't count towards the failed-start counter and the page that reloaded records a normal close. 'Read report' lists these notes after the recovery observations.

A startup error that the page can catch appears as 'Neconyan could not finish loading', with the recorded error, 'Retry startup' and 'Read report'. Retrying reloads the page and keeps saved browser data. It doesn't reload repeatedly or bury the error under an older notice. This panel is separate from the two-unfinished-starts screen below: a failure that stops the page before this panel can run still depends on the retained browser report and its recovery notice.

Two unfinished starts in a row change the next load. Instead of starting the app, the page shows a start screen with the time of the last recorded activity. 'Read crash report' opens the retained report before any application work starts, so the next stop cannot replace the screen first. 'Start Neconyan' continues a normal start, 'Start in low-memory mode' saves that choice before starting, and 'Clear frontend cache and reload' removes cached frontend files, resets the failed-start count and reloads. The start screen replaces the boot instead of appearing behind a fresh crash notice.

iPhone and iPad WebKit expose no device memory figure, so a crash loop is the only low-memory signal those browsers give. After a loop, low-memory mode is turned on automatically for the next start; an explicit off is respected, and 'Start without low-memory mode' turns it off for this start. Any start that reaches readiness clears the failed-start count. A clean close, a page that reached readiness, or a new tab does not inherit another tab's crash loop. Desktop and Android use the same counter but only change low-memory mode when the user chooses it.

For an administrator, a retained server crash report produces a notice when the server becomes reachable. A normal restart with no new report stays quiet. The notice includes the saved report's date, rather than claiming an old failure just happened. Both summaries and full server reports require an administrator account. Server report contents are never saved in browser storage.

You can also open 'Saved crash reports' from Debugger settings without turning on live debugging. Browser reports have individual Copy and Download actions. Server loading happens separately, so a slow or refused request doesn't delay the browser reader. The APK's 'Android crash reports' action opens its native reader.

## What the activity sample contains

Activity is context, not blame. Seeing Proofreader running doesn't establish that Proofreader caused the stop.

- Fixed mode and page categories, readiness, visibility and uptime.
- Message count and a text-only size estimate, calculated from UTF-16 string lengths. Attachments, object overhead and metadata aren't included. Initial measurement is split into small tasks, capped at 5,000 messages and 1,000 alternatives per message, and later message changes update their cached lengths. A capped estimate is marked incomplete.
- The number of rendered children directly inside the chat. There's no whole-page element scan.
- Browser heap measurements where the browser exposes them, enabled Agent/extension counts, and up to eight running Agents with their phase and browser/server location.
- Reviewed built-in Agent labels, including Format Fixer and Proofreader. Custom Agents get document-local anonymous labels. Names, prompts and outputs aren't copied.
- The state of 'Stay open in the background' (off, on, playing, blocked, failed, stopped while hidden, paused from the media notification, or unsupported), since when, how many times the sound stopped on that page and, for the last stop, which event the audio element reported and how many seconds it had played. These are fixed values, and the event is what the browser reported, not a cause.
- Twelve compact recent events. Android also retains up to eight memory-pressure callbacks and time-stamped device memory measurements for each process.
- A separate count of stored Agent history entries, including bounded alternative-message metadata. This counts entries without serialising their private contents; text size alone can miss substantial Agent history.

Normal activity writes are coalesced, at least five seconds apart. A visible idle page refreshes every thirty seconds and a hidden page every sixty, so the last write of a page that never closed is its last sign of life. The record also holds when the page was hidden and whether the browser had frozen it. The browser snapshot and native bridge payload stay within 4 KiB; per-tab and native process records stay within 8 KiB. Counters cap at one million, sizes at 1 TiB and uptime at thirty days. Unavailable measurements stay null rather than becoming zero. Android writes activity on a separate diagnostic worker, with the newest six process records retained.

## Errors and retained history

Server reports include the exception, nested causes, grouped errors, stack locations, error codes, runtime and operating system versions, memory/resource usage and recent request operations, sizes, statuses and timings. Native Roleplay's server-owned Agents are observed too, without changing their requests, saved results or acceptance checks.

Browser capture starts before the main application scripts, but after the stylesheet links. It records unhandled errors and script/stylesheet load failures. An ordinary unhandled error is saved silently; it isn't automatically treated as a stopped page. A failed core startup script can produce a startup notice, suppressed if that document later finishes starting.

Android reports retain uncaught Java exceptions, local server failures, renderer loss and available Android historical exits, including reason/status codes and system traces. A recorded Node exception is preferred over a generic recovery message when it matches the local server process and time window. Android can attach a trace later; enrichment keeps the same report identity rather than creating another notice.

The newest five browser error reports and ten reports in each server/native store are retained. Recovery observations use their own eight-entry slot. Tab activity keeps the current tab and the newest seven others, dropping records older than seven days. Native reports are at most 60,000 characters; server reports are at most 128 KiB. Repeating browser errors update one report's count. The first fatal server exception remains the saved error; later shutdown errors are printed without replacing it. Existing reports remain readable after an upgrade.

## Server memory, fatal errors and restarts

The server normally runs as a child of a small supervisor process, and the supervisor writes the report when the child stops without saying why. A server that runs out of JavaScript memory can't run any more JavaScript, so the report depends on three pieces of evidence that don't need the dying server to cooperate.

- **Node's own fatal-error report.** Once the data folder is known, the server asks Node to write a diagnostic report if it dies from a fatal error, such as running out of JavaScript heap. Only that trigger is on; uncaught errors and signals keep their existing handlers. Network and environment sections are switched off. The supervisor (or, if no supervisor survived, the next start) reads the file and keeps only a small extract: Node's event text and trigger, the time, the JavaScript heap's used, reserved, limit and available bytes with each heap space's used and size, the process's resident and peak memory, the device's free and total memory, and up to 20 names from the top of the native stack, each with only the file name of its module. It never copies the host name, working directory, command line, loaded libraries, user limits, network or environment sections. The raw file is deleted after it's read, including when it can't be understood, and any raw file left with no matching record of a running server is deleted at the next start, so raw reports don't build up. The extract counts as out of memory when Node's trigger is `OOMError` or its text says the heap ran out.
- **The server's own readings.** Every 10 seconds, and once as the monitor starts, the server sends the supervisor one reading: its time, uptime, resident memory, JavaScript heap used, reserved and limit, external memory and array buffers, and the device's available and total memory, all in bytes. The supervisor drops anything that isn't a complete set of finite, non-negative numbers, and keeps the newest 12 readings plus the one with the highest heap, for that server only. They appear in the report as `child.memory`. The newest was taken up to 10 seconds before the server stopped, so the last moments can be missing.
- **The signal or exit code**, as before.

The report's kind says how much was established.

- `server-out-of-memory`: Node's fatal-error report says the heap ran out. The explanation gives the memory in use and the limit Node reported, and the report adds a `nextStep` saying the limit can be raised with `NODE_OPTIONS=--max-old-space-size=<MB>`.
- `server-fatal-error`: Node reported another fatal error. The explanation quotes its event text and doesn't guess further.
- `child-process-signal` and `child-process-exit`: no fatal-error report arrived, so the cause isn't established and the wording says so. If the last reading showed the JavaScript heap at 90% or more of its limit, or less than 5% of the device's memory available, the explanation adds that observation and its age. It remains an observation: a device that kills a process for memory sends no fatal-error report, so readings alone never turn one of these into an out-of-memory report.
- `unclean-previous-exit`: no supervisor survived to describe the stop, so the next start does. If the previous server left a fatal-error report, the explanation says it ran out of JavaScript memory, or quotes the fatal error, and the extract is in `fatal`.

Reports from the supervisor keep `environment` for the supervisor, which survives, and put the server's pid, signal, exit code, fatal-error extract, readings and heap flag under `child`. Server reports also record the JavaScript heap limit beside the other memory figures. In the reader, a server report with these figures gets a readable line above the full text, and a notice on the next visit includes the explanation and its numbers. With **App diagnostics** on in Scratchpad, an admin's assistant receives them as short lines under the crash report: Node's account, the newest reading, the heap readings oldest to newest and the next step.

### Termux and the JavaScript heap limit

On Android, V8 caps the JavaScript heap at about 1 GB whatever the phone has, and a Termux server that outgrows it stops with 'JavaScript heap out of memory'. When Node runs on Android, the supervisor starts the server with `--max-old-space-size` set to a quarter of the device's memory, never below 1024 MB (V8's Android default) and never above 2048 MB. A 12 GB phone gets 2048 MB, a 6 GB phone 1536 MB and a 3 GB phone 1024 MB. Your own choice always wins: nothing is added when the runtime flags or `NODE_OPTIONS` already contain `--max-old-space-size` (or `--max_old_space_size`), and the supervisor doesn't change other platforms or Bun. The terminal prints the flag it added, and the report records it as `child.heapLimitArgument`. The Android app doesn't use the supervisor and sets its own limit, between 512 and 2048 MB. A higher limit gives the server more room but doesn't remove a leak.

### Starting again after an unexpected stop

If a server that had finished starting stops unexpectedly (a signal, an out-of-memory abort or an error exit), the supervisor writes the report, prints why the server stopped and where the report is, waits about a second and starts it again, without opening the browser a second time. Pressing Ctrl+C or closing the terminal during that second stops everything with no new server. A server that stops three times in ten minutes isn't started again: the supervisor says so and exits, so a persistent fault doesn't loop. A server that stops before it finishes starting, which usually means a broken setting or a port already in use, is never restarted automatically. Normal exits, in-app restarts, plugin updates and shutdown requests are unaffected. An administrator then sees a notice that the server restarted after an unexpected stop, with the saved report.

## What a report cannot establish

When the previous page did not close, the report states whether it was hidden at its last sign of life, for how long it had been hidden by then, how long before reopening that was, and what 'Stay open in the background' was doing. The page stopped at some point between that last sign of life and reopening; the browser provides neither the time nor the cause. A phone commonly unloads a hidden page to free memory, particularly when no keep-alive sound is playing, but a report can't confirm that this is what happened, and it never says so. A record written by an older version has no hidden time, so it says the page was hidden but not for how long.

A missing browser close event isn't proof of a crash. Ordinary navigation/reload records a normal close; backgrounding alone doesn't. A page restored from the browser's back/forward cache resumes its existing document. Where available, the browser's discard flag identifies a discarded page, but doesn't supply a definite cause. If reopening loses the tab's session storage, automatic same-tab detection is unavailable. Duplicating a tab can copy its session storage, so the same-tab record alone cannot establish which document stopped. There is no cross-tab probing or automatic orphan-tab diagnosis.

An Android low-memory exit reason supports 'Android closed Neconyan to free memory'. A signal alone, renderer termination or 'UI hidden' callback doesn't. Earlier activity and memory samples show their time and age; samples recorded after an exit aren't presented as earlier evidence. Figures measured after reopening are labelled separately. Android may never deliver a pressure callback, and the last few seconds can be missing after a kill.

Real phone testing is still needed to diagnose the Samsung A13 failure. Host Java compilation and browser simulations don't establish Android's native UI behaviour, clipboard/share handling, real low-memory-killer behaviour or performance on that phone.

## Privacy and storage failure

Diagnostics don't collect chat, response or reasoning text, prompts, character/account/chat names, chat/file identifiers, Agent outputs, model/connection settings, API keys, headers, launch arguments, environment variables or arbitrary console values. Chat statistics read string lengths without retaining those strings. Full server-log tails aren't automatically added to native reports. Common credential patterns and URL queries are redacted before writing and displaying.

The separate Android 'Copy details for a bug report' action is an explicit exception: it combines the selected report with device details, recent exits, decoded native evidence, requests and bounded log tails. Those tails can contain private application text despite credential redaction. Review the combined copy carefully. 'Copy report' and 'Share report' still use one selected report only.

Error messages and system traces can still contain private text supplied by extensions or other software. Review a report before sharing it.

Blocked or full storage leaves the current in-memory browser/native report readable where possible, with a warning that it couldn't be saved. The server prints a storage warning. Clearing site storage, deleting app data or uninstalling removes the corresponding retained reports. A severe memory failure or power loss can prevent even the fallback.
