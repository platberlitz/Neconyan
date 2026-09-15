const UNSUPPORTED_ZIP_UPDATE_MESSAGE = 'Neconyan ZIP updates are unavailable because this standalone project has no release repository configured.';

function normalizeVersion(value) {
    return String(value ?? '').trim().replace(/^v/i, '');
}

function createBaseReleaseStatus(currentVersion) {
    return {
        supported: false,
        checked: false,
        currentVersion: normalizeVersion(currentVersion),
        latestVersion: '',
        releaseName: '',
        releaseUrl: '',
        assetName: '',
        assetUrl: '',
        assetAvailable: false,
        canUpdate: false,
        message: UNSUPPORTED_ZIP_UPDATE_MESSAGE,
    };
}

/**
 * Reports ZIP update support for the standalone Neconyan distribution.
 * @param {string} currentVersion Installed Neconyan version
 * @returns {Promise<object>} Unsupported ZIP update status
 */
export async function getLatestZipReleaseStatus(currentVersion) {
    return createBaseReleaseStatus(currentVersion);
}

/**
 * Refuses ZIP staging because Neconyan does not publish a ZIP release source.
 * @returns {Promise<never>} Always rejects with the unsupported status message
 */
export async function stageZipReleaseUpdate() {
    throw new Error(UNSUPPORTED_ZIP_UPDATE_MESSAGE);
}
