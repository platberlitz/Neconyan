import { getContext, writeExtensionField } from '../../extensions.js';
import { Popup } from '../../popup.js';
import { t } from '../../i18n.js';
import { EXPRESSION_SETS_KEY, readExpressionSets } from './expression-sets.js';

/** Bind once. Resolve the owning card again for each action, then freeze it across saves. */
export function bindExpressionSets({ getCharacter, refresh }) {
    let saving = false;
    const save = async (character, next) => {
        if (saving) return false;
        saving = true;
        $('#expression_member_controls :input').prop('disabled', true);
        try {
            const index = getContext().characters.findIndex(item => item.avatar === character.avatar);
            if (index < 0) throw new Error('The character card is no longer available.');
            await writeExtensionField(index, EXPRESSION_SETS_KEY, next, { throwOnError: true });
            if (getCharacter()?.avatar === character.avatar) await refresh();
            return true;
        } catch (error) {
            console.error('[Expressions] Could not save character sets:', error);
            toastr.error(t`Could not save the expression sets. Try again.`);
            return false;
        } finally {
            saving = false;
            $('#expression_member_controls :input').prop('disabled', false);
            renderExpressionSets(getCharacter(), $('#image_list').data('name'));
        }
    };
    $('#expression_member').on('change', async function () {
        const character = getCharacter();
        if (!character) return;
        await save(character, { ...readExpressionSets(character), active: String($(this).val()), auto: false });
    });
    $('#expression_member_auto').on('change', async function () {
        const character = getCharacter();
        if (character) await save(character, { ...readExpressionSets(character), auto: this.checked });
    });
    $('#expression_member_add').on('click', async () => {
        const character = getCharacter();
        if (!character || saving) return;
        const value = await Popup.show.input(t`Add a character`, t`Name one character in this card. Each character gets a separate expression set.`, '');
        const name = String(value || '').trim();
        if (!name) return;
        const sets = readExpressionSets(character);
        if (name.length > 80 || sets.members.some(member => member.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(t`Use a unique character name, up to 80 characters.`);
            return;
        }
        const id = crypto.randomUUID();
        // Keep filenames independent of names typed in the UI and of card renames.
        const member = { id, name, description: '', folder: `expression-sets/${id}` };
        await save(character, { ...sets, active: id, auto: false, members: [...sets.members, member] });
    });
    $('#expression_member_save').on('click', async () => {
        const character = getCharacter();
        if (!character) return;
        const sets = readExpressionSets(character);
        const id = String($('#expression_member').val());
        const description = String($('#expression_member_description').val()).trim().slice(0, 2400);
        await save(character, { ...sets, members: sets.members.map(member => member.id === id ? { ...member, description } : member) });
    });
    $('#expression_member_remove').on('click', async () => {
        const character = getCharacter();
        if (!character || saving) return;
        const id = String($('#expression_member').val());
        if (!id) return;
        if (!await Popup.show.confirm(t`Remove character set?`, t`The images stay in their folder. This removes the character from this card's expression choices.`)) return;
        const sets = readExpressionSets(character);
        await save(character, { ...sets, active: sets.active === id ? '' : sets.active, members: sets.members.filter(member => member.id !== id) });
    });
}

export function renderExpressionSets(character, folder) {
    const sets = readExpressionSets(character);
    const member = sets.members.find(item => item.folder === folder);
    const select = $('#expression_member').empty();
    select.append(new Option(t`Whole card`, ''));
    for (const item of sets.members) select.append(new Option(item.name, item.id));
    select.val(member?.id || '');
    $('#expression_member_auto').prop('checked', sets.auto);
    $('#expression_member_description').val(member?.description || '');
    $('#expression_member_details').prop('hidden', !member);
    $('#expression_member_follow').prop('hidden', !sets.members.length);
    $('#expression_member_controls').prop('hidden', !character);
    $('.expression_override_controls, .expression_override_label').toggle(!member);
}
