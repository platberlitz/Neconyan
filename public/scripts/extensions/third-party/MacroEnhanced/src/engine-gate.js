/**
 * The extension requires the experimental macro engine. When the engine is off (or the
 * context predates it), nothing is registered and the settings drawer explains why.
 */
export function isEngineAvailable() {
    let ctx;
    try {
        ctx = SillyTavern.getContext();
    } catch {
        return false;
    }

    const flagOn = !!ctx.powerUserSettings?.experimental_macro_engine;
    const surfacePresent = !!(ctx.macros?.registry && ctx.macros?.engine && typeof ctx.macros?.register === 'function');
    return flagOn && surfacePresent;
}
