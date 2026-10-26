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


def device_binary(data, name):
    magic, cpu, _, _, count, _, _, _ = struct.unpack_from('<8I', data)
    require(magic == 0xFEEDFACF and cpu == 0x0100000C, f'{name}: expected ARM64 Mach-O')
    position = 32
    platforms = []
    for _ in range(count):
        command, size = struct.unpack_from('<2I', data, position)
        require(size >= 8 and position + size <= len(data), f'{name}: invalid load command')
        if command == 0x32:
            platforms.append(struct.unpack_from('<I', data, position + 8)[0])
        position += size
    require(platforms == [2], f'{name}: expected iOS device platform, got {platforms}')


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
        require(info['CFBundleShortVersionString'] == provenance['version'], 'Native/server version mismatch')
        for binary in ['Neconyan', 'Frameworks/NodeMobile.framework/NodeMobile']:
            device_binary(archive.read(prefix + binary), binary)
        for required in ['server.js', 'server-bootstrap.mjs', 'src/ios-tokenizer.js', 'public/index.html', 'default/config.yaml', 'NODE-LICENSE.txt', 'POLYWASM-LICENSE.txt', 'node_modules/@agnai/sentencepiece-js/dist/index.js']:
            require(server + required in names, f'Missing bundled file: {required}')
        require(not any(name.startswith(server + 'data/') or name == server + 'config.yaml' for name in names), 'Private runtime data in payload')
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
