import { main_api } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { getFriendlyTokenizerName, getTextTokensAsync, getTokenCountAsync, tokenizers } from '../../tokenizers.js';
import { resetScrollHeight, debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import { t } from '../../i18n.js';

async function doTokenCounter() {
    const { tokenizerName, tokenizerId } = getFriendlyTokenizerName(main_api);
    const html = await renderExtensionTemplateAsync('token-counter', 'window', { tokenizerName });

    const dialog = $(html);
    let requestNonce = 0;
    const runTokenCounter = async () => {
        const currentNonce = ++requestNonce;
        const text = String($('#token_counter_textarea').val());
        if (!text) {
            $('#token_counter_ids').text('—');
            $('#token_counter_result').text(0);
            $('#tokenized_chunks_display').text('—');
            return;
        }
        const ids = await (main_api == 'openai' ? getTextTokensAsync(tokenizers.OPENAI, text) : getTextTokensAsync(tokenizerId, text));
        if (currentNonce !== requestNonce) {
            return;
        }

        if (Array.isArray(ids) && ids.length > 0) {
            $('#token_counter_ids').text(`[${ids.join(', ')}]`);
            $('#token_counter_result').text(ids.length);

            if (Object.hasOwnProperty.call(ids, 'chunks')) {
                drawChunks(Object.getOwnPropertyDescriptor(ids, 'chunks').value, ids);
            }
        } else {
            const count = await getTokenCountAsync(text);
            if (currentNonce !== requestNonce) {
                return;
            }
            $('#token_counter_ids').text('—');
            $('#token_counter_result').text(count);
            $('#tokenized_chunks_display').text('—');
        }

        if (!CSS.supports('field-sizing', 'content')) {
            await resetScrollHeight($('#token_counter_textarea'));
            await resetScrollHeight($('#token_counter_ids'));
        }
    };
    const countDebounced = debounce(runTokenCounter, debounce_timeout.quick);
    dialog.find('#token_counter_textarea').on('input', () => countDebounced());
    dialog.find('#token_counter_textarea').on('paste', () => setTimeout(runTokenCounter, 0));

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

/**
 * Draws the tokenized chunks in the UI
 * @param {string[]} chunks
 * @param {number[]} ids
 */
function drawChunks(chunks, ids) {
    const pastelRainbow = [
        //main_text_color,
        //italics_text_color,
        //quote_text_color,
        '#FFB3BA',
        '#FFDFBA',
        '#FFFFBA',
        '#BFFFBF',
        '#BAE1FF',
        '#FFBAF3',
    ];
    const display = document.getElementById('tokenized_chunks_display');
    if (!display) {
        return;
    }
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i].replace(/[▁Ġ]/g, ' '); // This is a leading space in sentencepiece. More info: Lower one eighth block (U+2581)

        // If <0xHEX>, decode it
        if (/^<0x[0-9A-F]+>$/i.test(chunk)) {
            const code = parseInt(chunk.substring(3, chunk.length - 1), 16);
            chunk = String.fromCodePoint(code);
        }

        // If newline - insert a line break
        if (chunk === '\n') {
            fragment.appendChild(document.createElement('br'));
            continue;
        }

        const color = pastelRainbow[i % pastelRainbow.length];
        const chunkElement = document.createElement('code');
        chunkElement.style.backgroundColor = color;
        chunkElement.textContent = chunk;
        chunkElement.title = String(ids[i]);
        fragment.appendChild(chunkElement);
    }

    display.replaceChildren(fragment);
}

async function doCount() {
    // get all of the messages in the chat
    const context = getContext();
    const messages = context.chat.filter(x => x.mes && !x.is_system).map(x => x.mes);

    //concat all the messages into a single string
    const allMessages = messages.join(' ');

    console.debug('All messages:', allMessages);

    //toastr success with the token count of the chat
    const count = await getTokenCountAsync(allMessages);
    toastr.success(`Token count: ${count}`);
    return count;
}

export function init() {
    const buttonHtml = `
        <div id="token_counter" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-1 extensionsMenuExtensionButton" /></div>` +
            t`Token Counter` +
        '</div>';
    $('#token_counter_wand_container').append(buttonHtml);
    $('#token_counter').on('click', doTokenCounter);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'count',
        callback: async () => String(await doCount()),
        returns: 'number of tokens',
        helpString: 'Counts the number of tokens in the current chat.',
    }));
}
