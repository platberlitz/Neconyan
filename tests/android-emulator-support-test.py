"""Exercise emulator recovery without an emulator or an APK."""
import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, call, patch

import android_emulator_support as support


class EmulatorSupportTests(unittest.TestCase):
    def test_ready_emulator_checks_root_once(self):
        adb = Mock(return_value='0')
        support.ensure_root(adb)
        self.assertEqual(adb.call_args_list, [call('wait-for-device'), call('root'),
                                            call('wait-for-device'), call('shell', 'id', '-u')])

    @patch.object(support.time, 'sleep')
    def test_closed_root_transport_recovers_before_permission_check(self, sleep):
        adb = Mock(side_effect=['', subprocess.CalledProcessError(1, 'adb root',
                   output='adb: unable to connect for root: closed'), '', '', '', '0'])
        support.ensure_root(adb)
        self.assertEqual(adb.call_args_list.count(call('root')), 2)
        self.assertEqual(adb.call_args_list[-1], call('shell', 'id', '-u'))
        sleep.assert_called_once_with(2)

    @patch.object(support.time, 'sleep')
    def test_transport_retries_are_bounded(self, sleep):
        for error in (subprocess.CalledProcessError(1, 'adb', output='error: device offline'),
                      subprocess.TimeoutExpired('adb', 30)):
            with self.subTest(error=type(error).__name__):
                sleep.reset_mock()
                adb = Mock(side_effect=error)
                with self.assertRaises(type(error)) as caught:
                    support.ensure_root(adb)
                self.assertIs(caught.exception, error)
                self.assertEqual(adb.call_count, 3)
                self.assertEqual(sleep.call_count, 2)

    @patch.object(support.time, 'sleep')
    def test_non_root_emulator_is_not_retried(self, sleep):
        with self.assertRaisesRegex(AssertionError, 'root-capable'):
            support.ensure_root(Mock(return_value='2000'))
        sleep.assert_not_called()

    @patch.object(support.time, 'sleep')
    def test_other_adb_errors_are_not_retried(self, sleep):
        error = subprocess.CalledProcessError(1, 'adb', output='permission denied')
        adb = Mock(side_effect=error)
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            support.ensure_root(adb)
        self.assertIs(caught.exception, error)
        self.assertEqual(adb.call_count, 1)
        sleep.assert_not_called()

    def test_one_failed_capture_does_not_discard_other_diagnostics(self):
        commands = []

        def run(command, *, stdout, stderr, timeout, check):
            commands.append(command)
            self.assertEqual(command[:3], ['adb-test', '-s', 'emulator-1234'])
            self.assertEqual(timeout, 15)
            self.assertFalse(check)
            self.assertEqual(stderr, subprocess.PIPE)
            if command[-1] == 'power':
                raise subprocess.TimeoutExpired(command, timeout)
            stdout.write(b'retained evidence')
            return subprocess.CompletedProcess(command, 1 if command[-1] == '-A' else 0,
                                               stderr=b'process capture failed')

        with tempfile.TemporaryDirectory() as directory, patch.object(support.subprocess, 'run', side_effect=run):
            target = Path(directory)
            support.capture_failure(['adb-test', '-s', 'emulator-1234'], 'test.package', True, target)
            self.assertEqual(len(commands), 7)
            self.assertEqual((target / 'android-screen.png').read_bytes(), b'retained evidence')
            self.assertEqual((target / 'android-logcat.txt').read_bytes(), b'retained evidence')
            errors = (target / 'android-diagnostic-errors.txt').read_text()
            self.assertIn('android-power.txt:', errors)
            self.assertIn('android-processes.txt: process capture failed', errors)
            self.assertIn('cd /data/user/0/test.package', commands[1][-1])
            self.assertIn('stat files/android-busy', commands[1][-1])
            self.assertNotIn('launcher.json', str(commands))

    def test_debug_diagnostics_use_the_app_identity(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(support.subprocess, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, stderr=b'')
            support.capture_failure(['adb'], 'test.package.debug', False, Path(directory))
            private_command = run.call_args_list[1].args[0][-1]
            self.assertTrue(private_command.startswith('run-as test.package.debug sh -c '))

    def test_uncaught_smoke_failure_preserves_exit_and_collects_before_exit(self):
        source = Path(__file__).with_name('android-apk-smoke.py').read_text()
        tree = ast.parse(source)
        hook = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'report_failure')
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'captured'
            program = ('import sys\nfrom types import SimpleNamespace\nfrom pathlib import Path\n'
                       'args = SimpleNamespace(adb="adb", serial="emulator-1234", release=True)\n'
                       'package = "test.package"\n'
                       f'def capture_failure(*args):\n    Path({str(marker)!r}).write_text("captured while alive")\n'
                       + ast.unparse(hook) + '\nsys.excepthook = report_failure\n'
                       'raise AssertionError("original wake failure")\n')
            result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertIn('AssertionError: original wake failure', result.stderr)
            self.assertEqual(marker.read_text(), 'captured while alive')


if __name__ == '__main__':
    unittest.main()
