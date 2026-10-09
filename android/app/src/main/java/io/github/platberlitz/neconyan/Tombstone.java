package io.github.platberlitz.neconyan;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

// Reads the parts of an Android crash record (debuggerd's tombstone protobuf) that explain a
// native crash: the signal, the crashing thread's backtrace and the last log lines. The field
// numbers come from AOSP's debuggerd/proto/tombstone.proto. Anything unknown is skipped and
// damaged input produces a note instead of an exception, because this runs on the recovery screen.
final class Tombstone {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_FRAMES = 64;
    static final int MAX_LOG_LINES = 30;

    private Tombstone() { }

    static String describe(InputStream input) {
        byte[] data;
        try {
            data = readAll(input);
        } catch (IOException error) {
            return "Crash record could not be read: " + error.getMessage() + "\n";
        }
        return describe(data);
    }

    static String describe(byte[] data) {
        StringBuilder out = new StringBuilder();
        try {
            describeTombstone(new Reader(data, 0, data.length), out);
        } catch (RuntimeException error) {
            out.append("Crash record ended early or was damaged; the lines above are what could be read.\n");
        }
        if (out.length() == 0) out.append("Crash record held no recognised details.\n");
        return out.toString();
    }

    private static void describeTombstone(Reader reader, StringBuilder out) {
        int crashingThread = 0;
        String signal = null;
        String abort = null;
        List<String> causes = new ArrayList<>();
        String uptime = null;
        List<Reader> threads = new ArrayList<>();
        List<String> logs = new ArrayList<>();
        while (reader.next()) {
            switch (reader.field) {
                case 6: crashingThread = (int) reader.number(); break;
                case 10: signal = describeSignal(reader.message()); break;
                case 14: abort = reader.string(); break;
                case 15: {
                    Reader cause = reader.message();
                    while (cause.next()) {
                        if (cause.field == 1) causes.add(cause.string()); else cause.skip();
                    }
                    break;
                }
                case 16: threads.add(reader.message()); break;
                case 18: readLogBuffer(reader.message(), logs); break;
                case 20: uptime = reader.string(); break;
                default: reader.skip();
            }
        }
        if (signal != null) out.append(signal).append('\n');
        if (abort != null && !abort.isEmpty()) out.append("Abort message: ").append(abort).append('\n');
        for (String cause : causes) out.append("Cause: ").append(cause).append('\n');
        if (uptime != null && !uptime.isEmpty()) out.append("Process uptime: ").append(uptime).append('\n');
        for (Reader entry : threads) {
            if (describeThread(entry, crashingThread, out)) break;
        }
        if (!logs.isEmpty()) {
            out.append("Last log lines:\n");
            int from = Math.max(0, logs.size() - MAX_LOG_LINES);
            for (int index = from; index < logs.size(); index++) out.append("  ").append(logs.get(index)).append('\n');
        }
    }

    private static String describeSignal(Reader reader) {
        long number = 0;
        String name = "";
        long code = 0;
        String codeName = "";
        boolean hasFault = false;
        long fault = 0;
        while (reader.next()) {
            switch (reader.field) {
                case 1: number = reader.number(); break;
                case 2: name = reader.string(); break;
                case 3: code = reader.number(); break;
                case 4: codeName = reader.string(); break;
                case 8: hasFault = reader.number() != 0; break;
                case 9: fault = reader.number(); break;
                default: reader.skip();
            }
        }
        StringBuilder line = new StringBuilder("Signal ").append(number);
        if (!name.isEmpty()) line.append(" (").append(name).append(')');
        line.append(", code ").append(code);
        if (!codeName.isEmpty()) line.append(" (").append(codeName).append(')');
        if (hasFault) line.append(", fault address 0x").append(Long.toHexString(fault));
        return line.toString();
    }

    // A map entry is a message with key = 1 and value = 2.
    private static boolean describeThread(Reader entry, int crashingThread, StringBuilder out) {
        Reader thread = null;
        while (entry.next()) {
            if (entry.field == 2) thread = entry.message(); else entry.skip();
        }
        if (thread == null) return false;
        int id = 0;
        String name = "";
        List<String> frames = new ArrayList<>();
        while (thread.next()) {
            switch (thread.field) {
                case 1: id = (int) thread.number(); break;
                case 2: name = thread.string(); break;
                case 4: {
                    if (frames.size() < MAX_FRAMES) frames.add(describeFrame(thread.message(), frames.size()));
                    else thread.skip();
                    break;
                }
                default: thread.skip();
            }
        }
        if (id != crashingThread) return false;
        out.append("Crashing thread: ").append(id);
        if (!name.isEmpty()) out.append(" (").append(name).append(')');
        out.append('\n');
        for (String frame : frames) out.append(frame).append('\n');
        return true;
    }

