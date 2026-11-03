import { buildTextDiffMarkup } from '../text-diff.js';
import { element } from './fields.js';

/** Use the same escaped, coloured comparison as post-generation agent history. */
export function creatorProposalDiff(before, after) {
    const details = element('details', 'creator-proposal-diff');
    details.open = true;
    details.append(element('summary', '', 'Changes'));
    const legend = element('p', 'creator-muted');
    legend.append(element('span', 'ica-transform-diff-part--ins', 'Added'), ' · ', element('span', 'ica-transform-diff-part--del', 'Removed'));
    const output = element('div', 'ica-transform-diff');
    const update = value => {
        // Both inputs are escaped before the shared renderer adds its spans.
        output.innerHTML = buildTextDiffMarkup(before, value);
    };
    update(after);
    details.append(legend, output);
    return { element: details, update };
}
