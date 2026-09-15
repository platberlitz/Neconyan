import { EventEmitter } from 'node:events';

import { describe, expect, jest, test } from '@jest/globals';

import {
    cancelServerPluginUpdateHandoff,
    isServerPluginUpdateSupervised,
    notifyServerStartup,
    prepareServerPluginUpdateHandoff,
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from '../src/server-plugin-update-ipc.js';

class FakeProcess extends EventEmitter {
    constructor(legacy = false) {
        super();
        this.env = legacy ? {
            SILLYBUNNY_SUPERVISED: '1',
            SILLYBUNNY_SERVER_PLUGIN_UPDATE_API: '1',
        } : {
            NECONYAN_SUPERVISED: '1',
            [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
        };
        this.send = jest.fn((message, callback) => {
            callback?.();
            const prefix = legacy ? 'sillybunny' : 'neconyan';
            if (message.type === `${prefix}:server-plugin-update:prepare` || message.type === `${prefix}:server-plugin-update:cancel`) {
                setImmediate(() => this.emit('message', {
                    type: `${prefix}:server-plugin-update:response`,
                    requestId: message.requestId,
                    ok: true,
                }));
            }
        });
    }
}

describe('server plugin update IPC', () => {
    test('uses the old protocol when a new child runs under a legacy-only supervisor', async () => {
        const processObject = new FakeProcess(true);
        const options = { processObject, timeoutMs: 100 };
        await expect(prepareServerPluginUpdateHandoff({ transactionId: 'old-parent' }, options)).resolves.toMatchObject({ type: 'sillybunny:server-plugin-update:response', ok: true });
        await expect(cancelServerPluginUpdateHandoff({ transactionId: 'old-parent' }, options)).resolves.toMatchObject({ ok: true });
        expect(notifyServerStartup([], options)).toBe(true);
        expect(processObject.send.mock.calls.map(([message]) => message.type)).toEqual([
            'sillybunny:server-plugin-update:prepare', 'sillybunny:server-plugin-update:cancel', 'sillybunny:server-startup:ready',
        ]);
    });

    test('prefers canonical supervisor declarations over conflicting legacy environment values', async () => {
        const processObject = new FakeProcess();
        processObject.env.SILLYBUNNY_SUPERVISED = '0';
        processObject.env.SILLYBUNNY_SERVER_PLUGIN_UPDATE_API = '0';
        await expect(prepareServerPluginUpdateHandoff({}, { processObject })).resolves.toMatchObject({ type: SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE });
        expect(notifyServerStartup([], { processObject })).toBe(true);
        expect(processObject.send.mock.calls.at(-1)[0].type).toBe(SERVER_STARTUP_READY_MESSAGE);
        processObject.env.NECONYAN_SUPERVISED = '0';
        processObject.env.SILLYBUNNY_SUPERVISED = '1';
        expect(isServerPluginUpdateSupervised({ env: processObject.env, send: processObject.send })).toBe(false);
    });

    test('requires a supervised IPC child', () => {
        expect(isServerPluginUpdateSupervised({ env: {}, send: () => { } })).toBe(false);
        expect(isServerPluginUpdateSupervised({ env: { SILLYBUNNY_SUPERVISED: '1' }, send: null })).toBe(false);
        expect(isServerPluginUpdateSupervised({ env: { SILLYBUNNY_SUPERVISED: '1' }, send: () => { } })).toBe(false);
        expect(isServerPluginUpdateSupervised({
            env: {
                SILLYBUNNY_SUPERVISED: '1',
                [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
            },
            send: () => { },
        })).toBe(true);
    });

    test('prepares and cancels a transaction only after supervisor acknowledgement', async () => {
        const processObject = new FakeProcess();
        const payload = { transactionId: 'transaction' };

        await expect(prepareServerPluginUpdateHandoff(payload, { processObject })).resolves.toMatchObject({ ok: true });
        await expect(cancelServerPluginUpdateHandoff(payload, { processObject })).resolves.toMatchObject({ ok: true });
        expect(processObject.send.mock.calls.map(call => call[0].type)).toEqual([
            SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
            SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
        ]);
    });

    test('reports loaded plugin IDs and canonical directories after the server starts listening', () => {
        const processObject = new FakeProcess();
        const plugins = [
            { id: 'one', directoryPath: '/plugins/One' },
            { id: 'two', directoryPath: '/plugins/Two' },
        ];

        expect(notifyServerStartup(plugins, { processObject })).toBe(true);
        expect(processObject.send).toHaveBeenCalledWith({
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins,
        });
    });
});
