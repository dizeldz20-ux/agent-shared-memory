"""The shell wrappers around the TypeScript refresh and installer (refresh.sh, install-agent-integrations.sh)."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]

FAKE_NPM = """#!/bin/sh
echo "npm $*" >> "$ASM_TEST_LOG"
case "$1" in
  ci) mkdir -p node_modules ;;
  run) exit "${FAKE_BUILD_EXIT:-0}" ;;
esac
"""
FAKE_NODE = """#!/bin/sh
echo "node $*" >> "$ASM_TEST_LOG"
"""


@unittest.skipIf(os.name == "nt" or shutil.which("bash") is None, "POSIX wrappers")
class RefreshWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.asm, self.bin, self.log = root / "asm", root / "bin", root / "calls.log"
        (self.asm / "jobs" / "dist" / "refresh").mkdir(parents=True)
        (self.asm / "jobs" / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
        for name in ("refresh.sh", "install-agent-integrations.sh"):
            shutil.copy(PROJECT / name, self.asm / name)
        self.bin.mkdir()
        for name, body in (("npm", FAKE_NPM), ("node", FAKE_NODE)):
            (self.bin / name).write_text(body, encoding="utf-8")
            (self.bin / name).chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_wrapper(self, *args: str, build_exit: int = 0, script: str = "refresh.sh") -> subprocess.CompletedProcess:
        env = {**os.environ, "HOME": self.temp.name, "ASM_TEST_LOG": str(self.log), "FAKE_BUILD_EXIT": str(build_exit),
               "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}
        return subprocess.run(["bash", str(self.asm / script), *args], env=env, text=True, capture_output=True, timeout=30)

    def calls(self) -> list[str]:
        lines = self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return lines

    def test_installs_the_modules_again_only_when_the_lock_changed(self):
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertIn("npm ci --no-audit --no-fund --silent", self.calls())
        self.run_wrapper()
        self.assertNotIn("npm ci --no-audit --no-fund --silent", self.calls())
        # A pull that adds a jobs dependency: the build would fail on the old modules.
        (self.asm / "jobs" / "package-lock.json").write_text('{"lockfileVersion": 3, "new": true}\n', encoding="utf-8")
        self.run_wrapper()
        self.assertIn("npm ci --no-audit --no-fund --silent", self.calls())

    def test_brain_only_falls_back_to_the_built_refresh_when_the_build_fails(self):
        (self.asm / "jobs" / "dist" / "refresh" / "cli.js").write_text("// built earlier\n", encoding="utf-8")
        done = self.run_wrapper("--changed", "--brain-only", build_exit=2)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("node dist/refresh/cli.js --changed --brain-only", self.calls())
        self.assertIn("jobs build failed", done.stderr)

    def test_a_full_refresh_never_runs_code_that_failed_to_build(self):
        (self.asm / "jobs" / "dist" / "refresh" / "cli.js").write_text("// built earlier\n", encoding="utf-8")
        done = self.run_wrapper(build_exit=2)
        self.assertNotEqual(done.returncode, 0)
        self.assertFalse(any(call.startswith("node ") for call in self.calls()))

    def test_the_installer_wrapper_checks_the_lock_too(self):
        self.assertEqual(self.run_wrapper(script="install-agent-integrations.sh").returncode, 0)
        calls = self.calls()
        self.assertIn("npm ci --no-audit --no-fund --silent", calls)
        self.assertIn("node dist/install/cli.js", calls)


if __name__ == "__main__":
    unittest.main()
