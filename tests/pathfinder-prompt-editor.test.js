import { expect, jest, test } from '@jest/globals';

test('the legacy prompt-editor entry point remounts the durable editor and retains failed saves', async () => {
    const agent = { id: 'pathfinder' };
    const ui = {
        refreshPathfinderSettings: jest.fn(),
        canClosePathfinderSettings: jest.fn(async () => true),
        isPathfinderAgent: () => true,
        openPathfinderSettings: jest.fn(async () => [{ parentNode: null }]),
        closePathfinderSettings: jest.fn(),
    };
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js', () => ui);
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({ getPathfinderRuntimeAgent: () => agent }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ getAgents: () => [agent] }));
    const editor = await import('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-editor-ui.js');
    const container = () => ({ replaceChildren(node) { this.child = node; node.parentNode = this; } });
    const first = container();
    const second = container();
    const panel = await editor.initPromptEditorUI(first);
    await editor.refreshPromptEditorUI();
    expect(ui.openPathfinderSettings).toHaveBeenCalledTimes(1);
    expect(ui.refreshPathfinderSettings).toHaveBeenCalledTimes(1);
    ui.canClosePathfinderSettings.mockResolvedValueOnce(false);
    expect(await editor.initPromptEditorUI(second)).toBeNull();
    expect(first.child).toBe(panel[0]);
    expect(second.child).toBeUndefined();
    expect(await editor.initPromptEditorUI(second)).not.toBeNull();
    expect(ui.openPathfinderSettings).toHaveBeenCalledTimes(2);
    expect(second.child.parentNode).toBe(second);
});
