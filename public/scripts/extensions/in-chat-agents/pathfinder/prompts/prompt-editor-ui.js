// Keep the public entry point, using the same durable editor as the Extensions panel.
let mountedContainer = null;
let mountedPanel = null;
let mountRevision = 0;

export async function initPromptEditorUI(container) {
    const ui = await import('../../pathfinder-settings-ui.js');
    if (mountedContainer === container && mountedPanel?.[0]?.parentNode === container) {
        ui.refreshPathfinderSettings();
        return mountedPanel;
    }
    if (mountedPanel && !await ui.canClosePathfinderSettings(mountedPanel)) return null;
    const revision = ++mountRevision;
    const [{ getPathfinderRuntimeAgent }, { getAgents }] = await Promise.all([
        import('../../agent-runner.js'), import('../../agent-store.js'),
    ]);
    const agent = getPathfinderRuntimeAgent() ?? getAgents().find(ui.isPathfinderAgent);
    if (!agent || revision !== mountRevision) return null;
    const panel = await ui.openPathfinderSettings(agent);
    if (!panel) return null;
    if (revision !== mountRevision) {
        ui.closePathfinderSettings(panel);
        return null;
    }
    mountedPanel = panel;
    mountedContainer = container;
    container.replaceChildren(panel[0]);
    return panel;
}

export async function refreshPromptEditorUI() {
    if (!mountedContainer) return null;
    return initPromptEditorUI(mountedContainer);
}
