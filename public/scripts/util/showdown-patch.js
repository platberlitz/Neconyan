const EMPTY_LINK_URL_REGEX = /^[ \t]*\([ \t]?<?\s*>?[ \t]*(?:"[^"\n]*"|'[^'\n]*')?[ \t]?\)$/m;
const REF_LINK_REGEX = /\[((?:\[[^[\]]*]|[^[\]])*)] ?(?:\n *)?\[([^[\]]*)]()()()()/g;
const ANGLE_LINK_REGEX = /\[((?:\[[^[\]]*]|[^[\]])*)]()[ \t]*\([ \t]?<([^<>\n]*)>(?:[ \t]*()(?:"([^"]*)"|'([^']*)'))?[ \t]?\)/g;
const INLINE_LINK_REGEX = /\[((?:\[[^[\]]*]|[^[\]])*)]()[ \t]*\([ \t]?<?((?:\((?:[^\s()]|\([^\s()]*\))*\)|[^\s()])+)>?(?:[ \t]*()(?:"([^"]*)"|'([^']*)'))?[ \t]?\)/g;
const SHORTCUT_LINK_REGEX = /\[([^[\]]+)]()()()()()/g;
const GH_MENTIONS_REGEX = /(^|\s)(\\)?(@([a-z\d]+(?:[a-z\d.-]+?[a-z\d]+)*))/gmi;

const INLINE_IMAGE_REGEX = /!\[((?:\[[^[\]]*]|[^[\]])*)][ \t]*()\([ \t]?<?((?:\((?:[^\s()]|\([^\s()]*\))*\)|[^\s()])+)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:"([^"]*)"|'([^']*)')?[ \t]?\)/g;
const ANGLE_IMAGE_REGEX = /!\[((?:\[[^[\]]*]|[^[\]])*)][ \t]*()\([ \t]?<([^<>\n]*)>(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:"([^"]*)"|'([^']*)')?[ \t]?\)/g;
const BASE64_IMAGE_REGEX = /!\[((?:\[[^[\]]*]|[^[\]])*)][ \t]*()\([ \t]?<?(data:[^\s/;()<>]+\/[^\s;()<>]+;base64,[A-Za-z0-9+/=\n]+)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:"([^"]*)"|'([^']*)')?[ \t]?\)/g;
const REF_IMAGE_REGEX = /!\[((?:\[[^[\]]*]|[^[\]])*)] ?(?:\n *)?\[([^[\]]*)]()()()()()/g;
const SHORTCUT_IMAGE_REGEX = /!\[([^[\]]+)]()()()()()/g;

const BASE64_DATA_URI_PREFIX_REGEX = /^data:[^\s/;()<>]+\/[^\s;()<>]+;base64,/i;
const BASE64_DATA_URI_STICKY_REGEX = /data:[^\s/;()<>]+\/[^\s;()<>]+;base64,[A-Za-z0-9+/=]+(?:\n[A-Za-z0-9+/=]+)*/iy;
const DIMENSIONS_STICKY_REGEX = / =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4})/y;
const BRACKET_SPAN_REGEX = /\[((?:\[[^[\]]*]|[^[\]])+)]/g;
const MAX_FALLBACK_SUBSTRING_SEARCHES = 32;

