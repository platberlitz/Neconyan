# Crash diagnostics

Neconyan keeps detailed reports when the server, browser interface or Android app fails. Reports stay on your device or server. Nothing is uploaded automatically.

## Read a report

Open **Included tools**, open **Debugger** settings, then choose **Saved crash reports**. You can copy or download browser and server reports. Server reports require an administrator account. Browser reports remain readable when the server is unavailable, provided the interface can still open.

In the APK, reopening after an unexpected stop offers the saved Android reports. The failure screen also has **Saved crash reports**. From the debugger's saved-report window, **Android crash reports** opens the native reader even when the page's JavaScript did not record the failure. **Copy latest report** copies the newest report within Android's clipboard size limit; older reports remain selectable in the reader.

If the server cannot start, its terminal prints the report's location. Reports are stored in the data folder's `crash-reports` directory. Android's native reports are stored separately in private app storage, outside the replaceable application files and cache.

## What is recorded

- **Server:** the exception, nested causes and grouped errors, stack locations, error codes, app revision, runtime and operating system versions, memory and resource usage, uptime, and recent request operations, sizes, status codes and timings.
- **Browser:** unhandled exceptions and rejected promises, script and stylesheet load failures, source locations, nested causes, browser and app versions, viewport, connection and visibility state, recent lifecycle events, and memory figures when the browser exposes them. Capture starts before the main application scripts and works with the debugger disabled.
- **Android:** uncaught Java exceptions, server startup failures, WebView renderer loss, and Android's historical process exits for the app and local server. System records include the reason, signal or exit code, process importance, memory figures and any available native crash or not-responding trace. Recovery reports label device measurements taken after the exit.

The newest five browser reports and ten reports in each server or Android store are retained. Each report is size-limited so repeated failures cannot fill storage. A browser error that keeps repeating from the same place is counted on one report, with its repeat count and last time, instead of pushing older reports out. When the server fails, the first error is saved and any further errors during its shutdown are printed to the terminal only. Reports survive normal restarts and updates; clearing site storage, deleting app data or uninstalling removes the corresponding local reports.

## Limits and private information

An error does not always mean the entire app crashed. Conversely, a process killed by the operating system cannot write its own final report. The server supervisor records available signals; after an unclean exit, startup records the previous process's identity. Android supplies additional exit reasons and may attach a trace later. Reports explicitly say when the underlying cause is unknown. A browser-only process kill cannot be diagnosed by JavaScript running inside that process.

Request bodies, headers, environment variables, launch arguments and arbitrary console values are not collected. Common credential patterns and URL queries are redacted from error text. Error messages and system traces can still contain private text supplied by extensions or other software, so read a report before sharing it.

If storage is full or blocked, saving can fail. The browser reader reports that failure and still offers the in-memory report; the server writes a warning to its terminal. A severe memory failure or power loss can prevent even these fallback messages.
