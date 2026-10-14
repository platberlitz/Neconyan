package io.github.platberlitz.neconyan;

import android.app.ActivityManager;
import android.content.Context;
import org.json.JSONObject;

final class DeviceMemoryProfile {
    private static final long BYTES_PER_MIB = 1024L * 1024L;
    private static final long MAX_TOTAL_MIB = 1048576L;

    private DeviceMemoryProfile() {}

    static String serialize(long totalBytes, boolean isLowRamDevice) {
        if (totalBytes <= 0) return "null";
        long totalMemoryMiB = Math.min(MAX_TOTAL_MIB, Math.max(1L, totalBytes / BYTES_PER_MIB));
        try {
            return new JSONObject()
                .put("schema", 1)
                .put("totalMemoryMiB", totalMemoryMiB)
                .put("isLowRamDevice", isLowRamDevice)
                .toString();
        } catch (Throwable ignored) {
            return "null";
        }
    }

    static String readJson(Context context) {
        if (context == null) return "null";
        try {
            ActivityManager manager = context.getSystemService(ActivityManager.class);
            if (manager == null) return "null";
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(info);
            return serialize(info.totalMem, manager.isLowRamDevice());
        } catch (Throwable ignored) {
            return "null";
        }
    }
}
