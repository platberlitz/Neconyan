package io.github.platberlitz.neconyan;

/**
 * Decides when the workspace page has really lost its local server. Reloading the page throws away
 * replies and Agents still running in it, so one missed check (a busy process list, a server thawing
 * after Android froze the app) is never enough: only several misses in a row, with nothing answering
 * on the server's port, are.
 */
final class LocalServerWatch {
    static final int MISSES_BEFORE_RECONNECT = 3;
    private int misses;

    /** Forget earlier misses, for example after the app returns to the foreground. */
    synchronized void reset() { misses = 0; }

    /** Records one check; true once the server has been missing for enough checks in a row. */
    synchronized boolean record(boolean reachable) {
        if (reachable) {
            misses = 0;
            return false;
        }
        misses++;
        if (misses < MISSES_BEFORE_RECONNECT) return false;
        misses = 0;
        return true;
    }

    synchronized int misses() { return misses; }
}
