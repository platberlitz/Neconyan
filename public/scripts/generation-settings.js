/** The saved controls an explicit active-connection request may depend on. */
export function generationSettingsSnapshot(settings) {
    const endpoint = value => value?.secretId ? { ...value, key: '' } : value;
    return JSON.parse(JSON.stringify({
        main_api: settings.main_api,
        active_generation: settings.active_generation,
        max_context: settings.max_context,
        oai_settings: settings.oai_settings,
        textgenerationwebui_settings: settings.textgenerationwebui_settings,
        kai_settings: settings.main_api === 'kobold' || settings.main_api === 'koboldhorde' ? settings.kai_settings : undefined,
        nai_settings: settings.main_api === 'novel' ? settings.nai_settings : undefined,
        horde_settings: settings.main_api === 'koboldhorde' ? settings.horde_settings : undefined,
        power_user: settings.power_user,
        proxies: settings.proxies,
        selected_proxy: settings.selected_proxy,
        custom_endpoint_presets: settings.custom_endpoint_presets?.map(endpoint),
        selected_custom_endpoint_preset: endpoint(settings.selected_custom_endpoint_preset),
        regex: settings.extension_settings?.regex,
        regexDisabled: settings.extension_settings?.disabledExtensions?.includes('regex') || false,
        characterAllowedRegex: settings.extension_settings?.character_allowed_regex,
        presetAllowedRegex: settings.extension_settings?.preset_allowed_regex,
    }));
}
