import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class BrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private struct Popup {
        let web: WKWebView
        let controller: UINavigationController
        let print: UIBarButtonItem
        let title: NSKeyValueObservation
    }

    private var web: WKWebView!
    private var server: LocalServer?
    private var keeper: BackgroundKeeper?
    private var notifications: NativeNotifications?
    private var pickReply: (@MainActor @Sendable (Any?, String?) -> Void)?
    private weak var picker: UIDocumentPickerViewController?
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let retry = UIButton(type: .system)
    private let logs = UIButton(type: .system)
    private let actions = UIStackView()
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var connecting = false
    private var recoveryRequired = false
    // WebKit reports these through separate callbacks, so the controller keeps its own record
    // instead of reading the accessibility identifier the UI tests look for.
    private var workspaceReady = false
    private var loadingWorkspace = false
    private var signedIn = false
    private var skippedSignIn = false
    private var previousProblemShown = false
    private var lastAutoReload: Date?
    private var sharingLog = false
    private var pendingPresentations: [UIViewController] = []
    private var presentationScheduled = false
    private var popup: Popup?
    private var observations: [NSKeyValueObservation] = []
    private var darkChrome: Bool?
    private let diagnostics = StartupDiagnostics.shared
    private let deviceName = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    #if DEBUG
    private var injectedStartupFailure = false
    private var injectedReload = false
    private var injectedPageScript = false
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
        // Shares and exports left behind by a previous run that ended before its sheet closed.
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true))
        }
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // The page starts its quiet keep-alive sound on its own once it is hidden mid-reply.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "nativeDiagnostics")
        config.userContentController.add(self, name: "neconyanBackground")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "neconyanImport")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "neconyanNotifications")
        // WKWebView's user agent has no Version token and Safari 26+ freezes the OS token at 18,
        // so the page reads the real iOS version and memory size from here.
        let device = "{platform:'ios',device:'\(deviceName.lowercased())',osMajor:\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion),memoryBytes:\(ProcessInfo.processInfo.physicalMemory)}"
        config.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window,'neconyanNativeDevice',{value:Object.freeze(\(device))});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        web.allowsLinkPreview = false
        #if DEBUG
        web.isInspectable = true
        #endif
        web.isHidden = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // Every edge follows the safe area, so landscape content stays clear of the notch and the
        // bands around the page take its theme colour.
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        observations = [
            web.observe(\.themeColor, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateChrome() } },
            web.observe(\.underPageBackgroundColor, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateChrome() } },
        ]
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (controller: BrowserController, _: UITraitCollection) in controller.updateChrome() }
        status.text = "Starting Neconyan on this \(deviceName)…"
        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .preferredFont(forTextStyle: .body)
        status.adjustsFontForContentSizeCategory = true
        status.accessibilityIdentifier = "startup-status"
        spinner.hidesWhenStopped = true
        retry.setTitle("Try again", for: .normal)
        retry.titleLabel?.adjustsFontForContentSizeCategory = true
        retry.addTarget(self, action: #selector(retryConnection), for: .touchUpInside)
        logs.setTitle("Share startup log", for: .normal)
        logs.titleLabel?.adjustsFontForContentSizeCategory = true
        logs.addTarget(self, action: #selector(shareLog), for: .touchUpInside)
        actions.axis = .vertical
        actions.spacing = 16
        [spinner, status, retry, logs].forEach(actions.addArrangedSubview)
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

    override var preferredStatusBarStyle: UIStatusBarStyle {
        guard let darkChrome else { return .default }
        return darkChrome ? .lightContent : .darkContent
    }

    private func updateChrome() {
        guard let web else { return }
        let colour = web.isHidden ? nil : (web.themeColor ?? web.underPageBackgroundColor)
        view.backgroundColor = colour ?? .systemBackground
        let dark = colour.map { Self.isDark($0.resolvedColor(with: traitCollection)) }
        guard dark != darkChrome else { return }
        darkChrome = dark
        setNeedsStatusBarAppearanceUpdate()
    }

    private static func isDark(_ colour: UIColor) -> Bool {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard colour.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return false }
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.5
    }

    @objc private func retryConnection() {
        guard !connecting else { return }
        diagnostics.record("explicit-retry")
        recoveryRequired = false
        connect()
    }

    private func showProgress(_ text: String) {
        status.text = text
        spinner.startAnimating()
        retry.isHidden = true
        actions.isHidden = false
    }

    private func connect() {
        guard !connecting, !recoveryRequired else { return }
        connecting = true
        workspaceReady = false
        loadingWorkspace = false
        diagnostics.beginAttempt()
        web.isHidden = true
        updateChrome()
        showProgress("Starting Neconyan on this \(deviceName)…")
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
                if !server.started {
                    // Installing the payload and starting Node must not block UIKit's main thread.
                    let needsInstall = await Task.detached { server.needsInstall }.value
                    showProgress(needsInstall ? "Preparing app files after the update…" : "Starting the local server…")
                    try await Task.detached { try server.start() }.value
                }
                if keeper == nil {
                    notifications = NativeNotifications(inbox: server.state.appendingPathComponent("native-notifications.json"))
                    keeper = BackgroundKeeper(marker: server.state.appendingPathComponent("ios-busy"), pollNotifications: { [weak self] in self?.notifications?.drain() })
                    keeper?.start()
                }
                if let problem = server.previousRunProblem, !previousProblemShown {
                    previousProblemShown = true
                    showRecovery(problem + " Your saved data has been kept. Tap Try again to open Neconyan, or share the startup log first.", reason: "previous-launch-died")
                    return
                }
                showProgress("Opening your workspace…")
                // The remembered session cookie survives a page reload, so a reconnect reuses it
                // instead of creating another 30-day session each time.
                skippedSignIn = signedIn
                if signedIn {
                    if let message = server.nodeExitMessage { throw LocalServerError.message(message) }
                } else {
                    let cookies = try await server.signIn()
                    diagnostics.stage("install-session-cookies", detail: "count=\(cookies.count)")
                    for cookie in cookies { await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
                    signedIn = true
                }
                guard !recoveryRequired else { return }
                diagnostics.stage("load-workspace")
                loadingWorkspace = true
                web.load(URLRequest(url: server.origin))
            } catch { showRecovery(error.localizedDescription, reason: "connection-failed", error: error) }
        }
    }

    @objc private func resume() {
        notifyMemoryLifecycle("foreground")
        guard !connecting, !recoveryRequired, !loadingWorkspace, let url = web.url else { return }
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
        guard !sharingLog else { return }
        sharingLog = true
        let diagnostics = self.diagnostics
        let serverLog = server?.logURL
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("exports/\(UUID().uuidString)", isDirectory: true)
        Task {
            defer { sharingLog = false }
            do {
                // Reading and packing the log tails can take a while on a slow device.
                let report = try await Task.detached(priority: .userInitiated) { try diagnostics.export(serverLog: serverLog, to: destination) }.value
                share(report, removeAfterwards: true)
            } catch {
                diagnostics.record("share-failed", detail: StartupDiagnostics.errorDetails(error))
                status.text = "Could not prepare the startup log: \(error.localizedDescription)"
            }
        }
    }

    private func share(_ url: URL, removeAfterwards: Bool = false) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak self] _, _, _, _ in
            if removeAfterwards { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            MainActor.assumeIsolated { self?.presentPendingSoon() }
        }
        enqueue(sheet)
    }

    // One sheet or dialog shows at a time; the rest wait here instead of being dropped.
    private func enqueue(_ controller: UIViewController) {
        pendingPresentations.append(controller)
        presentPending()
    }

    private var topController: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    private func presentPending() {
        guard let next = pendingPresentations.first else { return }
        let top = topController
        if viewIfLoaded?.window == nil || top.isBeingPresented || top.isBeingDismissed || top.presentedViewController != nil {
            presentPendingSoon()
            return
        }
        // These call presentPendingSoon when they close.
        if top is UIAlertController || top is UIActivityViewController || top is UIDocumentPickerViewController { return }
        pendingPresentations.removeFirst()
        if let popover = next.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        top.present(next, animated: true)
    }

    private func presentPendingSoon() {
        guard !presentationScheduled else { return }
        presentationScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard let self else { return }
            self.presentationScheduled = false
            self.presentPending()
        }
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin = server?.origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }

    // about:blank, about:srcdoc and blob: frames inherit the workspace origin from the page that made them.
    private func isLocal(_ frame: WKFrameInfo?) -> Bool {
        guard let frame, let origin = server?.origin else { return false }
        if let url = frame.request.url, isLocal(url) { return true }
        let security = frame.securityOrigin
        return security.protocol == origin.scheme && security.host == origin.host && security.port == (origin.port ?? 0)
    }

    // WebKit can report no source frame for some navigations despite the non-optional annotation.
    private func sourceFrame(of action: WKNavigationAction) -> WKFrameInfo? {
        action.value(forKey: "sourceFrame") as? WKFrameInfo
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === web, message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, isLocal(source) else { return }
        if message.name == "neconyanBackground" {
            if let busy = (message.body as? [String: Any])?["busy"] as? Bool { keeper?.setPageBusy(busy) }
            return
        }
        guard let body = message.body as? [String: String], let text = body["text"] else { return }
        let kind = body["kind"] ?? "diagnostic"
        diagnostics.record("web-\(kind)", detail: text)
        if kind == "ready", !recoveryRequired {
            workspaceReady = true
            web.accessibilityIdentifier = "workspace-ready"
            diagnostics.stage("workspace-ready")
            #if DEBUG
            debugAfterReady()
            #endif
        }
    }

    #if DEBUG
    private func debugAfterReady() {
        let environment = ProcessInfo.processInfo.environment
        if environment["NECONYAN_TEST_STARTUP_FAILURE"] == "reload-after-ready" {
            if injectedReload {
                web.accessibilityIdentifier = "workspace-ready-after-reload"
                return
            }
            injectedReload = true
            handleWebProcessLoss(allowReload: true)
            return
        }
        if !injectedPageScript, let script = environment["NECONYAN_TEST_PAGE_SCRIPT"] {
            injectedPageScript = true
            web.evaluateJavaScript(script, completionHandler: nil)
        }
    }
    #endif

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.webView === web, message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, isLocal(source),
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
        if let previous = pickReply {
            guard picker == nil else {
                replyHandler(nil, "A file picker is already open.")
                return
            }
            // The last picker closed without calling back, so release the page's earlier request.
            pickReply = nil
            previous(nil, nil)
        }
        pickReply = replyHandler
        // A copy keeps the original in Files untouched; the server removes this one once it is retained.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.zip], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        self.picker = picker
        enqueue(picker)
    }

    private struct PickedArchive: Sendable { let token: String; let name: String; let size: Int; let lastModified: Int64 }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickReply?(nil, nil)
        pickReply = nil
        presentPendingSoon()
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        presentPendingSoon()
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
        let scheme = url.scheme?.lowercased() ?? ""
        let fromLocal = isLocal(sourceFrame(of: navigationAction))
        let download = navigationAction.shouldPerformDownload
        if isLocal(url) {
            decisionHandler(download ? .download : .allow)
            return
        }
        let target = navigationAction.targetFrame
        let isSubframe = target.map { !$0.isMainFrame } ?? false
        let isPopup = webView !== web
        if ["about", "blob", "data"].contains(scheme) {
            if isSubframe || isPopup || target == nil {
                // Card scripts, previews and print views render in srcdoc, blob and blank frames.
                decisionHandler(download ? (fromLocal ? .download : .cancel) : .allow)
            } else {
                // A blob or data link in the workspace itself is an export.
                decisionHandler(fromLocal && scheme != "about" ? .download : .cancel)
            }
            return
        }
        if isSubframe, ["https", "http"].contains(scheme) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if navigationAction.navigationType == .linkActivated || target == nil, ["https", "http", "mailto"].contains(scheme) { UIApplication.shared.open(url) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, webView === web, let response = navigationResponse.response as? HTTPURLResponse {
            diagnostics.record("navigation-response", detail: "status=\(response.statusCode) path=\(response.url?.path ?? "unknown")")
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === web, !recoveryRequired else { return }
        #if DEBUG
        // Exercise the real recovery callbacks without private WebKit process APIs.
        if !injectedStartupFailure, let failure = ProcessInfo.processInfo.environment["NECONYAN_TEST_STARTUP_FAILURE"], ["termination", "navigation"].contains(failure) {
            injectedStartupFailure = true
            if failure == "termination" { handleWebProcessLoss(allowReload: false) }
            if failure == "navigation" { self.webView(webView, didFailProvisionalNavigation: navigation, withError: URLError(.cannotConnectToHost)) }
            // A late completion must not hide the recovery controls.
            self.webView(webView, didFinish: navigation)
            return
        }
        #endif
        loadingWorkspace = false
        if webView.url?.path == "/login" {
            if skippedSignIn {
                // The remembered session has expired; sign in again once before asking for help.
                diagnostics.record("session-expired", detail: "Signing in again after the saved session was refused.")
                signedIn = false
                skippedSignIn = false
                connect()
                return
            }
            showRecovery("Local sign-in did not finish. Try again or share the startup log.", reason: "sign-in-redirect")
            return
        }
        web.isHidden = false
        actions.isHidden = true
        spinner.stopAnimating()
        updateChrome()
        diagnostics.record("navigation-finished", detail: "path=\(webView.url?.path ?? "unknown") ready=\(workspaceReady)")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === web else { return }
        web.accessibilityIdentifier = "workspace-loading"
        diagnostics.record("navigation-started", detail: "path=\(webView.url?.path ?? "unknown")")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === web else { return }
        diagnostics.record("navigation-committed", detail: "path=\(webView.url?.path ?? "unknown")")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else {
            closePopup()
            return
        }
        handleWebProcessLoss(allowReload: true)
    }

    // iOS reclaims the page's process under memory pressure. A workspace that was already working
    // reloads once on its own; a page that never got ready, or keeps stopping, waits for the user.
    private func handleWebProcessLoss(allowReload: Bool) {
        let wasReady = workspaceReady
        workspaceReady = false
        loadingWorkspace = false
        let now = Date()
        if allowReload, wasReady, !recoveryRequired, !connecting, lastAutoReload.map({ now.timeIntervalSince($0) > 60 }) ?? true {
            lastAutoReload = now
            diagnostics.record("web-process-reload", detail: "The page stopped after the workspace was ready; reloading it once.")
            keeper?.setPageBusy(false)
            connect()
            return
        }
        showRecovery("The Neconyan page stopped unexpectedly. Try again or share the startup log.", reason: "web-process-terminated; cause unavailable from WebKit")
    }

    // A cancelled load or a link that turned into a download is not a failure.
    private func isBenign(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return true }
        return error.domain == "WebKitErrorDomain" && error.code == 102
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        if isBenign(error) {
            if !web.isLoading { loadingWorkspace = false }
            return
        }
        showRecovery(error.localizedDescription, reason: "provisional-navigation-failed", error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        if isBenign(error) {
            if !web.isLoading { loadingWorkspace = false }
            return
        }
        showRecovery(error.localizedDescription, reason: "committed-navigation-failed", error: error)
    }

    // The server already answers with the session cookie; this covers a page that asks for the
    // password again, for example after the cookie store was cleared.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if let server, space.authenticationMethod == NSURLAuthenticationMethodHTTPBasic, space.host == server.origin.host,
           space.port == (server.origin.port ?? 0), challenge.previousFailureCount == 0 {
            completionHandler(.useCredential, URLCredential(user: "neconyan", password: server.password, persistence: .forSession))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func showRecovery(_ message: String, reason: String, error: Error? = nil) {
        diagnostics.record("recovery", detail: "reason=\(reason) page=\(web.url?.path ?? "not loaded") state=\(web.accessibilityIdentifier ?? "unknown") \(error.map { StartupDiagnostics.errorDetails($0) } ?? message)")
        recoveryRequired = true
        workspaceReady = false
        loadingWorkspace = false
        keeper?.setPageBusy(false)
        web.stopLoading()
        web.isHidden = true
        updateChrome()
        status.text = message
        spinner.stopAnimating()
        retry.isHidden = false
        actions.isHidden = false
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        let scheme = url?.scheme?.lowercased() ?? "about"
        if let url, !isLocal(url), ["https", "http", "mailto"].contains(scheme) {
            UIApplication.shared.open(url)
            return nil
        }
        // Print views (window.open('')) and local pages opened in a new tab get their own sheet.
        guard webView === web, popup == nil, isLocal(sourceFrame(of: navigationAction)),
              url.map { isLocal($0) } == true || ["about", "blob", "data"].contains(scheme) else { return nil }
        return openPopup(configuration)
    }

    private func openPopup(_ configuration: WKWebViewConfiguration) -> WKWebView {
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        child.allowsLinkPreview = false
        #if DEBUG
        child.isInspectable = true
        #endif
        let page = UIViewController()
        page.view = child
        page.title = "Neconyan"
        let print = UIBarButtonItem(image: UIImage(systemName: "printer"), style: .plain, target: self, action: #selector(printPopup))
        print.accessibilityLabel = "Print"
        page.navigationItem.leftBarButtonItem = print
        page.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(closePopup))
        let controller = UINavigationController(rootViewController: page)
        controller.presentationController?.delegate = self
        let title = child.observe(\.title, options: [.new]) { [weak page] webView, _ in
            MainActor.assumeIsolated {
                let text = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                page?.title = text.isEmpty ? "Neconyan" : text
            }
        }
        popup = Popup(web: child, controller: controller, print: print, title: title)
        enqueue(controller)
        return child
    }

    @objc private func printPopup() {
        guard let popup else { return }
        let printer = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = popup.web.title?.isEmpty == false ? popup.web.title! : "Neconyan"
        info.outputType = .general
        printer.printInfo = info
        printer.printFormatter = popup.web.viewPrintFormatter()
        _ = printer.present(from: popup.print, animated: true)
    }

    @objc private func closePopup() {
        guard let popup else { return }
        self.popup = nil
        releasePopup(popup)
        pendingPresentations.removeAll { $0 === popup.controller }
        if popup.controller.presentingViewController != nil {
            popup.controller.dismiss(animated: true) { [weak self] in MainActor.assumeIsolated { self?.presentPendingSoon() } }
        }
    }

    private func releasePopup(_ popup: Popup) {
        popup.title.invalidate()
        popup.web.stopLoading()
        popup.web.navigationDelegate = nil
        popup.web.uiDelegate = nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === popup?.web { closePopup() }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let popup, presentationController.presentedViewController === popup.controller else { return }
        self.popup = nil
        releasePopup(popup)
        presentPendingSoon()
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // iOS still asks for camera and microphone access the first time; this only skips
        // WebKit's second prompt for the app's own page.
        guard let local = server?.origin, webView === web, frame.isMainFrame, origin.protocol == local.scheme,
              origin.host == local.host, origin.port == (local.port ?? 0) else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.grant)
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
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in MainActor.assumeIsolated { self?.presentPendingSoon() } })
        enqueue(alert)
    }
    private func presentJavaScriptDialog<T>(_ message: String, in webView: WKWebView, from frame: WKFrameInfo, defaultValue: T, completionHandler: @escaping (T) -> Void, configure: (UIAlertController, @escaping (T) -> Void) -> Void) {
        var completed = false
        let complete: (T) -> Void = { [weak self] value in
            guard !completed else { return }
            completed = true
            completionHandler(value)
            self?.presentPendingSoon()
        }
        guard frame.isMainFrame, isLocal(frame), !(webView === web && web.isHidden), webView === web || webView === popup?.web,
              viewIfLoaded?.window != nil else {
            complete(defaultValue)
            return
        }
        let alert = UIAlertController(title: "Neconyan", message: message, preferredStyle: .alert)
        configure(alert, complete)
        enqueue(alert)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentJavaScriptDialog(message, in: webView, from: frame, defaultValue: (), completionHandler: { _ in completionHandler() }) { alert, complete in
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in complete(()) })
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentJavaScriptDialog(message, in: webView, from: frame, defaultValue: false, completionHandler: completionHandler) { alert, complete in
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in complete(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in complete(true) })
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        presentJavaScriptDialog(prompt, in: webView, from: frame, defaultValue: nil, completionHandler: completionHandler) { alert, complete in
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in complete(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in complete(alert?.textFields?.first?.text ?? "") })
        }
    }
}
