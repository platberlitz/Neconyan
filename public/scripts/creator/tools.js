import { renderLore } from './lore.js';
import { renderWritingPartner } from './assistant.js';
import { renderPrettyHtml } from './regex.js';
import { renderPortrait } from './portrait.js';
import { renderMacroTools } from './macros.js';
import { renderGameTools } from './game.js';
import { renderInterview } from './interview.js';
import { renderCreatorPreview } from './export.js';
import { renderCreatorPrompts } from './prompt-editor.js';
import { renderCreatorNotebooks } from './notebooks.js';

export async function renderCreatorTool(workspace, section, main) {
    const render = { lore: renderLore, helper: renderWritingPartner, regex: renderPrettyHtml, portrait: renderPortrait, macros: renderMacroTools, game: renderGameTools, interview: renderInterview, preview: renderCreatorPreview, instructions: renderCreatorPrompts, notebooks: renderCreatorNotebooks }[section];
    if (!render) throw new Error('This Catelier section is not available.');
    await render(workspace, main);
}
