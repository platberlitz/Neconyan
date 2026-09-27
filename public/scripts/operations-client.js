import { getNativeOperationClient, mountLabRecovery } from './labs-client.js';

export const getOperationClient = () => getNativeOperationClient({
    basePath: '/api/operations', storagePrefix: 'neconyan-operations', label: 'Application',
});

export const mountOperationRecovery = (container, options) => mountLabRecovery(container,
    { ...options, getClient: getOperationClient, basePath: '/api/operations', label: 'application' });
