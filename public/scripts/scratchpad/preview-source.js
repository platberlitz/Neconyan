/** Static preview sources only: never expand macros or read chat context. */
export function previewLanguage(className = '') {
    const match = className.match(/(?:^|\s)(?:custom-)?(?:language-|lang-)(html|htm|xml|css)(?=\s|$)/i);
    return match ? match[1].toLowerCase() === 'css' ? 'css' : 'html' : '';
}

export function previewForBlock(blocks, index) {
    const selected = blocks[index];
    if (!selected?.language) return null;
    const html = selected.language === 'html' ? selected : blocks.find(block => block.language === 'html');
    return { html: html?.text || '', css: blocks.filter(block => block.language === 'css').map(block => block.text).join('\n\n') };
}

export function previewFromText(text) {
    const blocks = [...String(text).matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})(html|htm|xml|css)[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*(?=\n|$)/gi)]
        .map(match => ({ language: match[2].toLowerCase() === 'css' ? 'css' : 'html', text: match[3] }));
    if (blocks.length) return previewForBlock(blocks, 0);
    if (/<\/?[a-z][\s\S]*?>/i.test(text)) return { html: text, css: '' };
    return /[^{}]+\{\s*(?:--)?[\w-]+\s*:[\s\S]*\}/.test(text) ? { html: '', css: text } : null;
}
