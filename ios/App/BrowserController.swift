import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class BrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    private var web: WKWebView!
    private var server: LocalServer?
    private var keeper: BackgroundKeeper?
    private var pickReply: (@MainActor @Sendable (Any?, String?) -> Void)?
    private let status = UILabel()
    private let actions = UIStackView()
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var connecting = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // The page starts its quiet keep-alive sound on its own once it is hidden mid-reply.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "nativeDiagnostics")
        config.userContentController.add(self, name: "neconyanBackground")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "neconyanImport")
        config.userContentController.addUserScript(WKUserScript(source: """
        (() => {
            const send = (kind, text) => window.webkit.messageHandlers.nativeDiagnostics.postMessage({kind, text: String(text).slice(0, 12000)});
            addEventListener('error', e => send('error', e.error?.stack || e.message || e.target?.src), true);
            addEventListener('unhandledrejection', e => send('error', e.reason?.stack || e.reason));
            addEventListener('neconyan:ready', () => send('ready', 'Workspace initialisation completed'));
            addEventListener('DOMContentLoaded', () => {
                let reportedFailure = false;
                const inspect = () => {
                    const failure = document.querySelector('#preloader pre');
                    if (failure && !reportedFailure) { reportedFailure = true; send('error', failure.textContent); }
                };
                const observer = new MutationObserver(inspect);
                observer.observe(document.documentElement, {subtree: true, childList: true});
                addEventListener('neconyan:ready', () => observer.disconnect(), {once: true});
                inspect();
            });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        retry.addTarget(self, action: #selector(connect), for: .touchUpInside)
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
        connect()
    }

    @objc private func connect() {
        guard !connecting else { return }
        connecting = true
        actions.isHidden = false
        status.text = "Starting Neconyan on this iPhone…"
        Task {
            defer { connecting = false }
            do {
                if server == nil { server = try LocalServer() }
                guard let server else { return }
                if keeper == nil {
                    keeper = BackgroundKeeper(marker: server.state.appendingPathComponent("ios-busy"))
                    keeper?.start()
                }
                // Installing the payload and starting Node must not block UIKit's main thread.
                try await Task.detached { try server.start() }.value
                let cookies = try await server.signIn()
                for cookie in cookies { await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
                web.load(URLRequest(url: server.origin))
            } catch { status.text = error.localizedDescription }
        }
    }

    @objc private func resume() {
        guard !connecting, let url = web.url else { return }
        if url.path == "/login" || web.isHidden { connect() }
    }

    @objc private func shareLog() { if let url = server?.logURL { share(url) } }

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
        if body["kind"] == "ready" { web.accessibilityIdentifier = "workspace-ready" }
        NSLog("Neconyan web %@: %@", body["kind"] ?? "diagnostic", text)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, isLocal(source),
              let body = message.body as? [String: Any], body["action"] as? String == "pickArchive" else {
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
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.path == "/login" { connect(); return }
        web.isHidden = false
        actions.isHidden = true
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        web.accessibilityIdentifier = "workspace-loading"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        keeper?.setPageBusy(false)
        connect()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        status.text = error.localizedDescription
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
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "Neconyan", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Neconyan", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: "Neconyan", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text ?? "") })
        present(alert, animated: true)
    }
}
