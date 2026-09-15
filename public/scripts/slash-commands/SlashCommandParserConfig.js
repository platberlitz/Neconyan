let slashCommandParserSettingsGetter = null;

export function setSlashCommandParserSettingsGetter(getter) {
    slashCommandParserSettingsGetter = typeof getter === 'function' ? getter : null;
}

export function getSlashCommandParserSettings() {
    const settings = slashCommandParserSettingsGetter?.();

    return {
        experimentalMacroEngine: Boolean(settings?.experimentalMacroEngine),
        flags: settings?.flags ?? {},
    };
}
