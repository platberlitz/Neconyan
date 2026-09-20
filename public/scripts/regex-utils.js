/** Parse a literal or plain pattern, including multiline input.
 * @copyright Originally from https://github.com/IonicaBizau/regex-parser.js/blob/master/lib/index.js
 */
export function regexFromString(input) {
    try {
        const match = input.match(/^(\/?)([\s\S]+)\1([a-z]*)$/i);
        try {
            return new RegExp(match[2], match[3]);
        } catch {
            return RegExp(input);
        }
    } catch {
        return;
    }
}
