import json
import tempfile
import unittest
from pathlib import Path

from commentator_data import LINES, MODEL_38, event_mood
from commentator_store import CommentatorStore, ConflictError


class StoreTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.store = CommentatorStore(self.root, rebuild=False)
        (self.root / "tools").mkdir()
        self.key = "boarding_en/01"
        legacy = {"text": LINES["boarding"][0][1], "voice": "Gacrux", "model": MODEL_38, "seconds": 2.0}
        self.store.receipts_path.write_text(json.dumps({self.key: legacy}), encoding="utf-8")
        clip = self.store.audio_path(self.key)
        clip.parent.mkdir(parents=True)
        self.original = b"old clip" * 128
        clip.write_bytes(self.original)

    def test_failed_build_restores_clip_receipt_and_source_together(self):
        state = self.store.state()
        item, _ = self.store.generation(self.key, state["revision"])
        state = self.store.save_line(self.key, item["voice_text"] + " Ещё.", {}, state["revision"])
        _, token = self.store.generation(self.key, state["revision"])
        source = self.store.edits_path.read_bytes()
        receipts = self.store.receipts_path.read_bytes()
        (self.root / "tools/build.py").write_text("raise SystemExit(1)", encoding="utf-8")
        self.store.rebuild = True
        with self.assertRaises(RuntimeError):
            self.store.install_audio(self.key, token, self.original + b"new", 1.5)
        self.assertEqual(self.store.audio_path(self.key).read_bytes(), self.original)
        self.assertEqual(self.store.edits_path.read_bytes(), source)
        self.assertEqual(self.store.receipts_path.read_bytes(), receipts)
        self.assertEqual(self.store.state()["revision"], state["revision"])

    def test_mood_override_invalidates_pending_take_and_can_inherit_again(self):
        state = self.store.state()
        item, token = self.store.generation(self.key, state["revision"])
        self.assertTrue(item["style"].endswith(event_mood("boarding")))
        another = CommentatorStore(self.root, rebuild=False)
        changed = another.save_line(self.key, item["voice_text"], {"mood": ""}, state["revision"])
        with self.assertRaises(ConflictError):
            self.store.install_audio(self.key, token, self.original, 1)
        current, _ = self.store.generation(self.key, changed["revision"])
        self.assertEqual(current["mood"], "")
        self.assertNotIn(event_mood("boarding"), current["style"])
        restored = self.store.save_line(self.key, item["voice_text"], {}, changed["revision"])
        line = next(line for line in restored["lines"] if line["id"] == self.key)
        self.assertEqual(line["settings"]["mood"], event_mood("boarding"))
        self.assertEqual(line["status"], "ready")

    def test_unrelated_edit_survives_generation_but_second_response_for_same_take_loses(self):
        state = self.store.state()
        _, token = self.store.generation(self.key, state["revision"])
        _, added = self.store.add_line("parade", "ru", "Парад!", {}, state["revision"])
        updated = self.store.install_audio(self.key, token, self.original + b"new", 1.5)
        with self.assertRaises(ConflictError):
            self.store.install_audio(self.key, token, self.original, 1)
        self.assertIn(added, {line["id"] for line in updated["lines"]})
        self.assertEqual(self.store.audio_path(self.key).read_bytes(), self.original + b"new")


if __name__ == "__main__":
    unittest.main()
