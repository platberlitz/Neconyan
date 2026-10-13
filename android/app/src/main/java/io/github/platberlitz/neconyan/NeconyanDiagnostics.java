package io.github.platberlitz.neconyan;

import android.webkit.JavascriptInterface;

final class NeconyanDiagnostics {
    private String nonce = "", document = "";
    private boolean local;
    private long receivedAt;
    synchronized void invalidate() { local = false; nonce = ""; document = ""; }
    synchronized void allow(String token, String session) { nonce = token; document = session; local = true; receivedAt = 0; }
    @JavascriptInterface public synchronized void recordActivity(String token, String json) {
        long now = System.currentTimeMillis();
        if (!local || nonce.isEmpty() || !nonce.equals(token) || json == null || json.length() > 4096 || now - receivedAt < 5000) return;
        receivedAt = now;
        ActivityBreadcrumbs.accept(json, document);
    }
}
