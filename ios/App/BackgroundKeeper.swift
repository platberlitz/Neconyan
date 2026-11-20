import AVFoundation
import UIKit

/// iOS suspends a backgrounded app within seconds, and the local server with it. While the server reports
/// unfinished work (imports, replies, memory jobs) or the page is still writing a reply, this plays silence
/// once the app leaves the screen, which keeps it running with the screen off or another app open. In the
/// foreground the page owns the audio session (dictation, read-aloud), so the silence only starts on the way out.
@MainActor
final class BackgroundKeeper {
    private let marker: URL
    private let pollNotifications: () -> Void
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var holding = false
    private var playing = false
    private var pageBusy = false
    private var appActive = UIApplication.shared.applicationState == .active
    private var bridge: UIBackgroundTaskIdentifier = .invalid

    init(marker: URL, pollNotifications: @escaping () -> Void = {}) {
        self.marker = marker
        self.pollNotifications = pollNotifications
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
        // Resigning active (app switcher, lock button) comes before iOS freezes the app, so the silence
        // starts while there is still time.
        watch(UIApplication.willResignActiveNotification, nil) { [weak self] _ in self?.setAppActive(false) }
        watch(UIApplication.didBecomeActiveNotification, nil) { [weak self] _ in self?.setAppActive(true) }
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

    private func setAppActive(_ active: Bool) {
        guard active != appActive else { return }
        appActive = active
        poll()
    }

    private func poll() {
        pollNotifications()
        let busy = pageBusy || FileManager.default.fileExists(atPath: marker.path)
        if busy != holding {
            holding = busy
            NSLog("Neconyan background work %@", busy ? "started" : "finished")
            if !busy { endBridge() }
        }
        let wanted = holding && !appActive
        if wanted != playing {
            if wanted { restartAudio() } else { stopAudio() }
        } else if wanted, !engine.isRunning || !sessionKeepsRunning() {
            restartAudio()
        }
    }

    /// The page's own keep-alive sound makes WebKit switch the shared audio session to its own category;
    /// this puts back one that keeps playing with the screen locked. A recording category also keeps
    /// running in the background, and replacing it would cut off dictation.
    private func sessionKeepsRunning() -> Bool {
        let session = AVAudioSession.sharedInstance()
        if session.category == .playAndRecord || session.category == .record { return true }
        return session.category == .playback && session.categoryOptions.contains(.mixWithOthers)
    }

    private func restartAudio() {
        guard holding, !appActive else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            if !sessionKeepsRunning() { try session.setCategory(.playback, mode: .default, options: [.mixWithOthers]) }
            try session.setActive(true)
            playing = true
            guard !engine.isRunning else { return }
            guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100) else { return }
            silence.frameLength = silence.frameCapacity
            player.stop()
            engine.prepare()
            var startError: Error?
            let exception = NeconyanObjC.catchException {
                do { try self.engine.start() } catch { startError = error }
                if startError == nil {
                    self.player.scheduleBuffer(silence, at: nil, options: .loops)
                    self.player.play()
                }
            }
            if let startError { throw startError }
            if let exception { throw LocalServerError.message(exception) }
        } catch {
            NSLog("Neconyan could not keep running in the background: %@", error.localizedDescription)
        }
    }

    private func stopAudio() {
        let wasPlaying = playing
        playing = false
        _ = NeconyanObjC.catchException {
            self.player.stop()
            self.engine.stop()
        }
        // Only give the session back when the silence was the one holding it; the page may be using it.
        if wasPlaying, !appActive { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
        if !holding { endBridge() }
    }

    /// A phone call or an alarm can pause the silence for a moment; this covers the restart.
    private func enteredBackground() {
        appActive = false
        poll()
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
