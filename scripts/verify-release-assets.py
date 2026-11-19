#!/usr/bin/env python3
"""Verify Neconyan release files without building, tagging or publishing anything."""
import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


REPO = 'platberlitz/Neconyan'
ROOT = Path(__file__).resolve().parents[1]
CERTIFICATE = '49ed1e770b8a5269a008ed0d4763dd19a499377e35c85eec798c554178c4826c'
ABIS = {'arm64-v8a': 'arm64', 'x86_64': 'x86_64'}
CHUNK = 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def output(*command):
    return subprocess.check_output(command, cwd=ROOT, text=True)


def github(endpoint):
    return json.loads(output('gh', 'api', f'repos/{REPO}/{endpoint}'.rstrip('/')))


def asset_names(version):
    prefix = f'Neconyan-{version}'
    apks = {abi: f'{prefix}-android-{label}.apk' for abi, label in ABIS.items()}
    source, ipa = f'{prefix}-source.zip', f'{prefix}-ios-unsigned.ipa'
    android = {*apks.values(), source, 'provenance.json'}
    android.update(f'{report}-{abi}.txt' for abi in ABIS for report in ('signature', 'alignment'))
    return apks, source, ipa, {'android': ('SHA256SUMS', android), 'ios': ('SHA256SUMS-ios', {ipa, 'provenance-ios.json'})}


def exact_files(directory, expected):
    files = {file.name: file for file in directory.iterdir()}
    missing, unexpected = expected - files.keys(), files.keys() - expected
    require(not (missing or unexpected), f'{directory}: missing {sorted(missing)}, unexpected {sorted(unexpected)}')
    require(all(file.is_file() and not file.is_symlink() for file in files.values()), f'{directory}: expected regular files only')
    return files


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_manifest(path, files):
    checksums = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *]([^/\\]+)', line)
        require(match, f'{path.name}: invalid checksum line')
        digest, name = match.groups()
        require(name in files and name not in checksums, f'{path.name}: unexpected or duplicate entry {name!r}')
        checksums[name] = digest
    require(checksums.keys() == files.keys(), f'{path.name}: missing entries {sorted(files.keys() - checksums.keys())}')
    for name, digest in checksums.items():
        require(checksum(files[name]) == digest, f'{name}: checksum mismatch')


def compare_bytes(expected, actual, name):
    while True:
        block = expected.read(CHUNK)
        require(block == actual.read(CHUNK), f'{name}: file contents differ')
        if not block:
            return


def zip_entries(archive):
    entries = {entry.filename: entry for entry in archive.infolist()}
    require(len(entries) == len(archive.infolist()), f'{archive.filename}: duplicate ZIP path')
    return entries


def compare_source(source, commit, version):
    # Compare Git's exported bytes (including .gitattributes), not working tree files or ZIP compression.
    with tempfile.TemporaryDirectory(prefix='source-check-', dir=source.parent.parent) as temp:
        reference = Path(temp) / 'source.zip'
        subprocess.run(['git', 'archive', '--format=zip', f'--prefix=Neconyan-{version}/',
                        f'--output={reference}', commit], cwd=ROOT, check=True)
        with zipfile.ZipFile(reference) as expected, zipfile.ZipFile(source) as actual:
            entries, supplied = zip_entries(expected), zip_entries(actual)
            require(entries.keys() == supplied.keys(), f'{source.name}: archive paths differ from git archive')
            count = 0
            for name, entry in entries.items():
                require((entry.external_attr >> 16) == (supplied[name].external_attr >> 16), f'{name}: archive mode differs')
                if not entry.is_dir():
                    with expected.open(entry) as original, actual.open(supplied[name]) as downloaded:
                        compare_bytes(original, downloaded, name)
                    count += 1
            return count


def verify_apk_offsets(path):
    # Mirror zipalign -c -P 16 -v 4: compressed entries need no ZIP padding.
    # verify-android-release.py separately checks ELF alignment even in compressed libraries.
    with zipfile.ZipFile(path) as archive, path.open('rb') as raw:
        for entry in zip_entries(archive).values():
            if entry.is_dir() or entry.compress_type != zipfile.ZIP_STORED:
                continue
            raw.seek(entry.header_offset)
            header = raw.read(30)
            require(header[:4] == b'PK\x03\x04' and len(header) == 30, f'{entry.filename}: invalid local ZIP header')
            name_length, extra_length = struct.unpack_from('<HH', header, 26)
            offset = entry.header_offset + 30 + name_length + extra_length
            alignment = 16384 if entry.filename.endswith('.so') else 4
            require(offset % alignment == 0, f'{entry.filename}: stored APK entry is not aligned to {alignment} bytes')


def verify_signer(text, name):
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$', text, re.MULTILINE)
    require([cert.lower() for cert in certs] == [CERTIFICATE], f'{name}: expected exactly the official Android signer')


