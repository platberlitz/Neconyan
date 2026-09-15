/** Source-local cursor parsing. Public cursors are signed in refs.js. */

import { own } from './validate.js';

export const MAX_OFFSET = 5000;
export const MAX_PAGE = 1000;
export const MAX_INDEXED_PAGE = 1000;

export class BadCursorError extends Error {
    constructor() {
        super('bad_cursor');
        this.name = 'BadCursorError';
        this.code = 'bad_cursor';
    }
}

function exactKeys(cursor, allowed) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return false;
    }
    const keys = Object.keys(cursor);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function safeInteger(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function offsetCursor(cursor) {
    if (cursor === null || cursor === undefined) {
        return 0;
    }
    const offset = own(cursor, 'o');
    if (!exactKeys(cursor, ['o']) || !safeInteger(offset, 0, MAX_OFFSET)) {
        throw new BadCursorError();
    }
    return offset;
}

export function pageCursor(cursor, { first = 1, max = MAX_PAGE } = {}) {
    if (cursor === null || cursor === undefined) {
        return first;
    }
    const page = own(cursor, 'p');
    if (!exactKeys(cursor, ['p']) || !safeInteger(page, first, max)) {
        throw new BadCursorError();
    }
    return page;
}

export function indexedPageCursor(cursor) {
    if (cursor === null || cursor === undefined) {
        return { page: 1, index: 0 };
    }
    const page = own(cursor, 'p');
    const index = own(cursor, 'i');
    if (!exactKeys(cursor, ['p', 'i'])
        || !safeInteger(page, 1, MAX_INDEXED_PAGE)
        || !safeInteger(index, 0, 256)) {
        throw new BadCursorError();
    }
    return { page, index };
}
