import AVFoundation
import UIKit

/// iOS suspends a backgrounded app within seconds, and the local server with it. While the server reports
/// unfinished work (imports, replies, memory jobs) or the page is still writing a reply, this plays silence,
/// which keeps the app running with the screen off or another app open. Once both are idle, it stops so the
/// phone can rest.
@MainActor
final class BackgroundKeeper {
    private let marker: URL
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var holding = false
    private var pageBusy = false
    private var bridge: UIBackgroundTaskIdentifier = .invalid

    init(marker: URL) {
        self.marker = marker
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    func start() {
        guard timer == nil else { return }
        let center = NotificationCenter.default
        // Audio notifications can arrive on any thread; hop to the main queue before touching state.
        let watch: (Notification.Name, Any?, @escaping @MainActor (Notification) -> Void) -> Void = { name, object, action in
            self.observers.append(center.addObserver(forName: name, object: object, queue: .main) { note in
                MainActor.assumeIsolated { action(note) }
            })
        }
        watch(AVAudioSession.interruptionNotification, nil) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            self?.restartAudio()
        }
        watch(AVAudioSession.mediaServicesWereResetNotification, nil) { [weak self] _ in self?.restartAudio() }
        watch(.AVAudioEngineConfigurationChange, engine) { [weak self] _ in self?.restartAudio() }
        watch(UIApplication.didEnterBackgroundNotification, nil) { [weak self] _ in self?.enteredBackground() }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        poll()
    }

    /// Reported by the page while it streams or saves a reply in the browser.
    func setPageBusy(_ busy: Bool) {
        guard busy != pageBusy else { return }
        pageBusy = busy
        poll()
    }

    private func poll() {
        let busy = pageBusy || FileManager.default.fileExists(atPath: marker.path)
        if busy != holding {
            holding = busy
            if busy { restartAudio() } else { stopAudio() }
            NSLog("Neconyan background work %@", busy ? "started" : "finished")
        } else if busy, !engine.isRunning || !sessionKeepsRunning() {
            restartAudio()
        }
    }

    /// The page's own keep-alive sound makes WebKit switch the shared audio session to its own category;
    /// this puts back the one that keeps playing with the screen locked.
    private func sessionKeepsRunning() -> Bool {
        let session = AVAudioSession.sharedInstance()
        return session.category == .playback && session.categoryOptions.contains(.mixWithOthers)
    }

    private func restartAudio() {
        guard holding else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            guard !engine.isRunning else { return }
            guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100) else { return }
            silence.frameLength = silence.frameCapacity
            player.stop()
            engine.prepare()
            try engine.start()
            player.scheduleBuffer(silence, at: nil, options: .loops)
            player.play()
        } catch {
            NSLog("Neconyan could not keep running in the background: %@", error.localizedDescription)
        }
    }

    private func stopAudio() {
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        endBridge()
    }

    /// A phone call or an alarm can pause the silence for a moment; this covers the restart.
    private func enteredBackground() {
        guard holding, bridge == .invalid else { return }
        bridge = UIApplication.shared.beginBackgroundTask(withName: "Neconyan server work") { [weak self] in
            MainActor.assumeIsolated { self?.endBridge() }
        }
    }

    private func endBridge() {
        guard bridge != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bridge)
        bridge = .invalid
    }
}
