import { renderLore } from './lore.js';
import { renderWritingPartner } from './assistant.js';
import { renderPrettyHtml } from './regex.js';
import { renderPortrait } from './portrait.js';
import { renderMacroTools } from './macros.js';
import { renderGameTools } from './game.js';
import { renderInterview } from './interview.js';
import { renderCreatorPreview } from './export.js';

export async function renderCreatorTool(workspace, section, main) {
    const render = { lore: renderLore, helper: renderWritingPartner, regex: renderPrettyHtml, portrait: renderPortrait, macros: renderMacroTools, game: renderGameTools, interview: renderInterview, preview: renderCreatorPreview }[section];
    if (!render) throw new Error('This Creator section is not available.');
    await render(workspace, main);
}
