import Foundation
import UserNotifications
import UIKit

/// Local notifications need no remote push entitlement and work with sideloaded IPAs.
@MainActor
final class NativeNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let inbox: URL
    private let defaults = UserDefaults.standard
    private let center = UNUserNotificationCenter.current()
    private var draining = false
    private var revision = 0

    init(inbox: URL) {
        self.inbox = inbox
        super.init()
        center.delegate = self
    }

    func state() async -> [String: Bool] {
        let settings = await center.notificationSettings()
        let permitted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        return ["enabled": defaults.bool(forKey: "notifications.enabled") && permitted]
    }

    func setEnabled(_ enabled: Bool) async -> [String: Bool] {
        revision += 1
        let requestRevision = revision
        let allowed = enabled ? ((try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false) : false
        guard revision == requestRevision else { return await state() }
        defaults.set(allowed, forKey: "notifications.enabled")
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "notifications.since")
        if !allowed {
            center.removeAllPendingNotificationRequests()
            center.removeAllDeliveredNotifications()
        }
        return await state()
    }

    /// Called before the background keeper releases its final work allowance.
    func drain() {
        guard !draining, defaults.bool(forKey: "notifications.enabled") else { return }
        draining = true
        var allowance = UIBackgroundTaskIdentifier.invalid
        allowance = UIApplication.shared.beginBackgroundTask(withName: "Deliver notifications") {
            if allowance != .invalid { UIApplication.shared.endBackgroundTask(allowance); allowance = .invalid }
        }
        Task {
            defer {
                draining = false
                if allowance != .invalid { UIApplication.shared.endBackgroundTask(allowance) }
            }
            guard (await state())["enabled"] == true,
                  let data = try? Data(contentsOf: inbox), data.count <= 262144,
                  let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let events = document["events"] as? [[String: Any]] else { return }
            var seen = Set(defaults.stringArray(forKey: "notifications.seen") ?? [])
            let since = max(defaults.double(forKey: "notifications.since"), Date().timeIntervalSince1970 * 1000 - 3600000)
            for event in events {
                guard defaults.bool(forKey: "notifications.enabled"), let id = event["id"] as? String,
                      !seen.contains(id), let created = event["createdAt"] as? Double, created >= since,
                      let title = event["title"] as? String, let body = event["body"] as? String else { continue }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                do {
                    try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
                    if !defaults.bool(forKey: "notifications.enabled") {
                        center.removePendingNotificationRequests(withIdentifiers: [id])
                        center.removeDeliveredNotifications(withIdentifiers: [id])
                    }
                    seen.insert(id)
                } catch { /* Keep undelivered IDs eligible for the next poll. */ }
            }
            let retained = Set(events.compactMap { $0["id"] as? String })
            defaults.set(Array(seen.intersection(retained)), forKey: "notifications.seen")
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