def verify_build(directory, commit, version, apksigner):
    apks, source, ipa, layouts = asset_names(version)
    files = {}
    for platform, (manifest, names) in layouts.items():
        platform_files = exact_files(directory / platform, names | {manifest})
        verify_manifest(platform_files[manifest], {name: platform_files[name] for name in names})
        files.update(platform_files)

    for abi, name in apks.items():
        apk = files[name]
        verify_signer(output(apksigner, 'verify', '--verbose', '--print-certs', str(apk)), name)
        verify_signer(files[f'signature-{abi}.txt'].read_text(), f'signature-{abi}.txt')
        require(files[f'alignment-{abi}.txt'].read_text().strip().endswith('\nVerification successful'), f'{abi}: build alignment report did not pass')
        verify_apk_offsets(apk)

    android = json.loads(output(sys.executable, '-E', str(ROOT / 'scripts/verify-android-release.py'),
                                '--commit', commit, '--version', version, *(str(files[name]) for name in apks.values())))
    require({record['abi']: record['apk'] for record in android} == apks, 'APK filenames do not match their ABIs')
    supplied = json.loads(files['provenance.json'].read_text())
    require(sorted(android, key=lambda record: record['apk']) == sorted(supplied, key=lambda record: record['apk']),
            'Android build provenance differs from the verified APKs')
    ios = json.loads(output(sys.executable, '-E', str(ROOT / 'scripts/verify-ios-build.py'), '--commit', commit, str(files[ipa])))
    require(ios['version'] == version, 'iPhone version differs from the release')
    with zipfile.ZipFile(files[ipa]) as archive:
        embedded = json.loads(archive.read('Payload/Neconyan.app/server/release-provenance.json'))
    require(embedded == json.loads(files['provenance-ios.json'].read_text()), 'iPhone build provenance differs from the verified IPA')
    count = compare_source(files[source], commit, version)
    print(f'Build verified: 12 files, 10 checksum entries, signed Android APKs, device IPA and {count:,} source entries ({commit}).', flush=True)
    return files


def check_build_run(run_id, platform, commit):
    name = {'android': 'android-release', 'ios': 'ios-build'}[platform]
    run = github(f'actions/runs/{run_id}')
    require(run['path'] == f'.github/workflows/{name}.yml' and run['event'] == 'workflow_dispatch'
            and run['conclusion'] == 'success' and run['head_sha'] == commit,
            f'{platform} run {run_id}: expected a successful {name} dispatch for {commit}')


def published_assets(tag, commit):
    require(github('')['private'] is False, 'Repository is not public')
    ref = github(f'git/ref/tags/{tag}')['object']
    require(ref['type'] == 'tag', f'{tag}: expected an annotated tag')
    tagged = github(f'git/tags/{ref["sha"]}')['object']
    require(tagged['type'] == 'commit' and tagged['sha'] == commit, f'{tag}: does not point to {commit}')
    release = github(f'releases/tags/{tag}')
    require(release['draft'] is False and release['prerelease'] is False
            and release['id'] == github('releases/latest')['id'], f'{tag}: expected the latest public release')
    return release['assets']


def compare_publication(build, downloaded, assets):
    metadata = {asset['name']: asset for asset in assets}
    require(len(metadata) == len(assets) and metadata.keys() == build.keys(), 'GitHub release asset names differ from the verified build')
    for name, path in exact_files(downloaded, set(build)).items():
        asset = metadata[name]
        require(asset['state'] == 'uploaded' and asset['size'] == path.stat().st_size, f'{name}: GitHub asset is incomplete or has a different size')
        digest = asset.get('digest') or ''
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', digest), f'{name}: GitHub SHA-256 digest missing or invalid')
        hashed = hashlib.sha256()
        with build[name].open('rb') as original, path.open('rb') as remote:
            while True:
                block = remote.read(CHUNK)
                require(block == original.read(CHUNK), f'{name}: published bytes differ from the verified build')
                if not block:
                    break
                hashed.update(block)
        require(digest == f'sha256:{hashed.hexdigest()}', f'{name}: GitHub SHA-256 digest mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for action in ('build', 'published'):
        sub = commands.add_parser(action)
        sub.add_argument('--commit', required=True, help='full release commit SHA')
        sub.add_argument('--directory', type=Path, required=True, help='new directory for build, same directory for published')
        sub.add_argument('--apksigner', default='apksigner', help='path to Android SDK apksigner, if not on PATH')
        if action == 'build':
            sub.add_argument('--android-run', type=int, required=True)
            sub.add_argument('--ios-run', type=int, required=True)
    args = parser.parse_args()
    commit = args.commit
    require(re.fullmatch(r'[0-9a-f]{40}', commit) and output('git', 'rev-parse', f'{commit}^{{commit}}').strip() == commit,
            'Use the full SHA of the release commit in this checkout')
    version = json.loads(output('git', 'show', f'{commit}:package.json'))['version']
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', version), 'Expected a numbered Neconyan release version')
    directory = args.directory.resolve()
    apksigner = str(Path(args.apksigner).resolve()) if os.path.dirname(args.apksigner) else args.apksigner
    if args.command == 'build':
        for platform, run_id in [('android', args.android_run), ('ios', args.ios_run)]:
            check_build_run(run_id, platform, commit)
        directory.mkdir()
        for platform, run_id in [('android', args.android_run), ('ios', args.ios_run)]:
            subprocess.run(['gh', 'run', 'download', str(run_id), '--repo', REPO,
                            '--name', f'{platform}-release-{commit}', '--dir', str(directory / platform)], check=True)
        verify_build(directory, commit, version, apksigner)
    else:
        tag = f'v{version}'
        assets = published_assets(tag, commit)
        build = verify_build(directory, commit, version, apksigner)
        # Use a fresh directory on every check; no cached or manually supplied public files.
        with tempfile.TemporaryDirectory(prefix='published-check-', dir=directory) as temp:
            subprocess.run(['gh', 'release', 'download', tag, '--repo', REPO, '--pattern', '*', '--dir', temp], check=True)
            compare_publication(build, Path(temp), assets)
        print(f'Publication verified: {tag} is latest and public, with all 12 downloads byte-identical and matching GitHub SHA-256 digests.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f'Release verification failed: {error}')
