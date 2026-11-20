/**
 * The iPhone keys allow at most three numbers, so X.Y.Z.A hotfixes show X.Y.Z and carry
 * the hotfix in the build number. The build number matches the Android versionCode.
 * @param {string} version package.json version, X.Y.Z or X.Y.Z.A
 * @returns {{ marketingVersion: string, buildNumber: string }}
 */
export function iosVersions(version) {
    const parts = String(version).split('.');
    if (parts.length < 3 || parts.length > 4 || parts.some(part => !/^\d+$/.test(part))) {
        throw new Error(`Unsupported app version '${version}'; use X.Y.Z or X.Y.Z.A.`);
    }
    const [major, minor, patch, hotfix = 0] = parts.map(Number);
    if (minor > 99 || patch > 99 || hotfix > 99) {
        throw new Error(`App version '${version}' has a part above 99, which would collide with another build number.`);
    }
    return {
        marketingVersion: `${major}.${minor}.${patch}`,
        buildNumber: String(major * 1000000 + minor * 10000 + patch * 100 + hotfix),
    };
}
