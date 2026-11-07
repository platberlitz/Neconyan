import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class BrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    private var web: WKWebView!
    private var server: LocalServer?
    private var keeper: BackgroundKeeper?
    private var notifications: NativeNotifications?
    private var pickReply: (@MainActor @Sendable (Any?, String?) -> Void)?
    private let status = UILabel()
    private let actions = UIStackView()
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var connecting = false
    private var recoveryRequired = false
    private let diagnostics = StartupDiagnostics.shared
    #if DEBUG
    private var injectedStartupFailure = false
    #endif

    override func viewDidLoad() {
        super.viewDidLoad()
        var hardware = utsname()
        uname(&hardware)
        let machineSize = MemoryLayout.size(ofValue: hardware.machine)
        let model = withUnsafePointer(to: &hardware.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: machineSize) { String(cString: $0) }
        }
        let build = (try? Bundle.main.url(forResource: "payload-version", withExtension: "txt").map { try String(contentsOf: $0, encoding: .utf8) }) ?? "unknown"
        diagnostics.record("app-launch", detail: "version=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown") build=\(build.trimmingCharacters(in: .whitespacesAndNewlines)) device=\(model) os=\(ProcessInfo.processInfo.operatingSystemVersionString) physicalMemoryBytes=\(ProcessInfo.processInfo.physicalMemory)")
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // The page starts its quiet keep-alive sound on its own once it is hidden mid-reply.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "nativeDiagnostics")
        config.userContentController.add(self, name: "neconyanBackground")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "neconyanImport")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "neconyanNotifications")
        config.userContentController.addUserScript(WKUserScript(source: #"""
        (() => {
            const resources = new Set();
            const errors = new Set();
            let suppressedResources = 0, suppressedErrors = 0;
            const redact = value => String(value).slice(0, 12000)
                .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
                .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|cookie)\s*["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}]+)/gi, '$1[redacted]')
                .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]{12,}/g, '[redacted]')
                .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
                .replace(/((?:https?|file):\/\/[^\s?#)"']+)[?#][^\s)"']*/gi, '$1?[redacted]')
                .replace(/(\/[\w/.-]+)[?#][^\s)"']*/g, '$1?[redacted]');
            const send = (kind, text) => {
                try { window.webkit.messageHandlers.nativeDiagnostics.postMessage({kind, text: redact(text)}); } catch {}
            };
            const snapshot = event => {
                try {
                    const api = window.NeconyanCrashDiagnostics;
                    send('activity', JSON.stringify({ event, readyState: document.readyState, online: navigator.onLine,
                        visibility: document.visibilityState, viewport: [innerWidth, innerHeight],
                        navigationType: performance.getEntriesByType('navigation')[0]?.type || 'unknown',
                        startup: api?.getStartupGuardState?.(), activity: api?.getActivity?.(),
                        suppressedResources, suppressedErrors }));
                } catch {}
            };
            const describe = (error, depth = 0) => {
                if (error === null || typeof error !== 'object') return typeof error === 'string' ? redact(error) : 'Non-Error rejection (' + typeof error + ')';
                const result = {};
                for (const key of ['name', 'message', 'stack', 'code']) {
                    try { if (typeof error[key] === 'string' || typeof error[key] === 'number') result[key] = redact(error[key]); } catch {}
                }
                try { if (error.cause !== undefined && depth < 3) result.cause = describe(error.cause, depth + 1); } catch {}
                return result;
            };
            const reportError = (error, source = '', line = 0, column = 0) => {
                const text = redact(JSON.stringify({ error: describe(error), source, line, column }));
                if (errors.has(text) || errors.size >= 20) { suppressedErrors++; return; }
                errors.add(text);
                snapshot('before-error');
                send('error', text);
            };
            addEventListener('error', e => {
                if (e.error || e.message) { reportError(e.error || e.message, e.filename, e.lineno, e.colno); return; }
                const target = e.target;
                const source = target?.getAttribute?.('src') || target?.getAttribute?.('href');
                if (!source) { suppressedResources++; return; }
                const detail = String(target.tagName) + ': ' + redact(source);
                if (resources.has(detail) || resources.size >= 30) { suppressedResources++; return; }
                resources.add(detail);
                send('resource-error', detail);
            }, true);
            addEventListener('unhandledrejection', e => reportError(e.reason));
            addEventListener('neconyan:ready', () => { send('ready', 'Workspace initialisation completed'); snapshot('workspace-ready'); });
            addEventListener('load', () => snapshot('window-load'));
            addEventListener('pageshow', e => snapshot(e.persisted ? 'pageshow-restored' : 'pageshow'));
            addEventListener('pagehide', () => snapshot('pagehide'));
            document.addEventListener('visibilitychange', () => snapshot('visibilitychange'));
            addEventListener('neconyan:memory-lifecycle', () => snapshot('native-memory-lifecycle'));
            snapshot('document-start');
            // Retain reviewed activity counters while the page is alive, not after a process kill.
            setInterval(() => { if (document.visibilityState === 'visible') snapshot('heartbeat'); }, 30000);
            addEventListener('DOMContentLoaded', () => {
                snapshot('dom-content-loaded');
                let reportedFailure = false;
                const inspect = () => {
                    const failure = document.querySelector('#preloader pre');
                    if (failure && !reportedFailure) { reportedFailure = true; reportError(failure.textContent); }
                };
                const observer = new MutationObserver(inspect);
                observer.observe(document.documentElement, {subtree: true, childList: true});
                addEventListener('neconyan:ready', () => observer.disconnect(), {once: true});
                inspect();
            });
        })();
        """#, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.accessibilityIdentifier = "workspace-loading"
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isHidden = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        status.text = "Starting Neconyan on this iPhone…"
        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .preferredFont(forTextStyle: .body)
        status.adjustsFontForContentSizeCategory = true
        status.accessibilityIdentifier = "startup-status"
        let retry = UIButton(type: .system)
        retry.setTitle("Try again", for: .normal)
        retry.addTarget(self, action: #selector(retryConnection), for: .touchUpInside)
        let logs = UIButton(type: .system)
        logs.setTitle("Share startup log", for: .normal)
        logs.addTarget(self, action: #selector(shareLog), for: .touchUpInside)
        actions.axis = .vertical
        actions.spacing = 16
        [status, retry, logs].forEach(actions.addArrangedSubview)
        actions.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(actions)
        NSLayoutConstraint.activate([
            actions.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            actions.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            actions.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        connect()
    }

    @objc private func retryConnection() {
        guard !connecting else { return }
        diagnostics.record("explicit-retry")
        recoveryRequired = false
        connect()
    }

    private func connect() {
        guard !connecting, !recoveryRequired else { return }
        connecting = true
        diagnostics.beginAttempt()
        web.isHidden = true
        actions.isHidden = false
        status.text = "Starting Neconyan on this iPhone…"
        Task {
            defer { connecting = false }
            do {
                diagnostics.stage("server-setup")
                #if DEBUG
                if !injectedStartupFailure, ProcessInfo.processInfo.environment["NECONYAN_TEST_STARTUP_FAILURE"] == "setup" {
                    injectedStartupFailure = true
                    throw LocalServerError.message("Test startup failure before the local server was created.")
                }
                #endif
                if server == nil { server = try LocalServer() }
                guard let server else { return }
                if keeper == nil {
                    notifications = NativeNotifications(inbox: server.state.appendingPathComponent("native-notifications.json"))
                    keeper = BackgroundKeeper(marker: server.state.appendingPathComponent("ios-busy"), pollNotifications: { [weak self] in self?.notifications?.drain() })
                    keeper?.start()
                }
                // Installing the payload and starting Node must not block UIKit's main thread.
                try await Task.detached { try server.start() }.value
                let cookies = try await server.signIn()
                diagnostics.stage("install-session-cookies", detail: "count=\(cookies.count)")
                for cookie in cookies { await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
                guard !recoveryRequired else { return }
                diagnostics.stage("load-workspace")
                web.load(URLRequest(url: server.origin))
            } catch { showRecovery(error.localizedDescription, reason: "connection-failed", error: error) }
        }
    }

    @objc private func resume() {
        notifyMemoryLifecycle("foreground")
        guard !connecting, !recoveryRequired, let url = web.url else { return }
        if url.path == "/login" || web.isHidden { connect() }
    }

    @objc private func background() { notifyMemoryLifecycle("background") }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        notifyMemoryLifecycle("pressure")
    }

    private func notifyMemoryLifecycle(_ state: String) {
        diagnostics.record("native-\(state)", detail: "thermalState=\(ProcessInfo.processInfo.thermalState.rawValue) lowPower=\(ProcessInfo.processInfo.isLowPowerModeEnabled) recovery=\(recoveryRequired)")
        guard !recoveryRequired, let web, let url = web.url, isLocal(url), ["foreground", "background", "pressure"].contains(state) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('neconyan:memory-lifecycle',{detail:{state:'\(state)'}}))", completionHandler: nil)
    }

    @objc private func shareLog() {
        do {
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent("exports/\(UUID().uuidString)", isDirectory: true)
            let report = try diagnostics.export(serverLog: server?.logURL, to: destination)
            share(report, removeAfterwards: true)
        } catch {
            diagnostics.record("share-failed", detail: StartupDiagnostics.errorDetails(error))
            status.text = "Could not prepare the startup log: \(error.localizedDescription)"
        }
    }

    private func share(_ url: URL, removeAfterwards: Bool = false) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if removeAfterwards {
            sheet.completionWithItemsHandler = { _, _, _, _ in
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
        }
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin = server?.origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, isLocal(source) else { return }
        if message.name == "neconyanBackground" {
            if let busy = (message.body as? [String: Any])?["busy"] as? Bool { keeper?.setPageBusy(busy) }
            return
        }
        guard let body = message.body as? [String: String], let text = body["text"] else { return }
        let kind = body["kind"] ?? "diagnostic"
        if kind == "ready", !recoveryRequired {
            web.accessibilityIdentifier = "workspace-ready"
            diagnostics.stage("workspace-ready")
        }
        diagnostics.record("web-\(kind)", detail: text)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, isLocal(source),
              let body = message.body as? [String: Any] else {
            replyHandler(nil, "Unsupported request.")
            return
        }
        if message.name == "neconyanNotifications", let notifications {
            Task {
                if body["action"] as? String == "set", let enabled = body["enabled"] as? Bool {
                    replyHandler(await notifications.setEnabled(enabled), nil)
                } else if body["action"] as? String == "status" {
                    replyHandler(await notifications.state(), nil)
                } else { replyHandler(nil, "Unsupported request.") }
            }
            return
        }
        guard message.name == "neconyanImport", body["action"] as? String == "pickArchive" else {
            replyHandler(nil, "Unsupported request.")
            return
        }
        guard pickReply == nil, presentedViewController == nil else {
            replyHandler(nil, "A file picker is already open.")
            return
        }
        pickReply = replyHandler
        // A copy keeps the original in Files untouched; the server removes this one once it is retained.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.zip], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    private struct PickedArchive: Sendable { let token: String; let name: String; let size: Int; let lastModified: Int64 }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickReply?(nil, nil)
        pickReply = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let reply = pickReply else { return }
        pickReply = nil
        guard let picked = urls.first, let inbox = server?.importInbox else { reply(nil, "No ZIP was picked."); return }
        Task {
            do {
                let chosen = try await Task.detached { () -> PickedArchive in
                    let fm = FileManager.default
                    try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
                    let token = UUID().uuidString
                    let destination = inbox.appendingPathComponent("\(token).zip")
                    let modified = (try? picked.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
                    // The picked copy sits on the same volume, so moving it is instant even for a 13 GB ZIP.
                    do { try fm.moveItem(at: picked, to: destination) } catch { try fm.copyItem(at: picked, to: destination) }
                    let values = try destination.resourceValues(forKeys: [.fileSizeKey])
                    return PickedArchive(token: token, name: picked.lastPathComponent, size: values.fileSize ?? 0,
                                         lastModified: Int64(modified.timeIntervalSince1970 * 1000))
                }.value
                reply(["token": chosen.token, "name": chosen.name, "size": chosen.size, "lastModified": chosen.lastModified], nil)
            } catch {
                reply(nil, "Could not prepare the ZIP: \(error.localizedDescription)")
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        } else if url.scheme == "blob", navigationAction.sourceFrame.isMainFrame, let source = navigationAction.sourceFrame.request.url, isLocal(source) {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false, navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse {
            diagnostics.record("navigation-response", detail: "status=\(response.statusCode) path=\(response.url?.path ?? "unknown")")
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !recoveryRequired else { return }
        #if DEBUG
        // Exercise the real recovery callbacks without private WebKit process APIs.
        if !injectedStartupFailure, let failure = ProcessInfo.processInfo.environment["NECONYAN_TEST_STARTUP_FAILURE"] {
            injectedStartupFailure = true
            if failure == "termination" { webViewWebContentProcessDidTerminate(webView) }
            if failure == "navigation" { self.webView(webView, didFailProvisionalNavigation: navigation, withError: URLError(.cannotConnectToHost)) }
            // A late completion must not hide the recovery controls.
            self.webView(webView, didFinish: navigation)
            return
        }
        #endif
        if webView.url?.path == "/login" {
            showRecovery("Local sign-in did not finish. Try again or share the startup log.", reason: "sign-in-redirect")
            return
        }
        web.isHidden = false
        actions.isHidden = true
        diagnostics.record("navigation-finished", detail: "path=\(webView.url?.path ?? "unknown") ready=\(web.accessibilityIdentifier == "workspace-ready")")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        web.accessibilityIdentifier = "workspace-loading"
        diagnostics.record("navigation-started", detail: "path=\(webView.url?.path ?? "unknown")")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        diagnostics.record("navigation-committed", detail: "path=\(webView.url?.path ?? "unknown")")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showRecovery("The Neconyan page stopped unexpectedly. Try again or share the startup log.", reason: "web-process-terminated; cause unavailable from WebKit")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showRecovery(error.localizedDescription, reason: "provisional-navigation-failed", error: error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showRecovery(error.localizedDescription, reason: "committed-navigation-failed", error: error)
    }

    private func showRecovery(_ message: String, reason: String, error: Error? = nil) {
        diagnostics.record("recovery", detail: "reason=\(reason) page=\(web.url?.path ?? "not loaded") state=\(web.accessibilityIdentifier ?? "unknown") \(error.map { StartupDiagnostics.errorDetails($0) } ?? message)")
        recoveryRequired = true
        keeper?.setPageBusy(false)
        web.stopLoading()
        web.isHidden = true
        status.text = message
        actions.isHidden = false
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isLocal(url) { webView.load(navigationAction.request) }
            else if ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("exports/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = (suggestedFilename as NSString).lastPathComponent
            let destination = directory.appendingPathComponent(["", ".", ".."].contains(filename) ? "neconyan-export" : filename)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { share(url, removeAfterwards: true) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let alert = UIAlertController(title: "Export failed", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
    private func presentJavaScriptDialog<T>(_ message: String, from frame: WKFrameInfo, defaultValue: T, completionHandler: @escaping (T) -> Void, configure: (UIAlertController, @escaping (T) -> Void) -> Void) {
        var completed = false
        let complete: (T) -> Void = { value in
            guard !completed else { return }
            completed = true
            completionHandler(value)
        }
        guard frame.isMainFrame, let source = frame.request.url, isLocal(source),
              !web.isHidden, pickReply == nil, presentedViewController == nil,
              !isBeingPresented, !isBeingDismissed, viewIfLoaded?.window != nil else {
            complete(defaultValue)
            return
        }
        let alert = UIAlertController(title: "Neconyan", message: message, preferredStyle: .alert)
        configure(alert, complete)
        present(alert, animated: true)
        if presentedViewController !== alert { complete(defaultValue) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentJavaScriptDialog(message, from: frame, defaultValue: (), completionHandler: { _ in completionHandler() }) { alert, complete in
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in complete(()) })
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentJavaScriptDialog(message, from: frame, defaultValue: false, completionHandler: completionHandler) { alert, complete in
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in complete(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in complete(true) })
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        presentJavaScriptDialog(prompt, from: frame, defaultValue: nil, completionHandler: completionHandler) { alert, complete in
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in complete(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in complete(alert.textFields?.first?.text ?? "") })
        }
    }
}
