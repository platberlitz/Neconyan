/**
 * Typed server-side tool registry. Bundled assistant tools, lorebook tools and
 * internal callers register concrete definitions here instead of running
 * browser callbacks or slash-command strings. Every invocation checks that the
 * tool exists, that the caller was granted its permission, and validates its
 * input before any effect runs. Handlers persist their own native effect and
 * receipt; the registry never writes files itself.
 */
const tools = new Map();

function invalid(message, code = 'TOOL_INVALID') {
    return Object.assign(new Error(message), { status: 400, code });
}

export function registerTool({ name, description = '', permission = 'standard', mutating = false, validate = null, run } = {}) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(name)) throw invalid('A tool needs a short lowercase name.');
    if (typeof run !== 'function') throw invalid(`Tool ${name} needs a run function.`);
    if (tools.has(name)) throw invalid(`Tool ${name} is already registered.`, 'TOOL_DUPLICATE');
    tools.set(name, Object.freeze({ name, description, permission, mutating, validate, run }));
    return tools.get(name);
}

export function getTool(name) {
    return tools.get(name) ?? null;
}

export function listTools() {
    return [...tools.values()].map(({ name, description, permission, mutating }) => ({ name, description, permission, mutating }));
}

export function unregisterTool(name) {
    return tools.delete(name);
}

/**
 * Invoke a registered tool. `permissions` lists the grants the caller holds.
 * For a mutating tool the receipt is written BEFORE the handler runs, so a
 * crash between the effect and the receipt can never look like "nothing
 * happened"; the handler then reports the actual effect. The registry itself
 * never writes files.
 */
export async function invokeTool(name, args = {}, { permissions = [], receipt = null, signal = null, target = null, owner = null } = {}) {
    const tool = tools.get(name);
    if (!tool) throw Object.assign(new Error(`No such tool: ${name}.`), { status: 404, code: 'TOOL_NOT_FOUND' });
    if (tool.permission !== 'standard' && !permissions.includes(tool.permission)) {
        throw Object.assign(new Error(`The ${name} tool needs the ${tool.permission} permission.`), { status: 403, code: 'TOOL_PERMISSION' });
    }
    if (signal?.aborted) throw Object.assign(new Error('The job was cancelled.'), { name: 'AbortError' });
    if (tool.validate) {
        const problem = tool.validate(args);
        if (problem) throw invalid(problem);
    }
    if (tool.mutating && typeof receipt === 'function') {
        await receipt({ tool: name, target, phase: 'before', effect: null });
    }
    const result = await tool.run(args, { signal, owner, target, receipt });
    if (tool.mutating && typeof receipt === 'function') {
        // If this write is lost, the 'before' receipt above still records that
        // the effect was attempted and its outcome is unknown, never that the
        // operation was undone.
        await receipt({ tool: name, target, phase: 'after', effect: result?.effect ?? null });
    }
    return result;
}
