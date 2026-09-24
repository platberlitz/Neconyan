/** Place resolved Prompt Manager and extension prompts into newest-first history. */
export async function injectChatPromptDepth(prompts, messages, { maxDepth, extensionAt, describePrompt } = {}) {
    const history = [...messages];
    let inserted = 0;
    for (let depth = 0; depth <= maxDepth; depth++) {
        const selected = prompts.filter(prompt => prompt.injection_depth === depth && prompt.content);
        const orders = [...new Set([100, ...selected.map(prompt => prompt.injection_order ?? 100)])].sort((a, b) => b - a);
        const injections = [];
        for (const order of orders) {
            for (const role of ['system', 'user', 'assistant']) {
                const sameRole = selected.filter(prompt => (prompt.injection_order ?? 100) === order && prompt.role === role);
                const extension = order === 100 && extensionAt ? await extensionAt(depth, role) : null;
                const content = [sameRole.map(prompt => prompt.content).join('\n'), extension?.content]
                    .filter(Boolean).map(value => value.trim()).join('\n');
                if (!content) continue;
                const contributions = [...sameRole.flatMap(prompt => describePrompt?.(prompt) ?? []),
                    ...(extension?.contributions ?? [])];
                injections.push({ role, content, injected: true,
                    ...(contributions.length && { agentContributions: contributions }) });
            }
        }
        history.splice(depth + inserted, 0, ...injections);
        inserted += injections.length;
    }
    return history.reverse();
}
