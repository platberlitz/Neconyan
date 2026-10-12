package io.github.platberlitz.neconyan;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;

/** Only the verified update APK is shared, read-only, with Android's installer. */
public final class UpdateApkProvider extends ContentProvider {
    static File apkFile(Context context) { return new File(context.getNoBackupFilesDir(), "apk-update/update.apk"); }
    static Uri apkUri(Context context) { return Uri.parse("content://" + context.getPackageName() + ".apk-update/update.apk"); }

    private void check(Uri uri) {
        if (!apkUri(getContext()).equals(uri)) throw new SecurityException("Unknown update file.");
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { check(uri); return "application/vnd.android.package-archive"; }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        check(uri);
        if (!"r".equals(mode)) throw new SecurityException("The update APK is read-only.");
        return ParcelFileDescriptor.open(apkFile(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        check(uri);
        String[] columns = projection == null ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) row.add(OpenableColumns.DISPLAY_NAME.equals(column) ? "Neconyan-update.apk"
            : OpenableColumns.SIZE.equals(column) ? apkFile(getContext()).length() : null);
        return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new SecurityException("Read-only."); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new SecurityException("Read-only."); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new SecurityException("Read-only."); }
}
