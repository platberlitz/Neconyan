# Crash diagnostics

I want a stopped app to leave something you can actually read. Neconyan retains errors from the server, browser page and Android APK, including their recorded causes and recent activity. Nothing is uploaded automatically. These reports don't fix low-memory crashes, and I can't guarantee a final write when a process runs out of memory or the phone loses power.

## Read the report immediately

The Android app opens an unseen saved report after relaunch, before signing the page into its local server. An outdated WebView doesn't block the native reader. If the page renderer stops while the app survives, the failure screen gains the completed report and its actions. If the local server stops, its report stays available while the server starts again. Android still gets one safe-mode retry after a failed start; diagnostics don't change the restart policy.

Each native report shows its explanation, recorded error, time, earlier activity and memory measurement before the full details. 'Copy report' and 'Share report' use only the selected report and don't close the reader. 'Saved crash reports' lists up to ten reports individually. Copy or share an unsaved report before closing its screen.

In a browser, an uncleared running record from the same tab produces a persistent notice only if the previous page was visible. Background kills and discards stay available for manual reading without interrupting your return or replacing actual error reports. 'Read report' opens retained browser details immediately, even with Debugger disabled, the main application broken or the server offline. Once the notice has been presented, ordinary reloads don't offer it again. Other tabs' retained activity is available in the reader only; it never produces an automatic crash notice.

For an administrator, a retained server crash report produces a notice when the server becomes reachable. A normal restart with no new report stays quiet. The notice includes the saved report's date, rather than claiming an old failure just happened. Both summaries and full server reports require an administrator account. Server report contents are never saved in browser storage.

You can also open 'Saved crash reports' from Debugger settings without turning on live debugging. Browser reports have individual Copy and Download actions. Server loading happens separately, so a slow or refused request doesn't delay the browser reader. The APK's 'Android crash reports' action opens its native reader.

## What the activity sample contains

Activity is context, not blame. Seeing Proofreader running doesn't establish that Proofreader caused the stop.

- Fixed mode and page categories, readiness, visibility and uptime.
- Message count and a text-only size estimate, calculated from UTF-16 string lengths. Attachments, object overhead and metadata aren't included. Initial measurement is split into small tasks, capped at 5,000 messages and 1,000 alternatives per message, and later message changes update their cached lengths. A capped estimate is marked incomplete.
- The number of rendered children directly inside the chat. There's no whole-page element scan.
- Browser heap measurements where the browser exposes them, enabled Agent/extension counts, and up to eight running Agents with their phase and browser/server location.
- Reviewed built-in Agent labels, including Format Fixer and Proofreader. Custom Agents get document-local anonymous labels. Names, prompts and outputs aren't copied.
- Twelve compact recent events. Android also retains up to eight memory-pressure callbacks and time-stamped device memory measurements for each process.
- A separate count of stored Agent history entries, including bounded alternative-message metadata. This counts entries without serialising their private contents; text size alone can miss substantial Agent history.

Normal activity writes are coalesced, at least five seconds apart. A visible idle page refreshes every thirty seconds. Hidden pages stop the periodic work. The browser snapshot and native bridge payload stay within 4 KiB; per-tab and native process records stay within 8 KiB. Counters cap at one million, sizes at 1 TiB and uptime at thirty days. Unavailable measurements stay null rather than becoming zero. Android writes activity on a separate diagnostic worker, with the newest six process records retained.

## Errors and retained history

Server reports include the exception, nested causes, grouped errors, stack locations, error codes, runtime and operating system versions, memory/resource usage and recent request operations, sizes, statuses and timings. Native Roleplay's server-owned Agents are observed too, without changing their requests, saved results or acceptance checks.

Browser capture starts before the main application scripts, but after the stylesheet links. It records unhandled errors and script/stylesheet load failures. An ordinary unhandled error is saved silently; it isn't automatically treated as a stopped page. A failed core startup script can produce a startup notice, suppressed if that document later finishes starting.

Android reports retain uncaught Java exceptions, local server failures, renderer loss and available Android historical exits, including reason/status codes and system traces. A recorded Node exception is preferred over a generic recovery message when it matches the local server process and time window. Android can attach a trace later; enrichment keeps the same report identity rather than creating another notice.

The newest five browser error reports and ten reports in each server/native store are retained. Recovery observations use their own eight-entry slot. Tab activity keeps the current tab and the newest seven others, dropping records older than seven days. Native reports are at most 60,000 characters; server reports are at most 128 KiB. Repeating browser errors update one report's count. The first fatal server exception remains the saved error; later shutdown errors are printed without replacing it. Existing reports remain readable after an upgrade.

## What a report cannot establish

A missing browser close event isn't proof of a crash. Ordinary navigation/reload records a normal close; backgrounding alone doesn't. A page restored from the browser's back/forward cache resumes its existing document. Where available, the browser's discard flag identifies a discarded page, but doesn't supply a definite cause. If reopening loses the tab's session storage, automatic same-tab detection is unavailable. Duplicating a tab can copy its session storage, so the same-tab record alone cannot establish which document stopped. There is no cross-tab probing or automatic orphan-tab diagnosis.

An Android low-memory exit reason supports 'Android closed Neconyan to free memory'. A signal alone, renderer termination or 'UI hidden' callback doesn't. Earlier activity and memory samples show their time and age; samples recorded after an exit aren't presented as earlier evidence. Figures measured after reopening are labelled separately. Android may never deliver a pressure callback, and the last few seconds can be missing after a kill.

Real phone testing is still needed to diagnose the Samsung A13 failure. Host Java compilation and browser simulations don't establish Android's native UI behaviour, clipboard/share handling, real low-memory-killer behaviour or performance on that phone.

## Privacy and storage failure

Diagnostics don't collect chat, response or reasoning text, prompts, character/account/chat names, chat/file identifiers, Agent outputs, model/connection settings, API keys, headers, launch arguments, environment variables or arbitrary console values. Chat statistics read string lengths without retaining those strings. Full server-log tails aren't automatically added to native reports. Common credential patterns and URL queries are redacted before writing and displaying.

The separate Android 'Copy details for a bug report' action is an explicit exception: it combines the selected report with device details, recent exits, decoded native evidence, requests and bounded log tails. Those tails can contain private application text despite credential redaction. Review the combined copy carefully. 'Copy report' and 'Share report' still use one selected report only.

Error messages and system traces can still contain private text supplied by extensions or other software. Review a report before sharing it.

Blocked or full storage leaves the current in-memory browser/native report readable where possible, with a warning that it couldn't be saved. The server prints a storage warning. Clearing site storage, deleting app data or uninstalling removes the corresponding retained reports. A severe memory failure or power loss can prevent even the fallback.
