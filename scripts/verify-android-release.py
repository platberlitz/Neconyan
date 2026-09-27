"""Verify both APK payloads against the release commit and native page alignment."""
import argparse
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--commit', required=True)
parser.add_argument('--version', required=True)
parser.add_argument('apks', nargs=2)
args = parser.parse_args()
results = []
seen_abis = set()
payload_hashes = set()

for filename in args.apks:
    with zipfile.ZipFile(filename) as apk:
        payload = apk.read('assets/server.zip')
        payload_hash = hashlib.sha256(payload).hexdigest()
        assert apk.read('assets/server.sha256').decode().strip() == payload_hash
        payload_hashes.add(payload_hash)
        with zipfile.ZipFile(io.BytesIO(payload)) as server:
            provenance = json.loads(server.read('release-provenance.json'))
            assert provenance['commit'] == args.commit, 'Payload commit differs from release'
            assert provenance['version'] == args.version
            assert json.loads(server.read('package.json'))['version'] == args.version
            manifest = server.read('dist/frontend/asset-manifest.json')
            assert hashlib.sha256(manifest).hexdigest() == provenance['frontendManifestSha256']
            for asset in json.loads(manifest)['assets'].values():
                content = server.read('dist/frontend/' + asset['output'])
                assert len(content) == asset['bytes'], 'Frontend asset size differs from manifest'
                if 'hash' in asset:
                    assert hashlib.sha256(content).hexdigest()[:12] == asset['hash'], 'Frontend asset hash differs from manifest'
        libraries = [name for name in apk.namelist() if name.startswith('lib/') and name.endswith('.so')]
        abis = {name.split('/')[1] for name in libraries}
        assert len(abis) == 1 and abis <= {'arm64-v8a', 'x86_64'}
        assert not seen_abis.intersection(abis), 'Duplicate APK architecture'
        seen_abis.update(abis)
        assert any(name.endswith('/libnode.so') for name in libraries)
        assert any(name.endswith('/libneconyan-node.so') for name in libraries)
        for name in libraries:
            elf = apk.read(name)
            assert elf[:6] == b'\x7fELF\x02\x01', 'Expected a little-endian 64-bit native library'
            offset = struct.unpack_from('<Q', elf, 32)[0]
            entry_size, count = struct.unpack_from('<HH', elf, 54)
            loads = 0
            for index in range(count):
                kind, _, file_offset, address, _, _, _, alignment = struct.unpack_from('<IIQQQQQQ', elf, offset + index * entry_size)
                if kind == 1:
                    loads += 1
                    assert alignment >= 16384 and (address - file_offset) % 16384 == 0, name + ': incompatible 16 KiB alignment'
            assert loads > 0
        results.append({'apk': Path(filename).name, 'abi': next(iter(abis)), 'payloadSha256': payload_hash, **provenance})

assert seen_abis == {'arm64-v8a', 'x86_64'}
assert len(payload_hashes) == 1, 'The two APKs must contain the same application'
print(json.dumps(results, indent=2))
