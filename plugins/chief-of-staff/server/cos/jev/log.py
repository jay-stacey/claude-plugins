"""Jev's decision log: one JSON line per request in HOME/jev-log.jsonl, append only.

A line holds a hash of the text and its first 80 characters, never the whole
text. Outcomes (what the Chief did) are appended as their own lines. Writing
never raises into the caller.
"""
import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024
HEAD_CHARS = 80
log = logging.getLogger("cos.jev")


def head(text: str) -> str:
    """The first 80 characters, with newlines removed."""
    return " ".join(str(text or "").replace("\r", " ").replace("\n", " ").split())[:HEAD_CHARS]


def text_hash(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class DecisionLog:
    def __init__(self, path: Path, max_bytes: int = MAX_BYTES):
        self.path = Path(path)
        self.backup = self.path.with_name(self.path.stem + ".1" + self.path.suffix)
        self.max_bytes = max_bytes
        self.lock = threading.Lock()

    def append(self, entry: dict) -> bool:
        try:
            line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
        except (TypeError, ValueError):
            return False
        with self.lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    if self.path.stat().st_size > self.max_bytes:
                        os.replace(self.path, self.backup)
                except FileNotFoundError:
                    pass
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(line)
                return True
            except OSError as err:
                log.warning("Jev could not write its log: %s", type(err).__name__)
                return False

    def record(self, msg_id, text, source, quick: dict, final: dict) -> bool:
        return self.append({"at": stamp(), "id": msg_id, "textHash": text_hash(text), "textHead": head(text),
                            "source": source, "quick": quick, "final": final, "outcome": None})

    def outcome(self, msg_id, route, model) -> bool:
        return self.append({"at": stamp(), "id": msg_id, "outcome": {"route": route, "model": model}})
