package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.*;
import android.os.FileObserver;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import org.json.*;

/** Reads the local server's private inbox, including while its WebView is suspended. */
final class NativeNotifications {
    private static final String CHANNEL = "messages";
    private static final String INBOX = "native-notifications.json";
    private final Context context;
    private final FileObserver watcher;

    NativeNotifications(Context context) {
        this.context = context;
        context.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Toasts and Conversation DMs", NotificationManager.IMPORTANCE_DEFAULT));
        watcher = new FileObserver(context.getFilesDir(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
            @Override public void onEvent(int event, String path) { if (INBOX.equals(path)) drain(); }
        };
        watcher.startWatching();
        drain();
    }

    static SharedPreferences preferences(Context context) { return context.getSharedPreferences("notifications", Context.MODE_PRIVATE); }

    static boolean enabled(Context context) {
        return preferences(context).getBoolean("enabled", false) && context.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    static synchronized void setEnabled(Context context, boolean enabled) {
        preferences(context).edit().putBoolean("enabled", enabled).putLong("since", System.currentTimeMillis()).commit();
        if (!enabled) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
                if (CHANNEL.equals(notification.getNotification().getChannelId())) manager.cancel(notification.getTag(), notification.getId());
            }
        }
    }

    private void drain() {
        synchronized (NativeNotifications.class) { drainLocked(); }
    }

    private void drainLocked() {
        if (!enabled(context)) return;
        try {
            File file = new File(context.getFilesDir(), INBOX);
            if (!file.isFile() || file.length() > 256 * 1024) return;
            JSONArray events = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)).getJSONArray("events");
            SharedPreferences prefs = preferences(context);
            Set<String> seen = new HashSet<>(prefs.getStringSet("seen", new HashSet<>()));
            Set<String> retained = new HashSet<>();
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.getJSONObject(i);
                String id = event.getString("id");
                retained.add(id);
                if (seen.contains(id) || event.getLong("createdAt") < prefs.getLong("since", Long.MAX_VALUE)
                    || event.getLong("createdAt") < System.currentTimeMillis() - 3600000 || !enabled(context)) continue;
                PendingIntent open = PendingIntent.getActivity(context, 2, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                manager.notify(id, 2, new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(event.getString("title")).setContentText(event.getString("body"))
                    .setStyle(new Notification.BigTextStyle().bigText(event.getString("body")))
                    .setContentIntent(open).setAutoCancel(true).build());
            }
            prefs.edit().putStringSet("seen", retained).apply();
        } catch (Exception ignored) { /* Atomic inbox replacement or revoked permission: retry on the next write. */ }
    }

    void close() { watcher.stopWatching(); }
}