    private static String describeFrame(Reader reader, int index) {
        long relativePc = 0;
        String function = "";
        long offset = 0;
        String file = "";
        String buildId = "";
        while (reader.next()) {
            switch (reader.field) {
                case 1: relativePc = reader.number(); break;
                case 4: function = reader.string(); break;
                case 5: offset = reader.number(); break;
                case 6: file = reader.string(); break;
                case 8: buildId = reader.string(); break;
                default: reader.skip();
            }
        }
        StringBuilder line = new StringBuilder();
        line.append('#').append(index < 10 ? "0" : "").append(index);
        line.append(" pc ").append(String.format("%016x", relativePc));
        line.append(' ').append(file.isEmpty() ? "<unknown>" : file);
        if (!function.isEmpty()) line.append(" (").append(function).append('+').append(offset).append(')');
        if (!buildId.isEmpty()) line.append(" (BuildId: ").append(buildId).append(')');
        return line.toString();
    }

    private static void readLogBuffer(Reader reader, List<String> logs) {
        while (reader.next()) {
            if (reader.field != 2) { reader.skip(); continue; }
            Reader message = reader.message();
            String tag = "";
            String text = "";
            String timestamp = "";
            while (message.next()) {
                switch (message.field) {
                    case 1: timestamp = message.string(); break;
                    case 5: tag = message.string(); break;
                    case 6: text = message.string(); break;
                    default: message.skip();
                }
            }
            logs.add((timestamp.isEmpty() ? "" : timestamp + " ") + (tag.isEmpty() ? "" : tag + ": ") + text.trim());
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int total = 0;
        int count;
        while (total < MAX_BYTES && (count = input.read(chunk)) > 0) {
            int keep = Math.min(count, MAX_BYTES - total);
            buffer.write(chunk, 0, keep);
            total += keep;
        }
        return buffer.toByteArray();
    }

    // Minimal protobuf wire reader: varint (0), fixed64 (1), length-delimited (2), fixed32 (5).
    private static final class Reader {
        private final byte[] data;
        private int position;
        private final int limit;
        int field;
        int type;

        Reader(byte[] data, int position, int limit) {
            this.data = data;
            this.position = position;
            this.limit = limit;
        }

        boolean next() {
            if (position >= limit) return false;
            long key = varint();
            field = (int) (key >>> 3);
            type = (int) (key & 7);
            if (field == 0) throw new IllegalStateException("field 0");
            return true;
        }

        long varint() {
            long value = 0;
            int shift = 0;
            while (true) {
                if (position >= limit) throw new IllegalStateException("truncated varint");
                int current = data[position++] & 0xff;
                value |= (long) (current & 0x7f) << shift;
                if ((current & 0x80) == 0) return value;
                shift += 7;
                if (shift > 63) throw new IllegalStateException("varint too long");
            }
        }

        private int length() {
            long length = varint();
            if (length < 0 || length > limit - position) throw new IllegalStateException("length past end");
            return (int) length;
        }

        long number() {
            if (type == 0) return varint();
            if (type == 1) { advance(8); return 0; }
            if (type == 5) { advance(4); return 0; }
            skip();
            return 0;
        }

        Reader message() {
            if (type != 2) { skip(); return new Reader(data, position, position); }
            int length = length();
            Reader inner = new Reader(data, position, position + length);
            position += length;
            return inner;
        }

        String string() {
            if (type != 2) { skip(); return ""; }
            int length = length();
            String value = new String(data, position, length, StandardCharsets.UTF_8);
            position += length;
            return value;
        }

        void skip() {
            switch (type) {
                case 0: varint(); break;
                case 1: advance(8); break;
                case 2: advance(length()); break;
                case 5: advance(4); break;
                default: throw new IllegalStateException("unsupported wire type " + type);
            }
        }

        private void advance(int count) {
            if (count > limit - position) throw new IllegalStateException("fixed field past end");
            position += count;
        }
    }
}
