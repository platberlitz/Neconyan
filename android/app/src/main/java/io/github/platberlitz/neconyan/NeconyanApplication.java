package io.github.platberlitz.neconyan;

import android.app.Application;

public final class NeconyanApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        ActivityBreadcrumbs.initialise(this);
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            // A diagnostics failure must not stop the original handler from terminating the app.
            try { CrashDiagnostics.record(this, "uncaught-java-exception", error, "Thread: " + thread.getName() + " (" + thread.getId() + ")"); }
            catch (Throwable ignored) { }
            finally {
                if (previous != null) previous.uncaughtException(thread, error);
                else { android.os.Process.killProcess(android.os.Process.myPid()); System.exit(1); }
            }
        });
    }
    @Override public void onTrimMemory(int level) { super.onTrimMemory(level); try { ActivityBreadcrumbs.pressure(level); } catch (Throwable ignored) { } }
    @Override public void onLowMemory() { super.onLowMemory(); try { ActivityBreadcrumbs.pressure(-1); } catch (Throwable ignored) { } }
}
