package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.*;
import android.os.FileObserver;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import org.json.*;

/** Reads the local server's private inbox, including while its WebView is suspended. */
final class NativeNotifications {
    private static final String CHANNEL = "messages";
    private static final String INBOX = "native-notifications.json";
    private static final String CONSENT = "notification-consent.json";
    static final int INBOX_EVENTS = FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO;
    private final Context context;
    private final FileObserver consentWatcher;
    private boolean closed;

    NativeNotifications(Context context) {
        this.context = context;
        context.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Toasts and Conversation DMs", NotificationManager.IMPORTANCE_DEFAULT));
        consentWatcher = new FileObserver(context.getNoBackupFilesDir(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
            @Override public void onEvent(int event, String path) {
                if (CONSENT.equals(path)) synchronized (NativeNotifications.class) {
                    if (closed) return;
                    if (enabled(context)) drainLocked();
                    else cancelMessages(context);
                }
            }
        };
        consentWatcher.startWatching();
    }

    private static SharedPreferences preferences(Context context) { return context.getSharedPreferences("notifications", Context.MODE_PRIVATE); }

    private static File consentFile(Context context) { return new File(context.getNoBackupFilesDir(), CONSENT); }

    // SharedPreferences caches its values per process. The UI alone writes consent;
    // the server reads the latest atomic snapshot and owns the separate seen list.
    private static long enabledSince(Context context) {
        try {
            File file = consentFile(context);
            if (file.isFile() && file.length() <= 1024) {
                JSONObject value = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                return value.getBoolean("enabled") ? value.getLong("since") : Long.MAX_VALUE;
            }
        } catch (Exception ignored) { }
        return Long.MAX_VALUE;
    }

    static void migrateConsent(Context context) {
        SharedPreferences old = preferences(context);
        if (!consentFile(context).exists()) writeConsent(context, old.getBoolean("enabled", false), old.getLong("since", System.currentTimeMillis()));
    }

    static boolean enabled(Context context) {
        return enabledSince(context) != Long.MAX_VALUE && context.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    static synchronized void setEnabled(Context context, boolean enabled) {
        writeConsent(context, enabled, System.currentTimeMillis());
        if (!enabled) cancelMessages(context);
    }

    private static void writeConsent(Context context, boolean enabled, long since) {
        AtomicFile file = new AtomicFile(consentFile(context));
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(new JSONObject().put("enabled", enabled).put("since", since).toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            android.util.Log.w("Neconyan", "Could not save notification consent", error);
        }
    }

    private static void cancelMessages(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
            if (CHANNEL.equals(notification.getNotification().getChannelId())) manager.cancel(notification.getTag(), notification.getId());
        }
    }

    void onInboxEvent(int event, String path) {
        if (INBOX.equals(path) && (event & INBOX_EVENTS) != 0) drain();
    }

    void drain() {
        synchronized (NativeNotifications.class) {
            if (!closed) drainLocked();
        }
    }

    private void drainLocked() {
        if (!enabled(context)) return;
        try {
            File file = new File(context.getFilesDir(), INBOX);
            if (!file.isFile() || file.length() > 256 * 1024) return;
            JSONArray events = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)).getJSONArray("events");
            SharedPreferences prefs = context.getSharedPreferences("notification-receipts", Context.MODE_PRIVATE);
            Set<String> seen = new HashSet<>(prefs.getStringSet("seen", preferences(context).getStringSet("seen", new HashSet<>())));
            Set<String> retained = new HashSet<>();
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.getJSONObject(i);
                String id = event.getString("id");
                retained.add(id);
                if (seen.contains(id) || event.getLong("createdAt") < enabledSince(context)
                    || event.getLong("createdAt") < System.currentTimeMillis() - 3600000 || !manager.areNotificationsEnabled()) continue;
                PendingIntent open = PendingIntent.getActivity(context, 2, MainActivity.openIntent(context), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                manager.notify(id, 2, new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(event.getString("title")).setContentText(event.getString("body"))
                    .setStyle(new Notification.BigTextStyle().bigText(event.getString("body")))
                    .setContentIntent(open).setAutoCancel(true).build());
            }
            prefs.edit().putStringSet("seen", retained).apply();
        } catch (Exception ignored) { /* Atomic inbox replacement or revoked permission: retry on the next write. */ }
    }

    void close() {
        synchronized (NativeNotifications.class) {
            closed = true;
            consentWatcher.stopWatching();
        }
    }
}
