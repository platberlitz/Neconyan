package io.github.platberlitz.neconyan;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/** A caller capability delivered only to the main document, revoked on navigation. */
final class BridgeCallerGate {
    private final SecureRandom random = new SecureRandom();
    private volatile byte[] expected;

    String issue() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        StringBuilder token = new StringBuilder(64);
        for (byte value : bytes) {
            token.append(Character.forDigit((value >>> 4) & 15, 16));
            token.append(Character.forDigit(value & 15, 16));
        }
        String result = token.toString();
        expected = result.getBytes(StandardCharsets.UTF_8);
        return result;
    }

    void clear() { expected = null; }

    boolean accepts(String token) {
        byte[] current = expected;
        return current != null && token != null && token.length() == 64
            && MessageDigest.isEqual(current, token.getBytes(StandardCharsets.UTF_8));
    }
}
