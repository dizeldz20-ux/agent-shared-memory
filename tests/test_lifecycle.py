import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from lifecycle import append_op, fold, load_ops, op_id, validate

PROJECT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = PROJECT / "tests" / "fixtures" / "lifecycle.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def summary(state, records) -> dict:
    return {
        "states": {key: value["state"] for key, value in state.states.items()},
        "open_threads": sorted(state.open_threads(records)),
        "requested": sorted(state.requested),
    }


class LedgerFoldTests(unittest.TestCase):
    """The ledger is folded by three readers (this module, the hooks, the jobs); the
    fixture is what keeps them from drifting apart."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Path(self.temp.name) / "lifecycle.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def write_ops(self, ops: list[dict], extra: str = "") -> None:
        self.ledger.write_text(extra + "\n".join(json.dumps(op, ensure_ascii=False) for op in ops) + "\n",
                               encoding="utf-8")

    def test_python_fold_matches_fixture(self):
        self.write_ops(FIXTURE["ops"])
        state = fold(load_ops(self.ledger), FIXTURE["records"])
        self.assertEqual(summary(state, FIXTURE["records"]), FIXTURE["expected"])

    def test_load_skips_garbage_lines(self):
        self.write_ops(FIXTURE["ops"][:1], extra="not json\n{\"id\": \"lc_x\"}\n[1, 2]\n\n")
        self.assertEqual([op["id"] for op in load_ops(self.ledger)], ["lc_0000000000000001"])

    def test_missing_ledger_folds_to_nothing_but_supersedes(self):
        state = fold(load_ops(self.ledger), FIXTURE["records"])
        self.assertEqual({key: value["state"] for key, value in state.states.items()},
                         {"record:a000000000000003": "retired"})
        self.assertEqual(state.states["record:a000000000000003"]["superseded_by"], "memory:a000000000000002")

    def test_hidden_and_thread_open(self):
        self.write_ops(FIXTURE["ops"])
        state = fold(load_ops(self.ledger), FIXTURE["records"])
        self.assertTrue(state.hidden("thread", "a000000000000001#0"))
        self.assertTrue(state.hidden("record", "a000000000000004"))
        self.assertFalse(state.hidden("page", "vault:plan-a"))  # done stays visible, only marked
        self.assertTrue(state.thread_open("a000000000000001", 1))
        self.assertFalse(state.thread_open("a000000000000004", 0))  # its record is retired

    def test_append_computes_a_stable_id_and_requires_a_reason(self):
        op = {"ts": "2026-09-29T10:00:00+03:00", "op": "close_thread",
              "target": {"kind": "thread", "id": "a000000000000001#0"}, "reason": "answered",
              "actor": {"kind": "agent", "name": "test"}, "mode": "auto"}
        written = append_op(self.ledger, dict(op))
        self.assertEqual(written["id"], op_id(op))
        self.assertTrue(written["id"].startswith("lc_") and len(written["id"]) == 19)
        self.assertEqual(load_ops(self.ledger)[0]["id"], written["id"])
        with self.assertRaises(ValueError):
            append_op(self.ledger, {**op, "reason": " "})
        self.assertEqual(validate({**op, "op": "explode"}), ["op"])

    def test_js_fold_matches_fixture(self):
        done = subprocess.run(["node", str(PROJECT / "hook" / "asm-lifecycle.js"), "--fold", str(FIXTURE_PATH)],
                              text=True, capture_output=True, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), FIXTURE["expected"])

    def test_op_id_matches_the_shared_constant(self):
        # jobs/src/ledger/ledger-store.test.ts asserts the same constant: one canonical
        # form (sorted keys, no spaces, non-ASCII kept) on both sides.
        first = {key: value for key, value in FIXTURE["ops"][0].items() if key != "id"}
        self.assertEqual(op_id(first), FIXTURE["first_op_canonical_id"])


if __name__ == "__main__":
    unittest.main()
