#!/usr/bin/env python3
"""Check an unsigned device IPA independently of the Xcode build directory."""
import argparse
import hashlib
import json
import plistlib
import struct
import zipfile
from pathlib import PurePosixPath


def require(condition, message):
    if not condition:
        raise ValueError(message)


MINIMUM_OS = '17.0'
USAGE_KEYS = [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSPhotoLibraryAddUsageDescription',
    'NSLocalNetworkUsageDescription',
]
NATIVE_MAGIC = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\x7fELF'}


def ios_versions(version):
    """Mirror scripts/ios-version.js: three-part marketing version, Android-style build number."""
    parts = version.split('.')
    require(3 <= len(parts) <= 4 and all(part.isdigit() for part in parts), f'Unsupported app version {version}')
    numbers = [int(part) for part in parts] + [0] * (4 - len(parts))
    require(all(number <= 99 for number in numbers[1:]), f'App version {version} has a part above 99')
    return '.'.join(parts[:3]), str(numbers[0] * 1000000 + numbers[1] * 10000 + numbers[2] * 100 + numbers[3])


def os_version(encoded):
    return f'{encoded >> 16}.{(encoded >> 8) & 0xFF}'


def device_binary(data, name):
    require(len(data) >= 32, f'{name}: truncated binary')
    magic, cpu, _, _, count, _, _, _ = struct.unpack_from('<8I', data)
    require(magic == 0xFEEDFACF and cpu == 0x0100000C, f'{name}: expected ARM64 Mach-O')
    position = 32
    platforms = []
    minimums = []
    for _ in range(count):
        require(position + 8 <= len(data), f'{name}: truncated load commands')
        command, size = struct.unpack_from('<2I', data, position)
        require(size >= 8 and position + size <= len(data), f'{name}: invalid load command')
        if command == 0x32:
            platform, minimum = struct.unpack_from('<2I', data, position + 8)
            platforms.append(platform)
            minimums.append(os_version(minimum))
        position += size
    require(platforms == [2], f'{name}: expected iOS device platform, got {platforms}')
    return minimums[0]


def verify(ipa, commit):
    prefix = 'Payload/Neconyan.app/'
    server = prefix + 'server/'
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate archive paths')
        require(all(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts for name in names), 'Unsafe archive path')
        info = plistlib.loads(archive.read(prefix + 'Info.plist'))
        require(info['CFBundleIdentifier'] == 'io.github.platberlitz.neconyan', 'Unexpected app identifier')
        require(info['CFBundleSupportedPlatforms'] == ['iPhoneOS'], 'Not a device app')
        require(archive.read(prefix + 'payload-version.txt').decode().strip() == commit, 'Payload commit mismatch')
        provenance = json.loads(archive.read(server + 'release-provenance.json'))
        require(provenance['commit'] == commit, 'Provenance commit mismatch')
        marketing_version, build_number = ios_versions(provenance['version'])
        require(info['CFBundleShortVersionString'] == marketing_version, 'Native/server version mismatch')
        require(info['CFBundleVersion'] == build_number, 'Native/server build version mismatch')
        require(info.get('MinimumOSVersion') == MINIMUM_OS, f'Unexpected minimum iOS version: {info.get("MinimumOSVersion")}')
        require(sorted(info.get('UIDeviceFamily', [])) == [1, 2], 'The app must run on iPhone and iPad')
        require(info.get('UIBackgroundModes') == ['audio'], 'Unexpected background modes')
        require(info.get('UIRequiredDeviceCapabilities') == ['arm64'], 'Missing arm64 device requirement')
        require(info.get('NSAppTransportSecurity') == {'NSAllowsArbitraryLoads': True}, 'Unexpected App Transport Security settings')
        require(isinstance(info.get('UIApplicationSceneManifest'), dict), 'Missing scene manifest')
        for key in USAGE_KEYS:
            require(isinstance(info.get(key), str) and info[key].strip(), f'Missing privacy text: {key}')
        orientations = set(info.get('UISupportedInterfaceOrientations~ipad', []))
        require(len(orientations) == 4, 'iPad must support every orientation')
        require(info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {}).get('CFBundleIconName') == 'AppIcon', 'Missing app icon')
        minimum = tuple(int(part) for part in MINIMUM_OS.split('.'))
        for binary in ['Neconyan', 'Frameworks/NodeMobile.framework/NodeMobile']:
            built_for = device_binary(archive.read(prefix + binary), binary)
            built = tuple(int(part) for part in built_for.split('.'))
            require(built == minimum if binary == 'Neconyan' else built <= minimum, f'{binary}: built for iOS {built_for}, expected {MINIMUM_OS}')
        for name in names:
            path = PurePosixPath(name)
            require('__MACOSX' not in path.parts and not path.name.startswith('._'), f'macOS metadata in archive: {name}')
            require('_CodeSignature' not in path.parts and path.name != 'embedded.mobileprovision', f'Unexpected signing data: {name}')
        for required in ['server.js', 'server-bootstrap.mjs', 'bootstrap-config.mjs', 'bundled-extensions.json', 'src/ios-tokenizer.js', 'src/startup-note.js', 'public/index.html', 'default/config.yaml', 'NODE-LICENSE.txt', 'POLYWASM-LICENSE.txt', 'node_modules/@agnai/sentencepiece-js/dist/index.js']:
            require(server + required in names, f'Missing bundled file: {required}')
        require(isinstance(json.loads(archive.read(server + 'bundled-extensions.json')), list), 'Invalid bundled extension list')
        require(not any(name.startswith(server + 'data/') or name == server + 'config.yaml' for name in names), 'Private runtime data in payload')
        for name in names:
            if name.startswith(server) and not name.endswith('/'):
                with archive.open(name) as handle:
                    require(handle.read(4) not in NATIVE_MAGIC, f'Native binary inside the server payload: {name}')
        manifest_bytes = archive.read(server + 'dist/frontend/asset-manifest.json')
        require(hashlib.sha256(manifest_bytes).hexdigest() == provenance['frontendManifestSha256'], 'Frontend manifest mismatch')
        manifest = json.loads(manifest_bytes)
        for source, asset in manifest['assets'].items():
            content = archive.read(server + 'dist/frontend/' + asset['output'])
            require(len(content) == asset['bytes'], f'Asset size mismatch: {asset["output"]}')
            if 'hash' in asset:
                require(hashlib.sha256(content).hexdigest()[:12] == asset['hash'], f'Asset hash mismatch: {asset["output"]}')
            else:
                require(content == archive.read(server + 'public/' + source), f'Copied asset mismatch: {source}')
        print(json.dumps({'commit': commit, 'version': provenance['version'], 'platform': 'iOS ARM64 device', 'frontendAssets': len(manifest['assets']), 'signing': 'requires user sideload signing'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('ipa')
    args = parser.parse_args()
    verify(args.ipa, args.commit)
