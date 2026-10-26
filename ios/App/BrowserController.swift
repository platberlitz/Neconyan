import UIKit
import WebKit

@MainActor
final class BrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var web: WKWebView!
    private var server: LocalServer?
    private let status = UILabel()
    private let actions = UIStackView()
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var connecting = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        web = WKWebView(frame: .zero, configuration: config)
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

    private func share(_ url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin = server?.origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
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
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.path == "/login" { connect(); return }
        web.isHidden = false
        actions.isHidden = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { connect() }
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
            let destination = directory.appendingPathComponent(filename.isEmpty ? "neconyan-export" : filename)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { share(url) }
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
}