const TAG_ATTR_HTML_TAG_REGEX = /<\/?[a-z\d_:-]+(?:\s(?:[^<>]|<code>[^<>]*<\/code>)+)?>/gi;
const TAG_ATTR_HTML_COMMENT_REGEX = /<!(--(?:(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>/gi;
const TAG_ATTR_SPECIAL_CHARS_REGEX = /([\\`*_~=|])/g;

const HTML_SPAN_SELF_CLOSING_REGEX = /<[^<>]+?\/>/gi;
const HTML_SPAN_NO_ATTR_REGEX = /<([^\s<>]+)>[\s\S]*?<\/\1>/g;
const HTML_SPAN_WITH_ATTR_REGEX = /<([^\s<>]+)\s[^<>]+>[\s\S]*?<\/\1>/g;
const HTML_SPAN_OPEN_TAG_REGEX = /<[^<>]+?>/gi;

function isTitleOpener(ch) {
    return ch === '"' || ch === '\'' || ch === '(' || ch === '|';
}

function isTitleCloser(ch) {
    return ch === '"' || ch === '\'' || ch === ')' || ch === '|';
}

function skipSpacesAndTabs(text, index, limit) {
    while (index < limit && (text[index] === ' ' || text[index] === '\t')) {
        index++;
    }
    return index;
}

function extractLineTitle(text, lineStart, lineEnd) {
    const start = skipSpacesAndTabs(text, lineStart, lineEnd);
    let end = lineEnd;
    while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
        end--;
    }
    if (end - start >= 3 && isTitleOpener(text[start]) && isTitleCloser(text[end - 1])) {
        return text.slice(start + 1, end - 1);
    }
    return null;
}

/**
 * Patches showdown to unrestrictedly unhash HTML spans and harden link, image, and tag subParsers against ReDoS.
 * @param {import('showdown')} showdown The showdown object to patch
 */
export function addShowdownPatch(showdown) {
    if (!showdown || typeof showdown.subParser !== 'function') {
        return;
    }

    showdown.subParser('unhashHTMLSpans', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('unhashHTMLSpans.before', text, options, globals);

        for (var i = 0; i < globals.gHtmlSpans.length; ++i) {
            var repText = globals.gHtmlSpans[i],
                // limiter to prevent infinite loop (assume 10 as limit for recurse)
                limit = 0;

            while (/¨C(\d+)C/.test(repText)) {
                var num = RegExp.$1;
                repText = repText.replace('¨C' + num + 'C', globals.gHtmlSpans[num]);
                if (limit === 10000) {
                    console.error('maximum nesting of 10000 spans reached!!!');
                    break;
                }
                ++limit;
            }
            text = text.replace('¨C' + i + 'C', repText);
        }

        text = globals.converter._dispatch('unhashHTMLSpans.after', text, options, globals);
        return text;
    });

    showdown.subParser('escapeSpecialCharsWithinTagAttributes', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('escapeSpecialCharsWithinTagAttributes.before', text, options, globals);

        text = text.replace(TAG_ATTR_HTML_TAG_REGEX, function (wholeMatch) {
            return wholeMatch
                .replace(/(.)<\/?code>(?=.)/g, '$1`')
                .replace(TAG_ATTR_SPECIAL_CHARS_REGEX, showdown.helper.escapeCharactersCallback);
        });

        text = text.replace(TAG_ATTR_HTML_COMMENT_REGEX, function (wholeMatch) {
            return wholeMatch
                .replace(TAG_ATTR_SPECIAL_CHARS_REGEX, showdown.helper.escapeCharactersCallback);
        });

        text = globals.converter._dispatch('escapeSpecialCharsWithinTagAttributes.after', text, options, globals);
        return text;
    });

    showdown.subParser('hashHTMLSpans', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('hashHTMLSpans.before', text, options, globals);

        function hashHTMLSpan(html) {
            return '¨C' + (globals.gHtmlSpans.push(html) - 1) + 'C';
        }

        text = text.replace(HTML_SPAN_SELF_CLOSING_REGEX, function (wm) {
            return hashHTMLSpan(wm);
        });
        text = text.replace(HTML_SPAN_NO_ATTR_REGEX, function (wm) {
            return hashHTMLSpan(wm);
        });
        text = text.replace(HTML_SPAN_WITH_ATTR_REGEX, function (wm) {
            return hashHTMLSpan(wm);
        });
        text = text.replace(HTML_SPAN_OPEN_TAG_REGEX, function (wm) {
            return hashHTMLSpan(wm);
        });

        text = globals.converter._dispatch('hashHTMLSpans.after', text, options, globals);
        return text;
    });

    showdown.subParser('anchors', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('anchors.before', text, options, globals);

        var writeAnchorTag = function (wholeMatch, linkText, linkId, url, m5, m6, title) {
            title = title || m6 || '';
            linkId = (linkId || '').toLowerCase();

            // Special case for explicit empty url
            if (EMPTY_LINK_URL_REGEX.test(wholeMatch.slice(linkText.length + 2))) {
                url = '';
            } else if (!url) {
                if (!linkId) {
                    // lower-case and turn embedded newlines into spaces
                    linkId = linkText.toLowerCase().replace(/ ?\n/g, ' ');
                }
                url = '#' + linkId;

                if (!showdown.helper.isUndefined(globals.gUrls[linkId])) {
                    url = globals.gUrls[linkId];
                    if (!showdown.helper.isUndefined(globals.gTitles[linkId])) {
                        title = globals.gTitles[linkId];
                    }
                } else {
                    return wholeMatch;
                }
            }

            url = url.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);

            var result = '<a href="' + url + '"';

            if (title !== '' && title !== null) {
                title = title.replace(/"/g, '&quot;');
                title = title.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
                result += ' title="' + title + '"';
            }

            if (options.openLinksInNewWindow && !/^#/.test(url)) {
                result += ' rel="noopener noreferrer" target="¨E95Eblank"';
            }

            result += '>' + linkText + '</a>';

            return result;
        };

        text = text.replace(REF_LINK_REGEX, writeAnchorTag);
        text = text.replace(ANGLE_LINK_REGEX, writeAnchorTag);
        text = text.replace(INLINE_LINK_REGEX, writeAnchorTag);
        text = text.replace(SHORTCUT_LINK_REGEX, writeAnchorTag);

        if (options.ghMentions) {
            text = text.replace(GH_MENTIONS_REGEX, function (wm, st, escape, mentions, username) {
                if (escape === '\\') {
                    return st + mentions;
                }

                if (!showdown.helper.isString(options.ghMentionsLink)) {
                    throw new Error('ghMentionsLink option must be a string');
                }
                var lnk = options.ghMentionsLink.replace(/\{u}/g, username),
                    target = '';
                if (options.openLinksInNewWindow) {
                    target = ' rel="noopener noreferrer" target="¨E95Eblank"';
                }
                return st + '<a href="' + lnk + '"' + target + '>' + mentions + '</a>';
            });
        }

        text = globals.converter._dispatch('anchors.after', text, options, globals);
        return text;
    });

    showdown.subParser('images', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('images.before', text, options, globals);

        function writeImageTagBase64(wholeMatch, altText, linkId, url, width, height, m5, title) {
            url = url.replace(/\s/g, '');
            return writeImageTag(wholeMatch, altText, linkId, url, width, height, m5, title);
        }

        function writeImageTag(wholeMatch, altText, linkId, url, width, height, m5, title) {
            var gUrls = globals.gUrls,
                gTitles = globals.gTitles,
                gDims = globals.gDimensions;

            linkId = (linkId || '').toLowerCase();
            title = title || m5 || '';

            if (EMPTY_LINK_URL_REGEX.test(wholeMatch.slice(altText.length + 3))) {
                url = '';
            } else if (url === '' || url === null) {
                if (linkId === '' || linkId === null) {
                    linkId = altText.toLowerCase().replace(/ ?\n/g, ' ');
                }
                url = '#' + linkId;

                if (!showdown.helper.isUndefined(gUrls[linkId])) {
                    url = gUrls[linkId];
                    if (!showdown.helper.isUndefined(gTitles[linkId])) {
                        title = gTitles[linkId];
                    }
                    if (!showdown.helper.isUndefined(gDims[linkId])) {
                        width = gDims[linkId].width;
                        height = gDims[linkId].height;
                    }
                } else {
                    return wholeMatch;
                }
            }

            altText = altText
                .replace(/"/g, '&quot;')
                .replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
            url = url.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
            var result = '<img src="' + url + '" alt="' + altText + '"';

            if (title && showdown.helper.isString(title)) {
                title = title
                    .replace(/"/g, '&quot;')
                    .replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
                result += ' title="' + title + '"';
            }

            if (width && height) {
                width = (width === '*') ? 'auto' : width;
                height = (height === '*') ? 'auto' : height;

                result += ' width="' + width + '"';
                result += ' height="' + height + '"';
            }

            result += ' />';

            return result;
        }

        text = text.replace(REF_IMAGE_REGEX, writeImageTag);
        text = text.replace(BASE64_IMAGE_REGEX, writeImageTagBase64);
        text = text.replace(ANGLE_IMAGE_REGEX, writeImageTag);
        text = text.replace(INLINE_IMAGE_REGEX, writeImageTag);
        text = text.replace(SHORTCUT_IMAGE_REGEX, writeImageTag);

        text = globals.converter._dispatch('images.after', text, options, globals);
        return text;
    });

    showdown.subParser('stripLinkDefinitions', function (text, options, globals) {
        'use strict';
        if (!text.includes(']:')) {
            return text;
        }

        const docLen = text.length;
        let bracketCounts = null;
        let lowerText = null;
        let fallbackSearches = 0;
        const linkIdCountCache = new Map();

        function addBracketCount(key) {
            bracketCounts.set(key, (bracketCounts.get(key) || 0) + 1);
        }

        function hasAtLeastTwoOccurrences(linkId) {
            if (linkIdCountCache.has(linkId)) {
                return linkIdCountCache.get(linkId);
            }
            if (bracketCounts === null) {
                bracketCounts = new Map();
                for (const match of text.matchAll(BRACKET_SPAN_REGEX)) {
                    const raw = match[1].toLowerCase();
                    addBracketCount(raw);
                    const normalized = raw.replace(/ ?\n/g, ' ');
                    if (normalized !== raw) {
                        addBracketCount(normalized);
                    }
                }
            }
            let ok = (bracketCounts.get(linkId) || 0) >= 2;
            if (!ok && fallbackSearches < MAX_FALLBACK_SUBSTRING_SEARCHES) {
                fallbackSearches++;
                if (lowerText === null) {
                    lowerText = text.toLowerCase();
                }
                const first = lowerText.indexOf(linkId);
                ok = first !== -1 && lowerText.indexOf(linkId, first + linkId.length) !== -1;
            }
            linkIdCountCache.set(linkId, ok);
            return ok;
        }

        let out = '';
        let lastCopied = 0;
        let pos = 0;

        while (pos < docLen) {
            const lineStart = pos;
            let lineEnd = text.indexOf('\n', lineStart);
            if (lineEnd === -1) {
                lineEnd = docLen;
            }

            let cursor = lineStart;
            while (cursor < lineEnd && cursor - lineStart < 3 && text[cursor] === ' ') {
                cursor++;
            }
            if (cursor >= lineEnd || text[cursor] !== '[') {
                pos = lineEnd + 1;
                continue;
            }

            const idStart = cursor + 1;
            let idEnd = idStart;
            while (idEnd < lineEnd && text[idEnd] !== ']' && text[idEnd] !== '[') {
                idEnd++;
            }
            if (idEnd === idStart || idEnd + 1 >= lineEnd || text[idEnd] !== ']' || text[idEnd + 1] !== ':') {
                pos = lineEnd + 1;
                continue;
            }

            const rawLinkId = text.slice(idStart, idEnd);
            cursor = skipSpacesAndTabs(text, idEnd + 2, lineEnd);
            let urlLineEnd = lineEnd;
            if (cursor === lineEnd && lineEnd < docLen && text[lineEnd] === '\n') {
                cursor = lineEnd + 1;
                urlLineEnd = text.indexOf('\n', cursor);
                if (urlLineEnd === -1) {
                    urlLineEnd = docLen;
                }
                cursor = skipSpacesAndTabs(text, cursor, urlLineEnd);
            }

            if (cursor >= urlLineEnd) {
                pos = lineEnd + 1;
                continue;
            }

            const hasLeadingAngle = text[cursor] === '<';
            const urlStart = hasLeadingAngle ? cursor + 1 : cursor;
            let url = '';
            let afterUrl = urlStart;
            let isBase64 = false;
            let isMultiLineBase64 = false;

            BASE64_DATA_URI_STICKY_REGEX.lastIndex = urlStart;
            const b64Match = BASE64_DATA_URI_STICKY_REGEX.exec(text);
            if (b64Match) {
                url = b64Match[0];
                afterUrl = urlStart + url.length;
                isBase64 = true;
                isMultiLineBase64 = url.includes('\n');
                if (isMultiLineBase64) {
                    urlLineEnd = text.indexOf('\n', afterUrl);
                    if (urlLineEnd === -1) {
                        urlLineEnd = docLen;
                    }
                }
                if (afterUrl < urlLineEnd && text[afterUrl] === '>') {
                    afterUrl++;
                }
            } else {
                let uEnd = urlStart;
                while (uEnd < urlLineEnd && text[uEnd] !== '>' && text[uEnd] !== ' ' && text[uEnd] !== '\t') {
                    uEnd++;
                }
                if (uEnd === urlStart) {
                    pos = lineEnd + 1;
                    continue;
                }
                url = text.slice(urlStart, uEnd);
                afterUrl = uEnd;
                if (afterUrl < urlLineEnd && text[afterUrl] === '>') {
                    afterUrl++;
                }
            }

            let width;
            let height;
            DIMENSIONS_STICKY_REGEX.lastIndex = afterUrl;
            const dimMatch = DIMENSIONS_STICKY_REGEX.exec(text);
            if (dimMatch && afterUrl + dimMatch[0].length <= urlLineEnd) {
                width = dimMatch[1];
                height = dimMatch[2];
                afterUrl += dimMatch[0].length;
            }

            const afterUrlSpaces = skipSpacesAndTabs(text, afterUrl, urlLineEnd);
            let title = '';
            let blankLines = '';
            let defEnd = urlLineEnd;
            let matchedDef = false;

            if (afterUrlSpaces < urlLineEnd) {
                if (afterUrlSpaces > afterUrl || text[afterUrl - 1] === '>') {
                    const sameLineTitle = extractLineTitle(text, afterUrlSpaces, urlLineEnd);
                    if (sameLineTitle !== null) {
                        title = sameLineTitle;
                        defEnd = urlLineEnd;
                        matchedDef = true;
                    }
                }
            } else {
                matchedDef = true;
                defEnd = urlLineEnd;
                if (urlLineEnd < docLen && text[urlLineEnd] === '\n') {
                    const nextLineStart = urlLineEnd + 1;
                    if (nextLineStart < docLen && text[nextLineStart] === '\n') {
                        let blankEnd = nextLineStart;
                        while (blankEnd < docLen && text[blankEnd] === '\n') {
                            blankEnd++;
                        }
                        let candEnd = text.indexOf('\n', blankEnd);
                        if (candEnd === -1) {
                            candEnd = docLen;
                        }
                        const blankTitle = extractLineTitle(text, blankEnd, candEnd);
                        if (blankTitle !== null) {
                            blankLines = text.slice(nextLineStart, blankEnd);
                            title = blankTitle;
                            defEnd = candEnd;
                        }
                    } else if (nextLineStart < docLen) {
                        let candEnd = text.indexOf('\n', nextLineStart);
                        if (candEnd === -1) {
                            candEnd = docLen;
                        }
                        const nextLineTitle = extractLineTitle(text, nextLineStart, candEnd);
                        if (nextLineTitle !== null) {
                            title = nextLineTitle;
                            defEnd = candEnd;
                        }
                    }
                }
            }

            if (!matchedDef) {
                pos = lineEnd + 1;
                continue;
            }

            let consumeEnd = defEnd;
            if (isBase64) {
                if (text.slice(defEnd, defEnd + 2) === '\n\n') {
                    consumeEnd = defEnd + 2;
                } else if (defEnd === docLen || text.slice(defEnd, defEnd + 2) === '\n[') {
                    consumeEnd = defEnd;
                } else if (!isMultiLineBase64) {
                    while (consumeEnd < docLen && text[consumeEnd] === '\n') {
                        consumeEnd++;
                    }
                } else {
                    pos = lineEnd + 1;
                    continue;
                }
            } else {
                while (consumeEnd < docLen && text[consumeEnd] === '\n') {
                    consumeEnd++;
                }
            }

            const linkId = rawLinkId.toLowerCase();
            if (!hasAtLeastTwoOccurrences(linkId)) {
                pos = lineEnd + 1;
                continue;
            }

            if (isBase64 || BASE64_DATA_URI_PREFIX_REGEX.test(url)) {
                globals.gUrls[linkId] = url.replace(/\s/g, '');
            } else {
                globals.gUrls[linkId] = showdown.subParser('encodeAmpsAndAngles')(url, options, globals);
            }

            let replacement = '';
            if (blankLines) {
                replacement = blankLines + title;
            } else {
                if (title) {
                    globals.gTitles[linkId] = title.replace(/"|'/g, '&quot;');
                }
                if (options.parseImgDimensions && width && height) {
                    globals.gDimensions[linkId] = {
                        width: width,
                        height: height,
                    };
                }
            }

            out += text.slice(lastCopied, lineStart) + replacement;
            lastCopied = consumeEnd;
            pos = consumeEnd > lineStart ? consumeEnd : lineEnd + 1;
        }

        if (lastCopied === 0) {
            return text;
        }
        return out + text.slice(lastCopied);
    });
}
