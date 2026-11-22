/* global globalThis */
import { readFileSync } from 'node:fs';

/** The fixed instant the baseline was captured at (2023-11-14T22:13:20Z). */
export const FIXED_TIME = 1700000000000;

/**
 * Pins the clock, the time zone and Math.random so time and random macros give the same text on every run.
 * @returns {() => void} Restores the real clock and random source.
 */
export function installFixedClock() {
    const RealDate = globalThis.Date;
    const realRandom = Math.random;
    const realZone = process.env.TZ;
    class FixedDate extends RealDate {
        constructor(...args) {
            if (args.length) super(...args);
            else super(FIXED_TIME);
        }
        static now() {
            return FIXED_TIME;
        }
    }
    process.env.TZ = 'UTC';
    globalThis.Date = FixedDate;
    Math.random = () => 0.5;
    return () => {
        globalThis.Date = RealDate;
        Math.random = realRandom;
        if (realZone === undefined) delete process.env.TZ;
        else process.env.TZ = realZone;
    };
}

/**
 * Evaluates every distinct `exampleUsage` string of every registered macro, each in a fresh environment.
 * @param {{ createMacroEnvironment: Function, MacroRegistry: { getAllMacros: Function } }} host
 * @returns {Record<string, string>} Example text mapped to what the real evaluator returned.
 */
export function evaluateEveryExample({ createMacroEnvironment, MacroRegistry }) {
    createMacroEnvironment({});
    const examples = new Set();
    for (const definition of MacroRegistry.getAllMacros()) {
        for (const example of definition.exampleUsage || []) examples.add(example);
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
        const results = {};
        for (const example of examples) {
            const environment = createMacroEnvironment({});
            try {
                results[example] = environment.evaluate(example);
            } catch (error) {
                results[example] = `THROW ${error.message}`;
            }
        }
        return results;
    } finally {
        console.warn = warn;
    }
}

/**
 * Output of every `exampleUsage` captured from the origin/staging macro sources, before the scoped comment fix.
 * @returns {Record<string, string>}
 */
export function readExampleUsageBaseline() {
    return JSON.parse(readFileSync(new URL('./macro-example-usage-baseline.json', import.meta.url), 'utf8'));
}
