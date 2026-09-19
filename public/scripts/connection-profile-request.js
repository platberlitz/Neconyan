import { isTrueBoolean } from './macro-primitives.js';

const fields = {
    'request-reasoning': ['include_reasoning', value => isTrueBoolean(String(value))],
    'reasoning-effort': ['reasoning_effort', value => String(value ?? '')],
    'verbosity': ['verbosity', value => String(value ?? '')],
    'enable-web-search': ['enable_web_search', value => isTrueBoolean(String(value))],
    'request-images': ['request_images', value => isTrueBoolean(String(value))],
    'request-image-resolution': ['request_image_resolution', value => String(value ?? '')],
    'request-image-aspect-ratio': ['request_image_aspect_ratio', value => String(value ?? '')],
    'custom-reasoning-param-format': ['custom_reasoning_param_format', value => String(value ?? '')],
    'custom-reasoning-param-name': ['custom_reasoning_param_name', value => String(value ?? '')],
    'custom-reasoning-enabled-value': ['custom_reasoning_enabled_value', value => String(value ?? '')],
    'custom-reasoning-disabled-value': ['custom_reasoning_disabled_value', value => String(value ?? '')],
    'custom-include-body': ['custom_include_body', value => String(value ?? '')],
    'custom-exclude-body': ['custom_exclude_body', value => String(value ?? '')],
    'custom-include-headers': ['custom_include_headers', value => String(value ?? '')],
};

export function resolveProfileRequestOverrides(profile, overridePayload, preset) {
    const overrides = {};
    const profileFieldNames = [];
    for (const [profileKey, [requestKey, coerce]] of Object.entries(fields)) {
        if (Object.hasOwn(profile, profileKey) && !Object.hasOwn(overridePayload, requestKey)) {
            overrides[requestKey] = coerce(profile[profileKey]);
            profileFieldNames.push(requestKey);
        }
    }
    for (const profileKey of ['reasoning-effort', 'verbosity']) {
        const [requestKey, coerce] = fields[profileKey];
        const value = preset?.[requestKey];
        if (!Object.hasOwn(profile, profileKey) && !Object.hasOwn(overridePayload, requestKey) && value !== undefined && value !== null && value !== '') {
            overrides[requestKey] = coerce(value);
            profileFieldNames.push(requestKey);
        }
    }
    return { overrides, profileFieldNames };
}

export function resolveProfileProxy(profile, source, proxies, activeSettings) {
    const selected = proxies.find(proxy => proxy.name === profile?.proxy);
    if (selected?.url) return { reverse_proxy: selected.url, proxy_password: selected.password };
    if (profile?.proxy) return { reverse_proxy: '', proxy_password: '' };
    const fallback = proxies.find(proxy => proxy.name !== 'None' && proxy.source === source && proxy.url);
    const proxy = fallback || { url: activeSettings.reverse_proxy, password: activeSettings.proxy_password };
    return proxy.url ? { reverse_proxy: proxy.url, proxy_password: proxy.password } : {};
}

export function resolveProfileServiceTier(profile, source, preset) {
    if (!['nanogpt', 'openrouter'].includes(source) || profile.exclude?.includes('service-tier')) return undefined;
    const tier = profile['service-tier'] ?? preset?.[`${source}_service_tier`];
    return tier === 'default' ? '' : (tier ?? '');
}
