"""Jev model file checks. Uses small temp files; never downloads a model."""
import hashlib
import tempfile
import unittest
from pathlib import Path

import helpers  # noqa: F401 - puts server/ on sys.path

from cos.jev import modelcheck


def entry(**changes):
    base = dict(modelcheck.MANIFEST[0])
    base.update(changes)
    return base


class Manifest(unittest.TestCase):
    def test_entries_pass(self):
        ids = [e["id"] for e in modelcheck.MANIFEST]
        self.assertEqual(ids, ["qwen3.5-0.8b", "qwen3.5-2b"])
        for e in modelcheck.MANIFEST:
            self.assertEqual(modelcheck.check_entry(e), [], e["id"])
            self.assertTrue(e["source"])
            self.assertEqual(modelcheck.download_url(e),
                             f"https://huggingface.co/{e['repo']}/resolve/{e['commit']}/{e['file']}")
        self.assertIs(modelcheck.find("qwen3.5-2b"), modelcheck.MANIFEST[1])
        self.assertIsNone(modelcheck.find("nope"))

    def test_bad_entries(self):
        cases = {
            "publisher": entry(publisher="randomuser", repo="randomuser/Qwen3.5-0.8B-GGUF"),
            "repo owner": entry(repo="someoneelse/Qwen3.5-0.8B-GGUF"),
            "license": entry(license="Llama-3.2"),
            "gguf": entry(file="model.bin"),
            "pickle": entry(file="pytorch_model.pt"),
            "commit": entry(commit="main"),
            "sha256": entry(sha256="abc123"),
            "trust_remote_code": entry(trust_remote_code=True),
            "args": entry(args=["--trust-remote-code"]),
            "safe": entry(file="../evil.gguf"),
            "missing": {k: v for k, v in entry().items() if k != "sha256"},
            "sizeBytes": entry(sizeBytes=-1),
        }
        for name, e in cases.items():
            self.assertTrue(modelcheck.check_entry(e), name)
        self.assertTrue(modelcheck.check_entry("not a dict"))
        self.assertEqual(modelcheck.check_entry(entry(file="model.safetensors")), [])


class VerifyFile(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cos-modelcheck-"))
        self.file = self.dir / "tiny.gguf"
        self.data = b"GGUF" + b"\x00" * 60
        self.file.write_bytes(self.data)

    def tearDown(self):
        self.file.unlink(missing_ok=True)
        self.dir.rmdir()

    def test_good_and_bad_hash(self):
        good = entry(file="tiny.gguf", sha256=hashlib.sha256(self.data).hexdigest(), sizeBytes=len(self.data))
        modelcheck.verify_file(self.file, good)
        with self.assertRaises(ValueError):
            modelcheck.verify_file(self.file, dict(good, sha256="0" * 64))
        with self.assertRaises(ValueError):
            modelcheck.verify_file(self.file, dict(good, sizeBytes=len(self.data) + 1))
        with self.assertRaises(ValueError):
            modelcheck.verify_file(self.dir / "missing.gguf", good)


if __name__ == "__main__":
    unittest.main()
