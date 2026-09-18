let readOnlyDepth = 0;

/** Runs synchronous macro substitution without allowing variable writes, including nested macros. */
export function withReadOnlyVariables(callback) {
    readOnlyDepth++;
    try {
        return callback();
    } finally {
        readOnlyDepth--;
    }
}

export function areVariablesReadOnly() {
    return readOnlyDepth > 0;
}
