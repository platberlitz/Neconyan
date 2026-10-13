package io.github.platberlitz.neconyan;

import android.app.Application;

public final class NeconyanApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        ActivityBreadcrumbs.initialise(this);
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try { CrashDiagnostics.record(this, "uncaught-java-exception", error, "Thread: " + thread.getName() + " (" + thread.getId() + ")"); }
            finally {
                if (previous != null) previous.uncaughtException(thread, error);
                else { android.os.Process.killProcess(android.os.Process.myPid()); System.exit(1); }
            }
        });
    }
    @Override public void onTrimMemory(int level) { super.onTrimMemory(level); ActivityBreadcrumbs.pressure(level); }
    @Override public void onLowMemory() { super.onLowMemory(); ActivityBreadcrumbs.pressure(-1); }
}
