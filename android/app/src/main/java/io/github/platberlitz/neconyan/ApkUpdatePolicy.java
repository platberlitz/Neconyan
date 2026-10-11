package io.github.platberlitz.neconyan;

import java.net.URI;

/** Official release locations and the same version ordering used by Gradle. */
final class ApkUpdatePolicy {
    static long versionCode(String version) {
        if (version == null || !version.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\.(0|[1-9][0-9]*))?"))
            throw new IllegalArgumentException("Invalid APK release version.");
        String[] parts = version.split("\\.");
        long[] numbers = new long[4];
        for (int i = 0; i < parts.length; i++) {
            numbers[i] = Long.parseLong(parts[i]);
            if (numbers[i] > (i == 0 ? 2147 : 99)) throw new IllegalArgumentException("Unsupported APK release version.");
        }
        long code = numbers[0] * 1000000 + numbers[1] * 10000 + numbers[2] * 100 + numbers[3];
        if (code <= 0 || code > Integer.MAX_VALUE) throw new IllegalArgumentException("Unsupported APK release version.");
        return code;
    }

    static String downloadUrl(String version, String architecture) {
        versionCode(version);
        if (!architecture.equals("arm64") && !architecture.equals("x86_64")) throw new IllegalArgumentException("No APK is available for this device.");
        return "https://github.com/platberlitz/Neconyan/releases/download/v" + version + "/Neconyan-" + version + "-android-" + architecture + ".apk";
    }

    static boolean allowedDownload(URI uri, String original) {
        if (!"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        return uri.toString().equals(original) || "release-assets.githubusercontent.com".equals(uri.getHost())
            || "objects.githubusercontent.com".equals(uri.getHost());
    }
}
