// Provider streams repeat metadata around small text deltas. Their transfer size
// needs more room than the answer and thinking that will actually be saved.
export const MAX_GENERATION_STREAM_BYTES = 64 * 1024 * 1024;
export const MAX_GENERATION_TEXT_BYTES = 2 * 1024 * 1024;
