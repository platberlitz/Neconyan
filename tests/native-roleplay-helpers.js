/** Exercise the explicit background path; ordinary composer sends are browser-first. */
export async function startNativeReply(page, type = 'normal') {
    await page.evaluate(async type => {
        const core = await import('/script.js');
        if (type === 'swipe') {
            const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
            void core.swipe(null, SWIPE_DIRECTION.RIGHT, { generationOptions: { skipNativeRoleplay: false } });
        } else {
            void core.Generate(type, { skipNativeRoleplay: false });
        }
    }, type);
}
