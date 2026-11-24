export class UndoConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UndoConflictError';
        this.conflict = true;
    }
}

export class UndoUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UndoUnavailableError';
    }
}

export function refuseUndo(message) {
    throw new UndoUnavailableError(message);
}
