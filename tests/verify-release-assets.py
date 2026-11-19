import hashlib
import importlib.util
import subprocess
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('verifier', Path(__file__).resolve().parents[1] / 'scripts/verify-release-assets.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ReleaseAssetsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_pinned_manifest_sets(self):
        apks, source, ipa, layouts = verifier.asset_names('1.2.3.4')
        self.assertEqual(apks, {'arm64-v8a': 'Neconyan-1.2.3.4-android-arm64.apk', 'x86_64': 'Neconyan-1.2.3.4-android-x86_64.apk'})
        self.assertIn(source, layouts['android'][1])
        self.assertEqual(len(layouts['android'][1]), 8)
        self.assertEqual(layouts['ios'], ('SHA256SUMS-ios', {ipa, 'provenance-ios.json'}))

    def test_rejects_wrong_file_sets_and_symlinks(self):
        (self.root / 'unexpected').touch()
        with self.assertRaisesRegex(ValueError, 'missing .* unexpected'):
            verifier.exact_files(self.root, {'expected'})
        (self.root / 'expected').symlink_to(self.root / 'unexpected')
        with self.assertRaisesRegex(ValueError, 'regular files only'):
            verifier.exact_files(self.root, {'expected', 'unexpected'})

    def test_manifest_rejects_missing_duplicate_unexpected_and_changed_files(self):
        asset, manifest = self.root / 'asset', self.root / 'SHA256SUMS'
        asset.write_bytes(b'correct')
        line = f'{verifier.checksum(asset)}  asset\n'
        manifest.write_text(line)
        verifier.verify_manifest(manifest, {'asset': asset})
        for contents, error in [('', 'missing entries'), (line * 2, 'duplicate'), (line.replace('asset', '../asset'), 'invalid checksum line'),
                                (line.replace('asset', 'other'), 'unexpected'), ('0' * 64 + '  asset\n', 'checksum mismatch')]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                manifest.write_text(contents)
                verifier.verify_manifest(manifest, {'asset': asset})

    def test_signature_requires_exactly_the_official_signer(self):
        official = f'Signer #1 certificate SHA-256 digest: {verifier.CERTIFICATE}\n'
        verifier.verify_signer(official, 'apk')
        for text in ('', official.replace(verifier.CERTIFICATE, '1' * 64), official + official.replace('#1', '#2')):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'official Android signer'):
                verifier.verify_signer(text, 'apk')

    def test_apk_alignment_uses_local_headers_and_skips_compressed_entries(self):
        apk = self.root / 'apk'
        for name, offset, alignment in [('lib/arm64-v8a/libnode.so', 16384, 16384), ('resources.arsc', 48, 4)]:
            for padding in (0, 1):
                with self.subTest(name=name, padding=padding):
                    with zipfile.ZipFile(apk, 'w') as archive:
                        entry = zipfile.ZipInfo(name)
                        length = offset - 30 - len(name) - 4 + padding
                        entry.extra = b'\x01\x90' + length.to_bytes(2, 'little') + bytes(length)
                        archive.writestr(entry, b'stored')
                        archive.writestr('lib/arm64-v8a/compressed.so', b'compressed', compress_type=zipfile.ZIP_DEFLATED)
                    if padding:
                        with self.assertRaisesRegex(ValueError, f'not aligned to {alignment} bytes'):
                            verifier.verify_apk_offsets(apk)
                    else:
                        verifier.verify_apk_offsets(apk)

    def test_checks_every_git_archive_entry_using_exported_line_endings(self):
        git = ['git', '-C', str(self.root)]
        subprocess.run([*git, 'init', '-q'], check=True)
        (self.root / '.gitattributes').write_text('*.cmd text eol=crlf\n')
        (self.root / 'example.cmd').write_bytes(b'first\nsecond\n')
        subprocess.run([*git, 'add', '.'], check=True, capture_output=True)
        subprocess.run([*git, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'test'], check=True)
        commit = subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip()
        source = self.root / 'android' / 'source.zip'
        source.parent.mkdir()
        prefix = 'Neconyan-1.2.3/'
        subprocess.run([*git, 'archive', '--format=zip', f'--prefix={prefix}', f'--output={source}', commit], check=True)
        with patch.object(verifier, 'ROOT', self.root):
            self.assertEqual(verifier.compare_source(source, commit, '1.2.3'), 2)
            with zipfile.ZipFile(source) as archive:
                self.assertEqual(archive.read(prefix + 'example.cmd'), b'first\r\nsecond\r\n')
            (self.root / 'example.cmd').write_bytes(b'first\nchanged\n')
            subprocess.run([*git, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'changed'], check=True, capture_output=True)
            subprocess.run([*git, 'archive', '--format=zip', f'--prefix={prefix}', f'--output={source}', 'HEAD'], check=True)
            with self.assertRaisesRegex(ValueError, 'example.cmd: file contents differ'):
                verifier.compare_source(source, commit, '1.2.3')
            with zipfile.ZipFile(source, 'a') as archive, warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                archive.writestr(prefix + 'example.cmd', b'first\nsecond\n')
            with self.assertRaisesRegex(ValueError, 'duplicate ZIP path'):
                verifier.compare_source(source, commit, '1.2.3')

    def test_requires_successful_run_for_exact_workflow_and_commit(self):
        commit = 'a' * 40
        valid = {'path': '.github/workflows/android-release.yml', 'event': 'workflow_dispatch', 'conclusion': 'success', 'head_sha': commit}
        with patch.object(verifier, 'github', return_value=valid) as github:
            verifier.check_build_run(123, 'android', commit)
            github.assert_called_once_with('actions/runs/123')
        for change in ({'path': '.github/workflows/ios-build.yml'}, {'head_sha': 'b' * 40}, {'conclusion': 'failure'}):
            with self.subTest(change=change), patch.object(verifier, 'github', return_value={**valid, **change}):
                with self.assertRaisesRegex(ValueError, 'successful android-release dispatch'):
                    verifier.check_build_run(123, 'android', commit)

    def test_publication_requires_annotated_exact_tag_and_public_latest_release(self):
        commit = 'a' * 40
        endpoints = {
            '': {'private': False},
            'git/ref/tags/v1.2.3': {'object': {'type': 'tag', 'sha': 'b' * 40}},
            f'git/tags/{"b" * 40}': {'object': {'type': 'commit', 'sha': commit}},
            'releases/tags/v1.2.3': {'id': 1, 'draft': False, 'prerelease': False, 'assets': []},
            'releases/latest': {'id': 1},
        }
        with patch.object(verifier, 'github', side_effect=endpoints.__getitem__):
            self.assertEqual(verifier.published_assets('v1.2.3', commit), [])
            with self.assertRaisesRegex(ValueError, 'does not point to'):
                verifier.published_assets('v1.2.3', 'c' * 40)
            endpoints['releases/latest']['id'] = 2
            with self.assertRaisesRegex(ValueError, 'latest public release'):
                verifier.published_assets('v1.2.3', commit)
            endpoints['']['private'] = True
            with self.assertRaisesRegex(ValueError, 'not public'):
                verifier.published_assets('v1.2.3', commit)

    def test_published_files_must_match_each_byte_and_the_github_digest(self):
        build = self.root / 'build'
        downloaded = self.root / 'downloaded'
        build.mkdir()
        downloaded.mkdir()
        local, remote = build / 'asset', downloaded / 'asset'
        local.write_bytes(b'one')
        remote.write_bytes(b'one')
        asset = {'name': 'asset', 'state': 'uploaded', 'size': 3, 'digest': 'sha256:' + hashlib.sha256(b'one').hexdigest()}
        verifier.compare_publication({'asset': local}, downloaded, [asset])
        for changes, error in [({'digest': None}, 'digest missing'), ({'digest': 'sha256:' + '0' * 64}, 'digest mismatch'), ({'name': 'other'}, 'asset names differ')]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                verifier.compare_publication({'asset': local}, downloaded, [{**asset, **changes}])
        remote.write_bytes(b'two')
        with self.assertRaisesRegex(ValueError, 'published bytes differ'):
            verifier.compare_publication({'asset': local}, downloaded, [asset])


if __name__ == '__main__':
    unittest.main(verbosity=2)
