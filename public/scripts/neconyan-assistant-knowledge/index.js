import core from './core.js';
import appearance from './appearance.js';
import modes from './modes.js';
import memory from './memory.js';
import tools from './tools.js';
import connections from './connections.js';
import notes from './notes.js';
import scratchpad from './scratchpad.js';
import creator from './creator.js';
import sync from './sync.js';

// Knowledge revisions are independent of the assistant cards and artwork.
export const KNOWLEDGE_REVISION = 73;
export const topics = Object.freeze([...core, ...appearance, ...modes, ...memory, ...tools, ...connections, ...notes, ...scratchpad, ...creator, ...sync]
    .map(topic => Object.freeze({ ...topic, keys: Object.freeze([...topic.keys]), verification: 'source' })));
