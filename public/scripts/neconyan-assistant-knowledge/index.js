import core from './core.js';
import appearance from './appearance.js';
import modes from './modes.js';
import memory from './memory.js';
import tools from './tools.js';
import connections from './connections.js';

// Knowledge revisions are independent of the assistant cards and artwork.
export const KNOWLEDGE_REVISION = 6;
export const topics = Object.freeze([...core, ...appearance, ...modes, ...memory, ...tools, ...connections]
    .map(topic => Object.freeze({ ...topic, verification: 'source' })));
