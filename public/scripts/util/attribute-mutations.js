/**
 * Browsers report an attribute mutation even when code writes the value that is
 * already there, for example `classList.add()` with a class the element has.
 * Observers that do layout work use this to skip those no-op records.
 * Needs records observed with `attributeOldValue: true`.
 * @param {Iterable<MutationRecord>} records
 * @returns {boolean}
 */
export function hasChangedAttributeValue(records) {
    for (const record of records) {
        if (record.type !== 'attributes' || !record.attributeName) {
            return true;
        }
        if (record.oldValue !== record.target.getAttribute(record.attributeName)) {
            return true;
        }
    }
    return false;
}
