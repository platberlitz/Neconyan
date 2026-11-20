/** Saved off-the-record mode also applies to replies written without a browser. */
export function offRecordReplyExtra(records) {
    return records[0]?.chat_metadata?.mewmory_off_record === true ? { mewmoryExclude: true } : {};
}
