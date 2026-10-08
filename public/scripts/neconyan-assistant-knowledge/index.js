import core from './core.js';
import appearance from './appearance.js';
import modes from './modes.js';
import memory from './memory.js';
import tools from './tools.js';
import connections from './connections.js';
import notes from './notes.js';
import scratchpad from './scratchpad.js';

// Knowledge revisions are independent of the assistant cards and artwork.
export const KNOWLEDGE_REVISION = 20;
export const topics = Object.freeze([...core, ...appearance, ...modes, ...memory, ...tools, ...connections, ...notes, ...scratchpad]
    .map(topic => Object.freeze({ ...topic, verification: 'source' })));
