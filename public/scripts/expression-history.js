// Exact selected assets, never labels that would reroll a historical expression.
export function isExpressionSource(src) {
    if (src === null) return true;
    if (typeof src !== 'string' || !src.startsWith('/') || src.startsWith('//') || /[\\\r\n\t]/.test(src)) return false;
    try {
        const url = new URL(src, 'https://expression.invalid');
        const path = decodeURIComponent(url.pathname);
        return url.origin === 'https://expression.invalid' && !url.hash
            && !path.split('/').some(part => part === '..' || part === '.') && !path.includes('\\')
            && /^\/(characters\/.+|img\/default-expressions\/[^/]+)\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(path);
    } catch {
        return false;
    }
}

export function readMessageExpression(message, avatar) {
    if (!message || !avatar) return undefined;
    // A swipe without history must not inherit the previous swipe's top-level value.
    const extra = Array.isArray(message.swipe_info)
        ? message.swipe_info[message.swipe_id ?? 0]?.extra : message.extra;
    const saved = extra?.neconyanExpression;
    return saved && saved.avatar === avatar && isExpressionSource(saved.src) ? saved : undefined;
}

export function writeMessageExpression(message, avatar, src) {
    if (!avatar || !isExpressionSource(src)) return false;
    const saved = readMessageExpression(message, avatar);
    if (saved?.src === src && message.extra?.neconyanExpression?.avatar === avatar
        && message.extra.neconyanExpression.src === src) return false;
    message.extra ??= {};
    message.extra.neconyanExpression = { avatar, src };
    const swipe = message.swipe_info?.[message.swipe_id ?? 0];
    if (swipe) {
        swipe.extra ??= {};
        swipe.extra.neconyanExpression = { avatar, src };
    }
    return true;
}

export function renderMessageExpression(row, message, avatar) {
    const holder = row?.querySelector('.mesAvatarWrapper > .avatar');
    if (!holder) return;
    const src = document.body.classList.contains('ripplestyle') && readMessageExpression(message, avatar)?.src;
    let image = holder.querySelector('.neconyan-expression-avatar');
    if (image?.getAttribute('src') === src) return;
    image?.remove();
    holder.classList.remove('has-expression');
    if (!src) return;
    image = document.createElement('img');
    image.className = 'neconyan-expression-avatar';
    image.alt = '';
    image.decoding = 'async';
    image.onload = () => {
        if (image.parentElement === holder) holder.classList.add('has-expression');
    };
    image.onerror = () => {
        if (image.parentElement === holder) holder.classList.remove('has-expression');
    };
    image.src = src;
    holder.append(image);
}
