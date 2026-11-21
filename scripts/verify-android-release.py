"""Verify both APK manifests, bundled servers and native page alignment."""
import argparse
import hashlib
import io
import json
import re
import struct
import subprocess
import zipfile
from pathlib import Path

PACKAGE = 'io.github.platberlitz.neconyan'
MACHINES = {'arm64-v8a': 183, 'x86_64': 62}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version_code(version):
    require(re.fullmatch(r'(?:0|[1-9][0-9]{0,3})(?:\.(?:0|[1-9][0-9]?)){2,3}', version),
            f'Unsupported version {version}')
    major, minor, patch, hotfix = map(int, (version + '.0').split('.')[:4])
    code = major * 1000000 + minor * 10000 + patch * 100 + hotfix
    require(1 <= code <= 2100000000, f'Unsupported version code {code}')
    return str(code)


def verify_badging(badging, version, abi):
    package = next((line for line in badging.splitlines() if line.startswith('package: ')), '')
    lines = {line.strip() for line in badging.splitlines()}
    fields = dict(re.findall(r"(\w+)='([^']*)'", package))
    require(fields.get('name') == PACKAGE, 'Wrong application ID')
    require(fields.get('versionName') == version and fields.get('versionCode') == version_code(version), 'Wrong app version')
    # Build-tools 36 calls this minSdkVersion; older aapt2 used sdkVersion.
    minimum = re.findall(r"^(?:minSdkVersion|sdkVersion):'([^']+)'$", badging, re.MULTILINE)
    target = re.findall(r"^targetSdkVersion:'([^']+)'$", badging, re.MULTILINE)
    require(minimum == ['30'], f'Expected minimum SDK 30, found {minimum}')
    require(target == ['36'], f'Expected target SDK 36, found {target}')
    require(f"native-code: '{abi}'" in lines, f'Expected APK for {abi} only')


def verify_elf(elf, name, abi):
    require(len(elf) >= 64 and elf[:6] == b'\x7fELF\x02\x01', f'{name}: expected a little-endian 64-bit library')
    require(struct.unpack_from('<H', elf, 18)[0] == MACHINES[abi], f'{name}: wrong machine type for {abi}')
    offset = struct.unpack_from('<Q', elf, 32)[0]
    entry_size, count = struct.unpack_from('<HH', elf, 54)
    require(offset >= 64 and entry_size >= 56 and offset + count * entry_size <= len(elf), f'{name}: invalid program headers')
    loads = 0
    for index in range(count):
        kind, _, file_offset, address, _, _, _, alignment = struct.unpack_from('<IIQQQQQQ', elf, offset + index * entry_size)
        if kind == 1:
            loads += 1
            require(alignment >= 16384 and (address - file_offset) % 16384 == 0, f'{name}: incompatible 16 KiB alignment')
    require(loads > 0, f'{name}: no loadable segments')


def verify_apk(filename, commit, version, aapt2):
    with zipfile.ZipFile(filename) as apk:
        payload = apk.read('assets/server.zip')
        payload_hash = hashlib.sha256(payload).hexdigest()
        require(apk.read('assets/server.sha256').decode().strip() == payload_hash, 'Server payload checksum mismatch')
        with zipfile.ZipFile(io.BytesIO(payload)) as server:
            provenance = json.loads(server.read('release-provenance.json'))
            require(provenance['commit'] == commit, 'Payload commit differs from release')
            require(provenance['version'] == version and json.loads(server.read('package.json'))['version'] == version,
                    'Payload version differs from release')
            manifest = server.read('dist/frontend/asset-manifest.json')
            require(hashlib.sha256(manifest).hexdigest() == provenance['frontendManifestSha256'], 'Frontend manifest checksum mismatch')
            assets = json.loads(manifest)['assets']
            for bundle in ('lib.js', 'notes-editor.js'):
                require('hash' in assets[bundle], f'Uncompiled frontend bundle: {bundle}')
            for source, asset in assets.items():
                content = server.read('dist/frontend/' + asset['output'])
                require(len(content) == asset['bytes'], 'Frontend asset size differs from manifest')
                if 'hash' in asset:
                    require(hashlib.sha256(content).hexdigest()[:12] == asset['hash'], 'Frontend asset hash differs from manifest')
                if source in ('lib.js', 'notes-editor.js'):
                    require(content == server.read('dist/frontend/' + source), f'Frontend bundle alias does not match: {source}')
        libraries = [name for name in apk.namelist() if name.startswith('lib/') and name.endswith('.so')]
        abis = {name.split('/')[1] for name in libraries}
        require(len(abis) == 1 and abis <= MACHINES.keys(), 'Expected one supported CPU architecture per APK')
        abi = abis.pop()
        for required in ('libnode.so', 'libneconyan-node.so'):
            require(f'lib/{abi}/{required}' in libraries, f'{required} is missing')
        for name in libraries:
            verify_elf(apk.read(name), name, abi)
        badging = subprocess.check_output([aapt2, 'dump', 'badging', filename], text=True)
        verify_badging(badging, version, abi)
        return {**provenance, 'apk': Path(filename).name, 'abi': abi, 'payloadSha256': payload_hash}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--aapt2', default='aapt2')
    parser.add_argument('apks', nargs=2)
    args = parser.parse_args()
    results = []
    try:
        for filename in args.apks:
            results.append(verify_apk(filename, args.commit, args.version, args.aapt2))
        require({result['abi'] for result in results} == MACHINES.keys(), 'Expected one APK per architecture')
        require(len({result['payloadSha256'] for result in results}) == 1, 'The two APKs must contain the same application')
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        parser.exit(1, f'APK verification failed: {error}\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
